// The synthetic SOS canary (ARCH §18.4). Every 5 minutes, in production, a simulated phone in the
// internal canary organization sends an SOS through the public API, signed with its device key (so
// the expired-session path is exercised too). The canary then checks each link of the chain — the
// alert, the realtime event, a provider-accepted push to the internal test device when one is
// subscribed — and resolves the SOS. A failed link is a log line the operator alarm matches.
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { withTenantTransaction } from '@sentryops/db';

import { signingInput } from '../auth/device-signature.ts';
import { alertsBySos } from '../repositories/alerts.ts';
import { deviceForSignature } from '../repositories/guards.ts';
import { activeManagerUser } from '../repositories/memberships.ts';
import { acceptedDeliveryFor, hasActiveSubscriptions } from '../repositories/notifications.ts';
import { realtimeEventFor } from '../repositories/realtime.ts';
import { resolveSos } from '../services/sos.ts';
import type { DetectorDeps } from './detectors.ts';

export type CanaryConfig = {
  /** The public origin the phones use, e.g. https://<distribution>.cloudfront.net. */
  readonly baseUrl: string;
  readonly deviceId: string;
  /** The device's private key, base64 PKCS#8 DER (operator create-canary prints it once). */
  readonly privateKey: string;
};

export type CanaryResult =
  | {
      readonly ok: true;
      readonly receiptMs: number;
      readonly alertMs: number;
      readonly realtimeMs: number;
      readonly pushMs: number | null;
    }
  | {
      readonly ok: false;
      readonly step: 'SEND' | 'ALERT' | 'REALTIME' | 'PUSH' | 'RESOLVE';
      readonly detail: string;
    };

type Options = {
  readonly fetcher?: typeof fetch;
  /** Called between polls; tests run the outbox dispatcher and sender here. */
  readonly between?: () => Promise<void>;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
};

async function poll<T>(check: () => Promise<T | null>, options: Options): Promise<T | null> {
  const deadline = performance.now() + (options.timeoutMs ?? 20_000);
  for (;;) {
    const found = await check();
    if (found !== null) return found;
    if (performance.now() >= deadline) return null;
    await options.between?.();
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
  }
}

export async function runCanary(
  deps: DetectorDeps,
  config: CanaryConfig,
  options: Options = {},
): Promise<CanaryResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const body = JSON.stringify({
    clientEventId: randomUUID(),
    recordedAt: deps.clock.now().toISOString(),
    monoMs: 0,
    bootId: 'canary',
    fix: null,
  });
  const timestampMs = deps.clock.now().getTime();
  const key = createPrivateKey({
    key: Buffer.from(config.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = sign(
    'sha256',
    Buffer.from(signingInput('POST', '/api/v1/sos', timestampMs, Buffer.from(body))),
    {
      key,
      dsaEncoding: 'ieee-p1363',
    },
  );
  let sosEventId: string;
  try {
    const response = await (options.fetcher ?? fetch)(`${config.baseUrl.replace(/\/+$/, '')}/api/v1/sos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-id': config.deviceId,
        'x-device-signature': `v1.${timestampMs}.${signature.toString('base64url')}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const reply = (await response.json().catch(() => ({}))) as { status?: string; sosEventId?: string };
    if (response.status !== 200 || reply.status !== 'RECEIVED' || !reply.sosEventId) {
      return { ok: false, step: 'SEND', detail: `HTTP ${response.status}` };
    }
    sosEventId = reply.sosEventId;
  } catch (error) {
    // The network error's code (ECONNREFUSED, ENOTFOUND…) says more than "TypeError: fetch failed".
    const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
    const name = error instanceof Error ? error.name : 'error';
    return { ok: false, step: 'SEND', detail: typeof code === 'string' ? `${name}: ${code}` : name };
  }
  const receiptMs = elapsed();

  const device = await deviceForSignature(deps.db, config.deviceId);
  if (!device) return { ok: false, step: 'ALERT', detail: 'device unknown' };
  const org = device.organization_id;
  const tx = <T>(work: Parameters<typeof withTenantTransaction<T>>[2]) =>
    withTenantTransaction(deps.db, org, work);

  const alert = await poll(
    async () => (await tx((trx) => alertsBySos(trx, org, [sosEventId])))[0] ?? null,
    options,
  );
  if (!alert) return { ok: false, step: 'ALERT', detail: 'no alert' };
  const alertMs = elapsed();

  const event = await poll(
    () => tx((trx) => realtimeEventFor(trx, org, 'sos.activated', 'sosEventId', sosEventId)),
    options,
  );
  if (!event) return { ok: false, step: 'REALTIME', detail: 'no realtime event' };
  const realtimeMs = elapsed();

  let pushMs: number | null = null;
  if (await tx((trx) => hasActiveSubscriptions(trx, org))) {
    const accepted = await poll(() => tx((trx) => acceptedDeliveryFor(trx, org, alert.id)), options);
    if (!accepted) return { ok: false, step: 'PUSH', detail: 'no provider-accepted push' };
    pushMs = elapsed();
  }

  const owner = await tx((trx) => activeManagerUser(trx, org));
  if (!owner) return { ok: false, step: 'RESOLVE', detail: 'the canary organization has no administrator' };
  await tx((trx) =>
    resolveSos(trx, deps, org, sosEventId, owner, { type: 'DRILL', note: 'Synthetic canary (ARCH §18.4).' }),
  );
  return { ok: true, receiptMs, alertMs, realtimeMs, pushMs };
}
