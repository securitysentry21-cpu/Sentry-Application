// Report queries (PROD §15.1) that the other repositories don't already answer. All tenant-scoped.
import type { Database } from '@sentryops/db';

export type IncidentReportRecord = {
  readonly id: string;
  readonly referenceNumber: number;
  readonly type: string;
  readonly severity: string;
  readonly status: string;
  readonly title: string;
  readonly siteId: string | null;
  readonly siteName: string | null;
  readonly guardId: string | null;
  readonly guardName: string | null;
  readonly employeeNumber: string | null;
  readonly occurredAt: Date;
  readonly reportedAt: Date;
  readonly receivedAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly isDrill: boolean;
};

/** Incidents that occurred in [from, to), oldest first. */
export async function incidentsForReport(
  trx: Database,
  organizationId: string,
  f: {
    readonly from: Date;
    readonly to: Date;
    readonly siteId?: string | undefined;
    readonly guardId?: string | undefined;
    readonly includeDrills: boolean;
    readonly limit: number;
  },
): Promise<IncidentReportRecord[]> {
  let q = trx
    .selectFrom('incidents as i')
    .leftJoin('sites as s', (j) =>
      j.onRef('s.organization_id', '=', 'i.organization_id').onRef('s.id', '=', 'i.site_id'),
    )
    .leftJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 'i.organization_id').onRef('g.id', '=', 'i.guard_id'),
    )
    .select([
      'i.id',
      'i.reference_number',
      'i.type',
      'i.severity',
      'i.status',
      'i.title',
      'i.site_id',
      's.name as site_name',
      'i.guard_id',
      'g.display_name as guard_name',
      'g.employee_number',
      'i.occurred_at',
      'i.reported_at',
      'i.received_at',
      'i.acknowledged_at',
      'i.resolved_at',
      'i.is_drill',
    ])
    .where('i.organization_id', '=', organizationId)
    .where('i.occurred_at', '>=', f.from)
    .where('i.occurred_at', '<', f.to);
  if (f.siteId) q = q.where('i.site_id', '=', f.siteId);
  if (f.guardId) q = q.where('i.guard_id', '=', f.guardId);
  if (!f.includeDrills) q = q.where('i.is_drill', '=', false);
  const rows = await q.orderBy('i.occurred_at').orderBy('i.id').limit(f.limit).execute();
  return rows.map((r) => ({
    id: r.id,
    referenceNumber: r.reference_number,
    type: r.type,
    severity: r.severity,
    status: r.status,
    title: r.title,
    siteId: r.site_id,
    siteName: r.site_name,
    guardId: r.guard_id,
    guardName: r.guard_name,
    employeeNumber: r.employee_number,
    occurredAt: r.occurred_at,
    reportedAt: r.reported_at,
    receivedAt: r.received_at,
    acknowledgedAt: r.acknowledged_at,
    resolvedAt: r.resolved_at,
    isDrill: r.is_drill,
  }));
}

/** One shift's track in capture order (the location report; audited by its caller, INV-14). */
export async function shiftTrack(trx: Database, organizationId: string, shiftId: string, limit: number) {
  const rows = await trx
    .selectFrom('location_points')
    .select(['latitude', 'longitude', 'accuracy_m', 'captured_at', 'received_at'])
    .where('organization_id', '=', organizationId)
    .where('shift_id', '=', shiftId)
    .orderBy('captured_at')
    .orderBy('id')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    lat: r.latitude,
    lng: r.longitude,
    accuracyM: r.accuracy_m,
    capturedAt: r.captured_at,
    receivedAt: r.received_at,
  }));
}

/** A guard's points for a location-history export (INV-14: the request was audited), oldest first. */
export async function trackForExport(
  trx: Database,
  organizationId: string,
  f: {
    readonly guardId: string;
    readonly shiftId?: string | undefined;
    readonly from: Date;
    readonly to: Date;
  },
  limit: number,
) {
  let q = trx
    .selectFrom('location_points as p')
    .leftJoin('shifts as sh', (j) =>
      j.onRef('sh.organization_id', '=', 'p.organization_id').onRef('sh.id', '=', 'p.shift_id'),
    )
    .leftJoin('sites as s', (j) =>
      j.onRef('s.organization_id', '=', 'sh.organization_id').onRef('s.id', '=', 'sh.site_id'),
    )
    .select([
      'p.shift_id',
      'p.sos_event_id',
      's.name as site_name',
      'p.captured_at',
      'p.received_at',
      'p.latitude',
      'p.longitude',
      'p.accuracy_m',
      'p.speed_mps',
      'p.provider',
      'p.source',
      'p.is_mock',
      'p.flags',
    ])
    .where('p.organization_id', '=', organizationId)
    .where('p.guard_id', '=', f.guardId)
    .where('p.captured_at', '>=', f.from)
    .where('p.captured_at', '<', f.to);
  if (f.shiftId) q = q.where('p.shift_id', '=', f.shiftId);
  return q.orderBy('p.captured_at').orderBy('p.id').limit(limit).execute();
}
