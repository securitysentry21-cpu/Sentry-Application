// The background worker (ARCH §16): shift detectors, alert detectors and the patrol-run closer every
// minute (the geofence evaluator runs with each sync batch), and the outbox dispatcher every half
// second; escalation joins it in a later phase. Runs as two connections — system_worker for the cross-organization
// sweeps, app_runtime for every change — and refuses any other role (D-33).
import { createKysely, createPool, verifyRuntimeRole } from '@sentryops/db';
import { z } from 'zod';

import { loadConfig } from './config.ts';
import { createDeps } from './server.ts';
import { runAlertDetectors, runPatrolCloser, runShiftDetectors } from './workers/detectors.ts';
import { runDispatcher, sweepStaleStreams } from './workers/outbox.ts';

const env = z.object({
  SWEEP_DATABASE_URL: z.string().min(1),
  DETECTOR_INTERVAL_S: z.coerce.number().int().min(5).default(60),
  DISPATCH_INTERVAL_MS: z.coerce.number().int().min(100).default(500),
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
  } catch (error) {
    failed('shift detectors failed', error);
  }
  if (!stopping) setTimeout(() => void tick(), extra.DETECTOR_INTERVAL_S * 1000);
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
void tick();
void dispatch();
