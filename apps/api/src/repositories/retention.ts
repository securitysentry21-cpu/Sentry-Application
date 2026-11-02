// Retention (SEC §16.5): one batch per call, run as retention_worker inside the organization's own
// transaction (its policies see only that organization). Children go before parents, and a record
// still referenced by something kept stays. Owner decisions 2026-11-02: operational records 12
// months after they closed, never while open; positions on records cleared after the location
// period, except evidence on incidents and SOS.
import type { Database } from '@sentryops/db';
import { sql } from 'kysely';

export const RETENTION_BATCH = 2_000;

const count = (r: { numAffectedRows?: bigint }) => Number(r.numAffectedRows ?? 0n);

/** Closed alerts (resolved or dismissed before the cut-off), with their events and deliveries. */
export async function deleteClosedAlerts(trx: Database, org: string, before: Date) {
  const { rows } = await sql<{ id: string }>`
    select id from alerts
     where organization_id = ${org} and status in ('RESOLVED', 'DISMISSED')
       and coalesce(resolved_at, dismissed_at, updated_at) < ${before}
     order by id limit ${RETENTION_BATCH}`.execute(trx);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { alerts: 0, alertEvents: 0, deliveries: 0 };
  const deliveries = await sql`
    delete from notification_deliveries where organization_id = ${org} and alert_id = any(${ids}::uuid[])`.execute(
    trx,
  );
  const events = await sql`
    delete from alert_events where organization_id = ${org} and alert_id = any(${ids}::uuid[])`.execute(trx);
  const alerts =
    await sql`delete from alerts where organization_id = ${org} and id = any(${ids}::uuid[])`.execute(trx);
  return { alerts: count(alerts), alertEvents: count(events), deliveries: count(deliveries) };
}

/** Finished messages that belong to no alert or SOS (shift notices, tests). */
export async function deleteLooseDeliveries(trx: Database, org: string, before: Date) {
  const r = await sql`
    delete from notification_deliveries where organization_id = ${org} and id in (
      select id from notification_deliveries
       where organization_id = ${org} and alert_id is null and sos_event_id is null
         and status <> 'QUEUED' and created_at < ${before}
       limit ${RETENTION_BATCH})`.execute(trx);
  return count(r);
}

/** Resolved incidents no kept alert points to; returns their photos' keys to delete. */
export async function resolvedIncidentsToDelete(trx: Database, org: string, before: Date) {
  const { rows } = await sql<{ id: string }>`
    select i.id from incidents i
     where i.organization_id = ${org} and i.status = 'RESOLVED' and i.resolved_at < ${before}
       and not exists (select 1 from alerts a where a.organization_id = i.organization_id and a.incident_id = i.id)
     order by i.id limit ${RETENTION_BATCH}`.execute(trx);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { ids, keys: [] as string[] };
  const { rows: photos } = await sql<{ original_key: string; view_key: string }>`
    select original_key, view_key from incident_attachments
     where organization_id = ${org} and incident_id = any(${ids}::uuid[])`.execute(trx);
  return { ids, keys: photos.flatMap((p) => [p.original_key, p.view_key]) };
}

export async function deleteIncidents(trx: Database, org: string, ids: readonly string[]) {
  const photos = await sql`
    delete from incident_attachments where organization_id = ${org} and incident_id = any(${ids}::uuid[])`.execute(
    trx,
  );
  const events = await sql`
    delete from incident_events where organization_id = ${org} and incident_id = any(${ids}::uuid[])`.execute(
    trx,
  );
  const incidents = await sql`
    delete from incidents where organization_id = ${org} and id = any(${ids}::uuid[])`.execute(trx);
  return { incidents: count(incidents), incidentEvents: count(events), photos: count(photos) };
}

/** Resolved SOS nothing kept points to, with their presses, messages and their own trail. */
export async function deleteResolvedSos(trx: Database, org: string, before: Date) {
  const { rows } = await sql<{ id: string }>`
    select s.id from sos_events s
     where s.organization_id = ${org} and s.status = 'RESOLVED' and s.resolved_at < ${before}
       and not exists (select 1 from alerts a where a.organization_id = s.organization_id and a.sos_event_id = s.id)
       and not exists (select 1 from incidents i where i.organization_id = s.organization_id and i.sos_event_id = s.id)
     order by s.id limit ${RETENTION_BATCH}`.execute(trx);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { sos: 0, presses: 0, trail: 0, deliveries: 0 };
  const deliveries = await sql`
    delete from notification_deliveries where organization_id = ${org} and sos_event_id = any(${ids}::uuid[])`.execute(
    trx,
  );
  const trail = await sql`
    delete from location_points where organization_id = ${org} and sos_event_id = any(${ids}::uuid[])`.execute(
    trx,
  );
  const presses = await sql`
    delete from sos_presses where organization_id = ${org} and sos_event_id = any(${ids}::uuid[])`.execute(
    trx,
  );
  const sos =
    await sql`delete from sos_events where organization_id = ${org} and id = any(${ids}::uuid[])`.execute(
      trx,
    );
  return { sos: count(sos), presses: count(presses), trail: count(trail), deliveries: count(deliveries) };
}

