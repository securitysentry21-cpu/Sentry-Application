// Alerts and their append-only history (ARCH §6.3, §13.2).
import type { Database } from '@sentryops/db';
import type { AlertType } from '@sentryops/domain';

export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';
export type ResolutionType = 'MANUAL' | 'CONDITION_CLEARED' | 'SHIFT_ENDED' | 'SUPERSEDED';

export type AlertRow = {
  id: string;
  type: AlertType;
  severity: string;
  status: AlertStatus;
  dedupeKey: string;
  summary: string;
  guardId: string | null;
  guardName: string | null;
  siteId: string | null;
  siteName: string | null;
  shiftId: string | null;
  details: Record<string, unknown>;
  openedAt: Date;
  lastTriggeredAt: Date;
  triggerCount: number;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: Date | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionType: ResolutionType | null;
  resolutionNote: string | null;
  dismissedBy: string | null;
  dismissedAt: Date | null;
  dismissReason: string | null;
  detectedLate: boolean;
  version: number;
};

function base(trx: Database, organizationId: string) {
  return trx
    .selectFrom('alerts as a')
    .leftJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 'a.organization_id').onRef('g.id', '=', 'a.guard_id'),
    )
    .leftJoin('sites as s', (j) =>
      j.onRef('s.organization_id', '=', 'a.organization_id').onRef('s.id', '=', 'a.site_id'),
    )
    .leftJoin('users as u', 'u.id', 'a.acknowledged_by')
    .where('a.organization_id', '=', organizationId)
    .select([
      'a.id',
      'a.type',
      'a.severity',
      'a.status',
      'a.dedupe_key',
      'a.summary',
      'a.guard_id',
      'g.display_name as guard_name',
      'a.site_id',
      's.name as site_name',
      'a.shift_id',
      'a.details',
      'a.opened_at',
      'a.last_triggered_at',
      'a.trigger_count',
      'a.acknowledged_by',
      'u.name as acknowledged_by_name',
      'a.acknowledged_at',
      'a.resolved_by',
      'a.resolved_at',
      'a.resolution_type',
      'a.resolution_note',
      'a.dismissed_by',
      'a.dismissed_at',
      'a.dismiss_reason',
      'a.detected_late',
      'a.version',
    ]);
}

type Raw = Awaited<ReturnType<ReturnType<typeof base>['executeTakeFirstOrThrow']>>;

function toRow(r: Raw): AlertRow {
  return {
    id: r.id,
    type: r.type as AlertType,
    severity: r.severity,
    status: r.status as AlertStatus,
    dedupeKey: r.dedupe_key,
    summary: r.summary,
    guardId: r.guard_id,
    guardName: r.guard_name,
    siteId: r.site_id,
    siteName: r.site_name,
    shiftId: r.shift_id,
    details: (r.details ?? {}) as Record<string, unknown>,
    openedAt: r.opened_at,
    lastTriggeredAt: r.last_triggered_at,
    triggerCount: r.trigger_count,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedByName: r.acknowledged_by_name,
    acknowledgedAt: r.acknowledged_at,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    resolutionType: r.resolution_type as ResolutionType | null,
    resolutionNote: r.resolution_note,
    dismissedBy: r.dismissed_by,
    dismissedAt: r.dismissed_at,
    dismissReason: r.dismiss_reason,
    detectedLate: r.detected_late,
    version: r.version,
  };
}

export async function getAlert(trx: Database, organizationId: string, id: string, forUpdate = false) {
  let q = base(trx, organizationId).where('a.id', '=', id);
  if (forUpdate) q = q.forUpdate('a');
  const row = await q.executeTakeFirst();
  return row ? toRow(row) : null;
}

/** The open (or acknowledged) alert for a dedupe key, locked. */
export async function openAlertByKey(trx: Database, organizationId: string, dedupeKey: string) {
  const row = await base(trx, organizationId)
    .where('a.dedupe_key', '=', dedupeKey)
    .where('a.status', 'in', ['OPEN', 'ACKNOWLEDGED'])
    .forUpdate('a')
    .executeTakeFirst();
  return row ? toRow(row) : null;
}

/** The most recently closed alert for a dedupe key. */
export async function lastClosedByKey(trx: Database, organizationId: string, dedupeKey: string) {
  const row = await base(trx, organizationId)
    .where('a.dedupe_key', '=', dedupeKey)
    .where('a.status', 'in', ['RESOLVED', 'DISMISSED'])
    .orderBy('a.updated_at', 'desc')
    .orderBy('a.id', 'desc')
    .forUpdate('a')
    .executeTakeFirst();
  return row ? toRow(row) : null;
}

export type ListFilter = { status: 'active' | 'closed' | 'all'; shiftId?: string | undefined; limit: number };

