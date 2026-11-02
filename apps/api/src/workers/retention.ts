// The Phase 9 jobs (ARCH §16): the export runner, which builds queued exports, deletes files after 7
// days and retries what a stopped worker left; and the retention scheduler, which starts each
// organization's daily run at 03:00 its time (SEC §16.5). Like the other jobs, the sweeps only list
// organizations (system_worker); the work runs in each organization's own transaction.
import type { Database } from '@sentryops/db';

import { organizationsWithExportWork } from '../repositories/exports.ts';
import { organizationsForRetention } from '../repositories/retention.ts';
import { EXPORT_STUCK_MS, runQueuedExports, tidyExports } from '../services/exports.ts';
import { retentionIsDue, runRetention, type RetentionCounts } from '../services/retention.ts';
import type { DetectorDeps } from './detectors.ts';

export async function runExportWork(
  deps: DetectorDeps,
): Promise<{ built: number; expired: number; retried: number }> {
  const now = deps.clock.now();
  const result = { built: 0, expired: 0, retried: 0 };
  for (const org of await organizationsWithExportWork(
    deps.sweep,
    now,
    new Date(now.getTime() - EXPORT_STUCK_MS),
  )) {
    const tidy = await tidyExports(deps, org);
    result.expired += tidy.expired;
    result.retried += tidy.retried;
    result.built += await runQueuedExports(deps, org);
  }
  return result;
}

export type RetentionWorkerDeps = DetectorDeps & {
  /** retention_worker's connection (the worker checks the role at start, D-33). */
  readonly retention: Database;
};

/** Runs every organization whose daily run is due; returns each run's counts. */
export async function runRetentionSweep(deps: RetentionWorkerDeps): Promise<Map<string, RetentionCounts>> {
  const runs = new Map<string, RetentionCounts>();
  const retention = { retention: deps.retention, objects: deps.objects, clock: deps.clock };
  for (const org of await organizationsForRetention(deps.sweep)) {
    if (!(await retentionIsDue(retention, org.id, org.timezone))) continue;
    runs.set(org.id, await runRetention(retention, org.id));
  }
  return runs;
}