/**
 * Track points older than the location period, except the evidence (SEC §16.5, ADV-P04): within
 * the window of an incident on the same shift (around when it happened and when it was reported),
 * within the window of an SOS on the same shift (from its press to its resolution), and an SOS's own
 * trail. Evidence goes with its incident or SOS.
 */
export async function deleteExpiredPoints(trx: Database, org: string, before: Date, windowMinutes: number) {
  const r = await sql`
    delete from location_points where organization_id = ${org} and id in (
      select p.id from location_points p
       where p.organization_id = ${org} and p.captured_at < ${before}
         and not exists (
           select 1 from incidents i
            where i.organization_id = p.organization_id and i.shift_id = p.shift_id
              and p.captured_at between least(i.occurred_at, i.reported_at) - ${windowMinutes} * interval '1 minute'
                                    and greatest(i.occurred_at, i.reported_at) + ${windowMinutes} * interval '1 minute')
         and not exists (
           select 1 from sos_events s
            where s.organization_id = p.organization_id
              and (s.id = p.sos_event_id
                   or (s.shift_id = p.shift_id
                       and p.captured_at between s.activated_at - ${windowMinutes} * interval '1 minute'
                                             and coalesce(s.resolved_at, 'infinity'::timestamptz)
                                                 + ${windowMinutes} * interval '1 minute')))
       limit ${RETENTION_BATCH})`.execute(trx);
  return count(r);
}

/** Positions on records, cleared after the location period; the records stay (owner decision 2). */
export async function clearRecordPositions(trx: Database, org: string, before: Date) {
  const shifts = await sql`
    update shifts set start_latitude = null, start_longitude = null, end_latitude = null, end_longitude = null
     where organization_id = ${org} and coalesce(actual_ended_at, ends_at) < ${before}
       and (start_latitude is not null or end_latitude is not null)`.execute(trx);
  const live = await sql`
    update shift_live_state l set last_fix_latitude = null, last_fix_longitude = null
      from shifts s
     where l.organization_id = ${org} and s.organization_id = l.organization_id and s.id = l.id
       and coalesce(s.actual_ended_at, s.ends_at) < ${before} and l.last_fix_latitude is not null`.execute(
    trx,
  );
  const scans = await sql`
    update checkpoint_visits set latitude = null, longitude = null
     where organization_id = ${org} and scanned_at < ${before} and latitude is not null`.execute(trx);
  return { shifts: count(shifts), liveStates: count(live), scans: count(scans) };
}

/** Closed patrol rounds, with their scans; then scans that belong to no round. */
export async function deleteClosedRuns(trx: Database, org: string, before: Date) {
  const { rows } = await sql<{ id: string }>`
    select id from patrol_runs
     where organization_id = ${org} and status in ('COMPLETED', 'INCOMPLETE', 'MISSED', 'CANCELLED')
       and coalesce(closed_at, window_ends_at) < ${before}
     order by id limit ${RETENTION_BATCH}`.execute(trx);
  const ids = rows.map((r) => r.id);
  let scans = 0;
  let runs = 0;
  if (ids.length > 0) {
    scans += count(
      await sql`delete from checkpoint_visits where organization_id = ${org} and patrol_run_id = any(${ids}::uuid[])`.execute(
        trx,
      ),
    );
    runs = count(
      await sql`delete from patrol_runs where organization_id = ${org} and id = any(${ids}::uuid[])`.execute(
        trx,
      ),
    );
  }
  scans += count(
    await sql`
      delete from checkpoint_visits where organization_id = ${org} and id in (
        select id from checkpoint_visits
         where organization_id = ${org} and patrol_run_id is null and scanned_at < ${before}
         limit ${RETENTION_BATCH})`.execute(trx),
  );
  return { runs, scans };
}