export async function listAlerts(trx: Database, organizationId: string, f: ListFilter) {
  let q = base(trx, organizationId);
  if (f.status === 'active') q = q.where('a.status', 'in', ['OPEN', 'ACKNOWLEDGED']);
  if (f.status === 'closed') q = q.where('a.status', 'in', ['RESOLVED', 'DISMISSED']);
  if (f.shiftId) q = q.where('a.shift_id', '=', f.shiftId);
  const rows = await q.orderBy('a.opened_at', 'desc').orderBy('a.id', 'desc').limit(f.limit).execute();
  return rows.map(toRow);
}

export async function openShiftScopedAlerts(
  trx: Database,
  organizationId: string,
  shiftId: string,
  types: readonly AlertType[],
) {
  const rows = await base(trx, organizationId)
    .where('a.shift_id', '=', shiftId)
    .where('a.status', 'in', ['OPEN', 'ACKNOWLEDGED'])
    .where('a.type', 'in', [...types])
    .forUpdate('a')
    .execute();
  return rows.map(toRow);
}

/** Open alerts tied to shifts that are no longer in the given statuses (the shift-end safety net). */
export async function openAlertsOnShiftsNotIn(
  trx: Database,
  organizationId: string,
  types: readonly AlertType[],
  statuses: readonly string[],
) {
  const rows = await trx
    .selectFrom('alerts as a')
    .innerJoin('shifts as sh', (j) =>
      j.onRef('sh.organization_id', '=', 'a.organization_id').onRef('sh.id', '=', 'a.shift_id'),
    )
    .where('a.organization_id', '=', organizationId)
    .where('a.status', 'in', ['OPEN', 'ACKNOWLEDGED'])
    .where('a.type', 'in', [...types])
    .where('sh.status', 'not in', [...statuses])
    .select(['a.id', 'a.dedupe_key', 'a.type', 'sh.status as shift_status'])
    .execute();
  return rows;
}

