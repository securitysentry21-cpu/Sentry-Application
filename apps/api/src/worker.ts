// The background worker (ARCH §16): shift detectors, alert detectors and the patrol-run closer every
// minute (the geofence evaluator runs with each sync batch); the outbox dispatcher every half
// second; SOS escalation every 15 seconds; the notification sender every second; the photo checker
// every few seconds. Runs as two connections — system_worker for the cross-organization sweeps,
// app_runtime for every change — and refuses any other role (D-33). Operator alarms (ARCH §18.4) are
// log lines with a fixed `msg`, matched by CloudWatch metric filters (infra/terraform).
import { createKysely, createPool, verifyRuntimeRole } from '@sentryops/db';
import { z } from 'zod';

import { loadConfig } from './config.ts';
import { createDeps } from './server.ts';
import { runCanary } from './workers/canary.ts';
import { runAlertDetectors, runPatrolCloser, runShiftDetectors } from './workers/detectors.ts';
import {
  runAttachmentProcessor,
  runEscalation,
  runSender,
  runShiftReminders,
  staleSosOrganizations,
} from './workers/notifications.ts';
import { runDispatcher, sweepStaleStreams } from './workers/outbox.ts';

const env = z.object({
  SWEEP_DATABASE_URL: z.string().min(1),
  DETECTOR_INTERVAL_S: z.coerce.number().int().min(5).default(60),
  DISPATCH_INTERVAL_MS: z.coerce.number().int().min(100).default(500),
  ESCALATION_INTERVAL_S: z.coerce.number().int().min(1).default(15),
  SENDER_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  ATTACHMENT_INTERVAL_S: z.coerce.number().int().min(1).default(5),
  /** The synthetic SOS canary (ARCH §18.4): production only, once its organization exists. */
  CANARY_ENABLED: z.enum(['true', 'false']).default('false'),
  CANARY_INTERVAL_S: z.coerce.number().int().min(60).default(300),
  CANARY_BASE_URL: z.url().optional(),
  CANARY_DEVICE_ID: z.uuid().optional(),
  CANARY_DEVICE_KEY: z.string().min(100).optional(),
});
const config = loadConfig(process.env);
const extra = env.parse(process.env);

const runtime = createPool(config.DATABASE_URL, { applicationName: 'sentryops-worker', max: 4 });
const sweepPool = createPool(extra.SWEEP_DATABASE_URL, { applicationName: 'sentryops-worker-sweep', max: 2 });
await verifyRuntimeRole(runtime, ['app_runtime']);
await verifyRuntimeRole(sweepPool, ['system_worker']);
const deps = { ...createDeps(config, runtime, { oidc: null }), sweep: createKysely(sweepPool) };

const failed = (msg: string, error: unknown) =>
  console.error(JSON.stringify({ msg, error: error instanceof Error ? error.message : 'unknown' }));

let stopping = false;
async function tick(): Promise<void> {
  try {
    const result = await runShiftDetectors(deps);
    if (result.changed > 0) console.log(JSON.stringify({ msg: 'shift detectors', ...result }));
    await runAlertDetectors(deps);
    const patrols = await runPatrolCloser(deps);
    if (patrols.closed > 0) console.log(JSON.stringify({ msg: 'patrol runs closed', ...patrols }));
    await sweepStaleStreams(deps);
    await runShiftReminders(deps);
    // ARCH §18.4: a real SOS unacknowledged for 10 minutes pages the operator (check delivery health).
    const stale = await staleSosOrganizations(deps);
    if (stale.length > 0)
      console.error(JSON.stringify({ msg: 'sos unacknowledged', organizations: stale.length }));
  } catch (error) {
    failed('shift detectors failed', error);
  }
  if (!stopping) setTimeout(() => void tick(), extra.DETECTOR_INTERVAL_S * 1000);
}

async function escalate(): Promise<void> {
  try {
    const result = await runEscalation(deps);
    if (result.escalated > 0) console.log(JSON.stringify({ msg: 'alerts escalated', ...result }));
  } catch (error) {
    failed('sos pipeline error: escalation failed', error);
  }
  if (!stopping) setTimeout(() => void escalate(), extra.ESCALATION_INTERVAL_S * 1000);
}

async function send(): Promise<void> {
  try {
    const result = await runSender(deps);
    for (const failure of result.failures) {
      // Codes only: never a number, a token or a message (SEC §15).
      console.error(
        JSON.stringify({
          msg: 'notification provider failure',
          channel: failure.channel,
          code: failure.code,
        }),
      );
    }
  } catch (error) {
    failed('sos pipeline error: sender failed', error);
  }
  if (!stopping) setTimeout(() => void send(), extra.SENDER_INTERVAL_MS);
}

async function processPhotos(): Promise<void> {
  try {
    const result = await runAttachmentProcessor(deps);
    if (result.processed > 0) console.log(JSON.stringify({ msg: 'photos checked', ...result }));
  } catch (error) {
    failed('attachment processor failed', error);
  }
  if (!stopping) setTimeout(() => void processPhotos(), extra.ATTACHMENT_INTERVAL_S * 1000);
}

async function dispatch(): Promise<void> {
  try {
    await runDispatcher(deps);
  } catch (error) {
    failed('outbox dispatcher failed', error);
  }
  if (!stopping) setTimeout(() => void dispatch(), extra.DISPATCH_INTERVAL_MS);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true;
    void Promise.all([runtime.end(), sweepPool.end()]).finally(() => process.exit(0));
  });
}
const canary =
  extra.CANARY_ENABLED === 'true' &&
  extra.CANARY_BASE_URL &&
  extra.CANARY_DEVICE_ID &&
  extra.CANARY_DEVICE_KEY
    ? {
        baseUrl: extra.CANARY_BASE_URL,
        deviceId: extra.CANARY_DEVICE_ID,
        privateKey: extra.CANARY_DEVICE_KEY,
      }
    : null;
if (extra.CANARY_ENABLED === 'true' && !canary) failed('canary misconfigured', new Error('missing settings'));

async function canaryRun(): Promise<void> {
  if (!canary) return;
  try {
    const result = await runCanary(deps, canary);
    if (result.ok) console.log(JSON.stringify({ msg: 'canary ok', ...result }));
    else console.error(JSON.stringify({ msg: 'canary failed', step: result.step, detail: result.detail }));
  } catch (error) {
    failed('canary failed', error);
  }
  if (!stopping) setTimeout(() => void canaryRun(), extra.CANARY_INTERVAL_S * 1000);
}

void tick();
void dispatch();
void canaryRun();
void escalate();
void send();
void processPhotos();