/** Closed shifts nothing kept points to, with their events and live state. */
export async function deleteClosedShifts(trx: Database, org: string, before: Date) {
  const { rows } = await sql<{ id: string }>`
    select sh.id from shifts sh
     where sh.organization_id = ${org} and sh.status in ('COMPLETED', 'MISSED', 'CANCELLED')
       and coalesce(sh.actual_ended_at, sh.ends_at) < ${before}
       and not exists (select 1 from alerts a where a.organization_id = sh.organization_id and a.shift_id = sh.id)
       and not exists (select 1 from incidents i where i.organization_id = sh.organization_id and i.shift_id = sh.id)
       and not exists (select 1 from sos_events s where s.organization_id = sh.organization_id and s.shift_id = sh.id)
       and not exists (select 1 from patrol_runs r where r.organization_id = sh.organization_id and r.shift_id = sh.id)
       and not exists (
         select 1 from checkpoint_visits v where v.organization_id = sh.organization_id and v.shift_id = sh.id)
       and not exists (
         select 1 from location_points p where p.organization_id = sh.organization_id and p.shift_id = sh.id)
       and not exists (
         select 1 from device_status_events d where d.organization_id = sh.organization_id and d.shift_id = sh.id)
     order by sh.id limit ${RETENTION_BATCH}`.execute(trx);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { shifts: 0, shiftEvents: 0 };
  const events = await sql`
    delete from shift_events where organization_id = ${org} and shift_id = any(${ids}::uuid[])`.execute(trx);
  await sql`delete from shift_live_state where organization_id = ${org} and id = any(${ids}::uuid[])`.execute(
    trx,
  );
  const shifts =
    await sql`delete from shifts where organization_id = ${org} and id = any(${ids}::uuid[])`.execute(trx);
  return { shifts: count(shifts), shiftEvents: count(events) };
}

export async function deleteDeviceStatus(trx: Database, org: string, before: Date) {
  const r = await sql`
    delete from device_status_events where organization_id = ${org} and id in (
      select id from device_status_events where organization_id = ${org} and received_at < ${before}
       limit ${RETENTION_BATCH})`.execute(trx);
  return count(r);
}

/** Drills that ended before the cut-off and that no kept SOS names. */
export async function deleteEndedDrills(trx: Database, org: string, before: Date) {
  const { rows } = await sql<{ id: string }>`
    select d.id from sos_drills d
     where d.organization_id = ${org} and coalesce(d.ended_at, d.ends_at) < ${before}
       and not exists (select 1 from sos_events s where s.organization_id = d.organization_id and s.drill_id = d.id)
     order by d.id limit ${RETENTION_BATCH}`.execute(trx);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return 0;
  await sql`delete from sos_drill_guards where organization_id = ${org} and drill_id = any(${ids}::uuid[])`.execute(
    trx,
  );
  await sql`delete from sos_drill_members where organization_id = ${org} and drill_id = any(${ids}::uuid[])`.execute(
    trx,
  );
  return count(
    await sql`delete from sos_drills where organization_id = ${org} and id = any(${ids}::uuid[])`.execute(
      trx,
    ),
  );
}

/** Export records whose files are long gone. */
export async function deleteOldExports(trx: Database, org: string, before: Date) {
  const r = await sql`
    delete from export_jobs where organization_id = ${org} and status in ('EXPIRED', 'FAILED') and created_at < ${before}`.execute(
    trx,
  );
  return count(r);
}

export async function deleteQuarantined(trx: Database, org: string, before: Date) {
  const r = await sql`
    delete from quarantined_items where organization_id = ${org} and id in (
      select id from quarantined_items where organization_id = ${org} and created_at < ${before}
       limit ${RETENTION_BATCH})`.execute(trx);
  return count(r);
}

export async function deleteOldAudit(trx: Database, org: string, before: Date) {
  const r = await sql`
    delete from audit_logs where organization_id = ${org} and id in (
      select id from audit_logs where organization_id = ${org} and created_at < ${before}
       limit ${RETENTION_BATCH})`.execute(trx);
  return count(r);
}

/** When the last complete run finished (its RETENTION_RUN row), or null. */
export async function lastRetentionRun(trx: Database, org: string): Promise<Date | null> {
  const { rows } = await sql<{ at: Date | null }>`
    select max(created_at) as at from audit_logs where organization_id = ${org} and action = 'RETENTION_RUN'`.execute(
    trx,
  );
  return rows[0]?.at ?? null;
}

/** The scheduler's sweep (system_worker): every organization and its time zone. */
export async function organizationsForRetention(
  sweep: Database,
): Promise<{ id: string; timezone: string }[]> {
  return sweep.selectFrom('organizations').select(['id', 'timezone']).execute();
}
