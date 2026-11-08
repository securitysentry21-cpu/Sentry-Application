// The platform operator's commands that look into, or act inside, one organization (D-19; the
// runbooks in docs/RUNBOOKS). Each one:
//   - needs a reason and writes a PLATFORM_ACCESS audit row first, in the same transaction as what
//     it reads or changes (SEC §17, INV-14), so the organization can see the access;
//   - runs as app_runtime, inside the organization's own tenant transaction, so RLS holds;
//   - returns counts, ages, IDs and codes only: no coordinates, incident text or phone numbers.
import { withTenantTransaction, type Database } from '@sentryops/db';

import type { AppDeps } from '../deps.ts';
import { recordAudit, type AuditActor } from '../repositories/audit.ts';
import {
  deliveryCounts,
  markReplayed,
  oldestQueuedDelivery,
  openSos,
  quarantinedItem,
  quarantinedRows,
  replayDevice,
  type DeliveryCount,
  type OpenSos,
  type QuarantinedRow,
} from '../repositories/operator.ts';
import { processBatch } from './sync.ts';

const OPERATOR: AuditActor = {
  type: 'PLATFORM_OPERATOR',
  userId: null,
  requestId: null,
  ip: null,
  userAgent: 'operator-cli',
};

/** A problem to tell the operator in words (no stack trace, nothing from the data). */
export class OperatorError extends Error {}

export const MAX_REASON_LENGTH = 200;

function checkReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REASON_LENGTH) {
    throw new OperatorError(`--reason is required (1 to ${MAX_REASON_LENGTH} characters)`);
  }
  return trimmed;
}

async function audited<T>(
  deps: AppDeps,
  organizationId: string,
  entry: { command: string; reason: string; metadata?: Record<string, unknown> },
  work: (trx: Database) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(deps.db, organizationId, async (trx) => {
    const found = await trx
      .selectFrom('organizations')
      .select('id')
      .where('id', '=', organizationId)
      .executeTakeFirst();
    if (!found) throw new OperatorError(`no organization ${organizationId} in this cell`);
    await recordAudit(trx, deps.clock, organizationId, OPERATOR, {
      action: 'PLATFORM_ACCESS',
      resourceType: 'organization',
      resourceId: organizationId,
      reason: entry.reason,
      metadata: { command: entry.command, ...entry.metadata },
    });
    return work(trx);
  });
}

// ── Delivery health ──────────────────────────────────────────────────────────────────────────

export type DeliveryHealth = {
  readonly organizationId: string;
  readonly now: Date;
  readonly hours: number;
  readonly counts: readonly DeliveryCount[];
  readonly oldestQueuedAt: Date | null;
  readonly openSos: readonly OpenSos[];
  readonly concerns: readonly string[];
};

const MINUTE = 60_000;
/** Job lag target (ARCH §18.3): a delivery should leave the queue within seconds. */
const QUEUE_LAG_CONCERN_MS = 2 * MINUTE;
/** ARCH §18.4: an SOS unacknowledged this long means check delivery health. */
const SOS_UNACKNOWLEDGED_CONCERN_MS = 10 * MINUTE;
/** ARCH §18.4: provider failure rate. */
const FAILURE_RATE_CONCERN = 0.05;
const MIN_ATTEMPTS_FOR_RATE = 10;

