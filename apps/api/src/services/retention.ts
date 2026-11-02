// The daily retention run for one organization (SEC §16.5), as retention_worker: each step in short
// batches, children before parents, the evidence kept (ADV-P04), and one RETENTION_RUN audit row
// with counts only at the end (ADV-P03). A run that stops half-way is simply due again: every step
// is safe to repeat. Owner decisions 2026-11-02 (docs/DECISIONS.md, Phase 9).
import { withTenantTransaction, type Database } from '@sentryops/db';
import { retentionCutoffs, retentionDue, type Clock, type RetentionSettings } from '@sentryops/domain';

import { recordAudit } from '../repositories/audit.ts';
import { numberSetting, organizationSettings } from '../repositories/organizations.ts';
import {
  clearRecordPositions,
  deleteClosedAlerts,
  deleteClosedRuns,
  deleteClosedShifts,
  deleteDeviceStatus,
  deleteEndedDrills,
  deleteExpiredPoints,
  deleteIncidents,
  deleteLooseDeliveries,
  deleteOldAudit,
  deleteOldExports,
  deleteQuarantined,
  deleteResolvedSos,
  lastRetentionRun,
  RETENTION_BATCH,
  resolvedIncidentsToDelete,
} from '../repositories/retention.ts';
import type { ObjectStore } from '../storage/objects.ts';

export type RetentionDeps = {
  /** Connected as retention_worker (the worker checks the role at start, D-33). */
  readonly retention: Database;
  readonly objects: ObjectStore;
  readonly clock: Clock;
};

export type RetentionCounts = Record<string, number>;

export function retentionSettingsFrom(settings: Record<string, unknown>): RetentionSettings {
  return {
    locationDays: numberSetting(settings, 'retention.location_days', 90),
    deviceStatusDays: numberSetting(settings, 'retention.device_status_days', 30),
    operationalMonths: numberSetting(settings, 'retention.operational_months', 12),
    auditMonths: numberSetting(settings, 'retention.audit_months', 24),
    evidenceWindowMinutes: numberSetting(settings, 'retention.incident_evidence_window_minutes', 30),
  };
}

/** Whether the organization's run is due now (03:00 local, once a day). */
export async function retentionIsDue(deps: RetentionDeps, organizationId: string, timezone: string) {
  const last = await withTenantTransaction(deps.retention, organizationId, (trx) =>
    lastRetentionRun(trx, organizationId),
  );
  return retentionDue(deps.clock.now(), timezone, last);
}

export async function runRetention(deps: RetentionDeps, organizationId: string): Promise<RetentionCounts> {
  const org = organizationId;
  const now = deps.clock.now();
  const tx = <T>(work: (trx: Database) => Promise<T>) => withTenantTransaction(deps.retention, org, work);
  const s = retentionSettingsFrom(await tx((trx) => organizationSettings(trx, org)));
  const cut = retentionCutoffs(now, s);
  const counts: RetentionCounts = {};
  const add = (more: Record<string, number>) => {
    for (const [k, v] of Object.entries(more)) counts[k] = (counts[k] ?? 0) + v;
  };
  /** Runs one batch at a time until a batch does nothing. */
  const drain = async (batch: (trx: Database) => Promise<Record<string, number>>, key: string) => {
    for (;;) {
      const done = await tx(batch);
      add(done);
      if ((done[key] ?? 0) < RETENTION_BATCH) return;
    }
  };

  // Operational records, 12 months after they closed (owner decision 1).
  await drain((trx) => deleteClosedAlerts(trx, org, cut.operational), 'alerts');
  await drain(
    async (trx) => ({ deliveries: await deleteLooseDeliveries(trx, org, cut.operational) }),
    'deliveries',
  );
  for (;;) {
    const doomed = await tx((trx) => resolvedIncidentsToDelete(trx, org, cut.operational));
    if (doomed.ids.length === 0) break;
    // Photos leave the store first: a row left without its file is deleted next time; a file left
    // without its row would never be found again.
    for (const key of doomed.keys) await deps.objects.delete(key);
    add(await tx((trx) => deleteIncidents(trx, org, doomed.ids)));
    if (doomed.ids.length < RETENTION_BATCH) break;
  }
  await drain((trx) => deleteResolvedSos(trx, org, cut.operational), 'sos');

  // Location: the track, then the positions on records (owner decision 2). Evidence is kept while
  // its incident or SOS is (ADV-P04); both went above if their time had come.
  await drain(
    async (trx) => ({ points: await deleteExpiredPoints(trx, org, cut.location, s.evidenceWindowMinutes) }),
    'points',
  );
  const cleared = await tx((trx) => clearRecordPositions(trx, org, cut.location));
  add({
    positionsClearedShifts: cleared.shifts,
    positionsClearedLiveStates: cleared.liveStates,
    positionsClearedScans: cleared.scans,
  });

  await drain((trx) => deleteClosedRuns(trx, org, cut.operational), 'runs');
  await drain((trx) => deleteClosedShifts(trx, org, cut.operational), 'shifts');
  await drain(
    async (trx) => ({ deviceStatus: await deleteDeviceStatus(trx, org, cut.deviceStatus) }),
    'deviceStatus',
  );
  await drain(async (trx) => ({ drills: await deleteEndedDrills(trx, org, cut.operational) }), 'drills');
  add({ exports: await tx((trx) => deleteOldExports(trx, org, cut.operational)) });
  await drain(
    async (trx) => ({ quarantined: await deleteQuarantined(trx, org, cut.quarantine) }),
    'quarantined',
  );
  await drain(async (trx) => ({ auditLogs: await deleteOldAudit(trx, org, cut.audit) }), 'auditLogs');

  // SEC §16.5: one row per run, counts only.
  await tx((trx) =>
    recordAudit(
      trx,
      deps.clock,
      org,
      { type: 'SYSTEM', userId: null, requestId: null, ip: null, userAgent: null },
      { action: 'RETENTION_RUN', resourceType: 'organization', resourceId: org, metadata: counts },
    ),
  );
  return counts;
}