export async function insertAlert(
  trx: Database,
  a: {
    id: string;
    organizationId: string;
    type: AlertType;
    severity: string;
    dedupeKey: string;
    summary: string;
    guardId: string | null;
    siteId: string | null;
    shiftId: string | null;
    details: Record<string, unknown>;
    at: Date;
    detectedLate: boolean;
  },
): Promise<boolean> {
  const row = await trx
    .insertInto('alerts')
    .values({
      id: a.id,
      organization_id: a.organizationId,
      type: a.type,
      severity: a.severity,
      status: 'OPEN',
      dedupe_key: a.dedupeKey,
      summary: a.summary,
      guard_id: a.guardId,
      site_id: a.siteId,
      shift_id: a.shiftId,
      details: JSON.stringify(a.details),
      opened_at: a.at,
      last_triggered_at: a.at,
      detected_late: a.detectedLate,
      created_at: a.at,
      updated_at: a.at,
    })
    // A concurrent opener won: the caller counts a repeat on that one instead.
    .onConflict((oc) =>
      oc
        .columns(['organization_id', 'dedupe_key'])
        .where('status', 'in', ['OPEN', 'ACKNOWLEDGED'])
        .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export async function updateAlert(
  trx: Database,
  organizationId: string,
  id: string,
  changes: {
    status?: AlertStatus;
    lastTriggeredAt?: Date;
    incrementTrigger?: boolean;
    acknowledgedBy?: string | null;
    acknowledgedAt?: Date | null;
    resolvedBy?: string | null;
    resolvedAt?: Date | null;
    resolutionType?: ResolutionType | null;
    resolutionNote?: string | null;
    dismissedBy?: string | null;
    dismissedAt?: Date | null;
    dismissReason?: string | null;
    details?: Record<string, unknown>;
  },
  now: Date,
): Promise<void> {
  await trx
    .updateTable('alerts')
    .set((eb) => ({
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.lastTriggeredAt !== undefined ? { last_triggered_at: changes.lastTriggeredAt } : {}),
      ...(changes.incrementTrigger ? { trigger_count: eb('trigger_count', '+', 1) } : {}),
      ...(changes.acknowledgedBy !== undefined ? { acknowledged_by: changes.acknowledgedBy } : {}),
      ...(changes.acknowledgedAt !== undefined ? { acknowledged_at: changes.acknowledgedAt } : {}),
      ...(changes.resolvedBy !== undefined ? { resolved_by: changes.resolvedBy } : {}),
      ...(changes.resolvedAt !== undefined ? { resolved_at: changes.resolvedAt } : {}),
      ...(changes.resolutionType !== undefined ? { resolution_type: changes.resolutionType } : {}),
      ...(changes.resolutionNote !== undefined ? { resolution_note: changes.resolutionNote } : {}),
      ...(changes.dismissedBy !== undefined ? { dismissed_by: changes.dismissedBy } : {}),
      ...(changes.dismissedAt !== undefined ? { dismissed_at: changes.dismissedAt } : {}),
      ...(changes.dismissReason !== undefined ? { dismiss_reason: changes.dismissReason } : {}),
      ...(changes.details !== undefined ? { details: JSON.stringify(changes.details) } : {}),
      version: eb('version', '+', 1),
      updated_at: now,
    }))
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

export type AlertEventType =
  | 'OPENED'
  | 'RETRIGGERED'
  | 'REOPENED'
  | 'ACKNOWLEDGED'
  | 'RESOLVED'
  | 'AUTO_RESOLVED'
  | 'DISMISSED'
  | 'NOTE';

export async function insertAlertEvent(
  trx: Database,
  e: {
    id: string;
    organizationId: string;
    alertId: string;
    type: AlertEventType;
    actorUserId: string | null;
    note?: string | null;
    payload?: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  await trx
    .insertInto('alert_events')
    .values({
      id: e.id,
      organization_id: e.organizationId,
      alert_id: e.alertId,
      type: e.type,
      actor_type: e.actorUserId ? 'USER' : 'SYSTEM',
      actor_user_id: e.actorUserId,
      note: e.note ?? null,
      payload: JSON.stringify(e.payload ?? {}),
      created_at: e.at,
    })
    .execute();
}

export async function alertEvents(trx: Database, organizationId: string, alertId: string) {
  return trx
    .selectFrom('alert_events')
    .where('organization_id', '=', organizationId)
    .where('alert_id', '=', alertId)
    .select(['id', 'type', 'actor_type', 'actor_user_id', 'note', 'payload', 'created_at'])
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** Counts of active alerts by severity, for the dashboard header. */
export async function activeAlertCounts(trx: Database, organizationId: string) {
  const rows = await trx
    .selectFrom('alerts')
    .where('organization_id', '=', organizationId)
    .where('status', 'in', ['OPEN', 'ACKNOWLEDGED'])
    .select(['severity', 'status'])
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .groupBy(['severity', 'status'])
    .execute();
  return rows.map((r) => ({ severity: r.severity, status: r.status, n: Number(r.n) }));
}

/** ACTIVE shifts with their live state, for the freshness and overrun detectors. */
export async function activeShiftsForDetectors(trx: Database, organizationId: string) {
  return trx
    .selectFrom('shifts as sh')
    .innerJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 'sh.organization_id').onRef('g.id', '=', 'sh.guard_id'),
    )
    .innerJoin('sites as s', (j) =>
      j.onRef('s.organization_id', '=', 'sh.organization_id').onRef('s.id', '=', 'sh.site_id'),
    )
    .leftJoin('shift_live_state as l', (j) =>
      j.onRef('l.organization_id', '=', 'sh.organization_id').onRef('l.id', '=', 'sh.id'),
    )
    .where('sh.organization_id', '=', organizationId)
    .where('sh.status', '=', 'ACTIVE')
    .select([
      'sh.id',
      'sh.guard_id',
      'sh.site_id',
      'sh.actual_started_at',
      'sh.starts_at',
      'sh.ends_at',
      'g.display_name as guard_name',
      's.name as site_name',
      'l.last_contact_at',
      'l.last_fix_captured_at',
    ])
    .execute();
}

/** SCHEDULED shifts late beyond the alert threshold but not yet past their start deadline. */
export async function lateScheduledShifts(
  trx: Database,
  organizationId: string,
  lateBefore: Date,
  now: Date,
) {
  return trx
    .selectFrom('shifts as sh')
    .innerJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 'sh.organization_id').onRef('g.id', '=', 'sh.guard_id'),
    )
    .innerJoin('sites as s', (j) =>
      j.onRef('s.organization_id', '=', 'sh.organization_id').onRef('s.id', '=', 'sh.site_id'),
    )
    .where('sh.organization_id', '=', organizationId)
    .where('sh.status', '=', 'SCHEDULED')
    .where('sh.starts_at', '<=', lateBefore)
    .where('sh.start_deadline_at', '>', now)
    .select([
      'sh.id',
      'sh.guard_id',
      'sh.site_id',
      'sh.starts_at',
      'g.display_name as guard_name',
      's.name as site_name',
    ])
    .execute();
}

/** Open SHIFT_NOT_STARTED alerts whose shift started, ended, was cancelled or was moved later. */
export async function staleNotStartedAlerts(trx: Database, organizationId: string, lateBefore: Date) {
  return trx
    .selectFrom('alerts as a')
    .innerJoin('shifts as sh', (j) =>
      j.onRef('sh.organization_id', '=', 'a.organization_id').onRef('sh.id', '=', 'a.shift_id'),
    )
    .where('a.organization_id', '=', organizationId)
    .where('a.type', '=', 'SHIFT_NOT_STARTED')
    .where('a.status', 'in', ['OPEN', 'ACKNOWLEDGED'])
    .where((eb) => eb.or([eb('sh.status', '<>', 'SCHEDULED'), eb('sh.starts_at', '>', lateBefore)]))
    .select(['a.dedupe_key', 'sh.status as shift_status'])
    .execute();
}