export function assessDeliveryHealth(
  input: Pick<DeliveryHealth, 'now' | 'counts' | 'oldestQueuedAt' | 'openSos'>,
): string[] {
  const concerns: string[] = [];
  const { now } = input;
  if (input.oldestQueuedAt) {
    const waited = now.getTime() - input.oldestQueuedAt.getTime();
    if (waited > QUEUE_LAG_CONCERN_MS) {
      concerns.push(
        `a delivery has waited ${Math.round(waited / MINUTE)} min in the queue: the worker is not sending (runbook: SOS notifications failing)`,
      );
    }
  }
  const byChannel = new Map<string, { sent: number; failed: number }>();
  for (const c of input.counts) {
    if (c.isDrill) continue;
    const entry = byChannel.get(c.channel) ?? { sent: 0, failed: 0 };
    if (c.status === 'SENT' || c.status === 'DELIVERED') entry.sent += c.count;
    if (c.status === 'FAILED') entry.failed += c.count;
    byChannel.set(c.channel, entry);
  }
  for (const [channel, { sent, failed }] of byChannel) {
    const attempted = sent + failed;
    if (attempted >= MIN_ATTEMPTS_FOR_RATE && failed / attempted > FAILURE_RATE_CONCERN) {
      concerns.push(
        `${channel}: ${failed} of ${attempted} sends failed (${Math.round((failed / attempted) * 100)} %), above ${FAILURE_RATE_CONCERN * 100} % (runbook: notification provider outage)`,
      );
    }
  }
  for (const sos of input.openSos) {
    if (sos.isDrill) continue;
    const waited = now.getTime() - sos.activatedAt.getTime();
    if (sos.status === 'ACTIVE' && waited > SOS_UNACKNOWLEDGED_CONCERN_MS) {
      concerns.push(
        `an SOS has been open ${Math.round(waited / MINUTE)} min without acknowledgement (alert sent: ${sos.alertSent ? 'yes' : 'NO'}, shown to a person: ${sos.notified ? 'yes' : 'NO'})`,
      );
    } else if (sos.status === 'ACTIVE' && !sos.alertSent && waited > MINUTE) {
      concerns.push(
        `an SOS has been open ${Math.round(waited / MINUTE)} min and no provider has accepted a message`,
      );
    }
  }
  return concerns;
}

export async function deliveryHealth(
  deps: AppDeps,
  organizationId: string,
  options: { hours: number; reason: string },
): Promise<DeliveryHealth> {
  const reason = checkReason(options.reason);
  if (!Number.isFinite(options.hours) || options.hours <= 0 || options.hours > 24 * 31) {
    throw new OperatorError('--hours must be between 1 and 744');
  }
  const now = deps.clock.now();
  const since = new Date(now.getTime() - options.hours * 60 * MINUTE);
  const read = await audited(
    deps,
    organizationId,
    { command: 'delivery-health', reason, metadata: { hours: options.hours } },
    async (trx) => ({
      counts: await deliveryCounts(trx, organizationId, since),
      oldestQueuedAt: await oldestQueuedDelivery(trx, organizationId),
      openSos: await openSos(trx, organizationId),
    }),
  );
  return {
    organizationId,
    now,
    hours: options.hours,
    ...read,
    concerns: assessDeliveryHealth({ now, ...read }),
  };
}

export function formatDeliveryHealth(health: DeliveryHealth): string[] {
  const lines = [
    `Organization ${health.organizationId} · deliveries created in the last ${health.hours} h · now ${health.now.toISOString()}`,
    '',
  ];
  if (health.counts.length === 0) lines.push('No deliveries in this period.');
  for (const c of health.counts) {
    const detail = c.errorCode ? ` [${c.errorCode}]` : '';
    lines.push(
      `  ${c.channel.padEnd(8)} ${c.status.padEnd(10)} ${String(c.count).padStart(6)}${detail}${c.isDrill ? ' (drills)' : ''}`,
    );
  }
  lines.push(
    '',
    health.oldestQueuedAt
      ? `Oldest delivery still queued: ${Math.round((health.now.getTime() - health.oldestQueuedAt.getTime()) / 1000)} s ago`
      : 'Nothing is waiting in the queue.',
  );
  const open = health.openSos.filter((s) => !s.isDrill);
  lines.push(`Open SOS (not drills): ${open.length}`);
  for (const sos of open) {
    lines.push(
      `  ${sos.status} for ${Math.round((health.now.getTime() - sos.activatedAt.getTime()) / MINUTE)} min · alert sent: ${sos.alertSent ? 'yes' : 'no'} · shown to a person: ${sos.notified ? 'yes' : 'no'}`,
    );
  }
  lines.push('');
  if (health.concerns.length === 0) lines.push('No concerns found.');
  else for (const concern of health.concerns) lines.push(`CONCERN: ${concern}`);
  return lines;
}

// ── Quarantined sync items ───────────────────────────────────────────────────────────────────

export async function listQuarantine(
  deps: AppDeps,
  organizationId: string,
  options: { reason: string; includeReplayed: boolean; limit: number },
): Promise<QuarantinedRow[]> {
  const reason = checkReason(options.reason);
  return audited(deps, organizationId, { command: 'quarantine-list', reason }, (trx) =>
    quarantinedRows(trx, organizationId, { onlyOpen: !options.includeReplayed, limit: options.limit }),
  );
}

