// The background worker (ARCH §16): shift detectors and alert detectors (the geofence evaluator
// runs with each sync batch); the outbox dispatcher and escalation join it in later phases. Runs as
// two connections — system_worker for the cross-organization sweep, app_runtime for every change —
// and refuses any other role (D-33).
import { createKysely, createPool, verifyRuntimeRole } from '@sentryops/db';
import { z } from 'zod';

import { loadConfig } from './config.ts';
import { createDeps } from './server.ts';
import { runAlertDetectors, runShiftDetectors } from './workers/detectors.ts';

const env = z.object({
  SWEEP_DATABASE_URL: z.string().min(1),
  DETECTOR_INTERVAL_S: z.coerce.number().int().min(5).default(60),
});
const config = loadConfig(process.env);
const extra = env.parse(process.env);

const runtime = createPool(config.DATABASE_URL, { applicationName: 'sentryops-worker', max: 4 });
const sweepPool = createPool(extra.SWEEP_DATABASE_URL, { applicationName: 'sentryops-worker-sweep', max: 2 });
await verifyRuntimeRole(runtime, ['app_runtime']);
await verifyRuntimeRole(sweepPool, ['system_worker']);
const deps = { ...createDeps(config, runtime, { oidc: null }), sweep: createKysely(sweepPool) };

let stopping = false;
async function tick(): Promise<void> {
  try {
    const result = await runShiftDetectors(deps);
    if (result.changed > 0) console.log(JSON.stringify({ msg: 'shift detectors', ...result }));
    await runAlertDetectors(deps);
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: 'shift detectors failed',
        error: error instanceof Error ? error.message : 'unknown',
      }),
    );
  }
  if (!stopping) setTimeout(() => void tick(), extra.DETECTOR_INTERVAL_S * 1000);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true;
    void Promise.all([runtime.end(), sweepPool.end()]).finally(() => process.exit(0));
  });
}
void tick();