export type ReplayOutcome = {
  readonly id: string;
  readonly itemType: string | null;
  readonly result: 'REPLAYED' | 'STILL_FAILING' | 'WAITING' | 'SKIPPED';
  /** The sync result (ACCEPTED, DUPLICATE, REJECTED …) or why it was skipped. Codes only. */
  readonly detail: string;
};

/**
 * Runs open quarantined items through the same pipeline as a phone's upload, oldest first (so a
 * shift's start goes before its end), as the device that sent them. Safe to repeat: ingest is
 * idempotent per device and client event ID (INV-06). An item from a phone revoked as LOST,
 * COMPROMISED or by an administrator is not replayed: its data was accepted only while it was trusted.
 * A phone REPLACED by a new one is replayed under the same rule as its 72 hours (ADV-A08): only
 * data captured before the replacement.
 */
export async function replayQuarantine(
  deps: AppDeps,
  organizationId: string,
  options: { reason: string; id?: string; limit: number },
): Promise<ReplayOutcome[]> {
  const reason = checkReason(options.reason);
  const rows = await audited(
    deps,
    organizationId,
    {
      command: 'quarantine-replay',
      reason,
      metadata: options.id ? { itemId: options.id } : { limit: options.limit },
    },
    (trx) =>
      quarantinedRows(trx, organizationId, {
        onlyOpen: true,
        ...(options.id ? { id: options.id } : {}),
        limit: options.limit,
      }),
  );
  if (options.id && rows.length === 0) {
    throw new OperatorError(`no open quarantined item ${options.id} in this organization`);
  }
  const outcomes: ReplayOutcome[] = [];
  for (const row of rows) {
    outcomes.push(await replayOne(deps, organizationId, row));
  }
  return outcomes;
}

async function replayOne(deps: AppDeps, organizationId: string, row: QuarantinedRow): Promise<ReplayOutcome> {
  const base = { id: row.id, itemType: row.itemType };
  const prepared = await withTenantTransaction(deps.db, organizationId, async (trx) => ({
    device: await replayDevice(trx, organizationId, row.deviceId),
    item: await quarantinedItem(trx, organizationId, row.id),
  }));
  const { device, item } = prepared;
  if (!device) return { ...base, result: 'SKIPPED', detail: 'the phone no longer exists' };
  if (device.status === 'REVOKED' && device.revokedReason !== 'REPLACED') {
    return {
      ...base,
      result: 'SKIPPED',
      detail: `the phone was revoked (${device.revokedReason ?? 'unknown'})`,
    };
  }
  const response = await processBatch(
    deps,
    {
      organizationId,
      guardId: device.guardId,
      deviceId: device.deviceId,
      userId: device.userId,
      appVersion: null,
      replacedAt: device.status === 'REVOKED' ? device.revokedAt : null,
    },
    {
      batchId: row.batchId,
      // The original upload's time is gone; the quarantine time is when the server first had the item.
      sentAt: row.createdAt.toISOString(),
      sentMonoMs: 0,
      // Not the phone's boot: the capture time then rests on the phone's own clock, as evidence only (INV-07).
      bootId: 'operator-replay',
      items: [typeof item === 'string' ? (JSON.parse(item) as unknown) : item],
    },
  );
  const status = response.results[0]?.status ?? 'REJECTED';
  const code = response.results[0]?.code;
  const detail = code ? `${status} ${code}` : status;
  if (status === 'RETRY') {
    // Its shift's start is still in quarantine: the start has to go first.
    return { ...base, result: 'WAITING', detail: 'waits for its shift start to be replayed' };
  }
  await withTenantTransaction(deps.db, organizationId, (trx) =>
    markReplayed(trx, organizationId, row.id, deps.clock.now()),
  );
  // QUARANTINED again means processBatch kept it as a new row: this one is closed, that one is open.
  return { ...base, result: status === 'QUARANTINED' ? 'STILL_FAILING' : 'REPLAYED', detail };
}

export function formatQuarantine(rows: readonly QuarantinedRow[], now: Date): string[] {
  if (rows.length === 0) return ['No quarantined items.'];
  return rows.map(
    (r) =>
      `${r.id}  ${(r.itemType ?? '?').padEnd(16)} ${r.errorCode.padEnd(16)} ${Math.round((now.getTime() - r.createdAt.getTime()) / MINUTE)} min ago  device ${r.deviceId}${r.replayedAt ? '  (replayed)' : ''}`,
  );
}
