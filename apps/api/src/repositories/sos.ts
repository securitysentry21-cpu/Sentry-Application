// SOS events, their presses and drills (ARCH §6.3, §13.1; PROD §11). Always inside a tenant
// transaction.
import type { Database } from '@sentryops/db';
import type { DrillWindow } from '@sentryops/domain';

export type SosStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';

export type SosRow = {
  readonly id: string;
  readonly guardId: string;
  readonly guardName: string;
  readonly employeeNumber: string;
  readonly guardPhone: string;
  readonly shiftId: string | null;
  readonly siteId: string | null;
  readonly siteName: string | null;
  readonly siteTimezone: string | null;
  readonly deviceId: string;
  readonly activatedAt: Date;
  readonly receivedAt: Date;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracyM: number | null;
  readonly locationCapturedAt: Date | null;
  readonly status: SosStatus;
  readonly triggerCount: number;
  readonly lastTriggeredAt: Date;
  readonly guardCancelRequestedAt: Date | null;
  readonly alertSentAt: Date | null;
  readonly notifiedAt: Date | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedByName: string | null;
  readonly acknowledgedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolvedByName: string | null;
  readonly resolvedAt: Date | null;
  readonly resolution: string | null;
  readonly resolutionNote: string | null;
  readonly isDrill: boolean;
  readonly drillId: string | null;
  readonly version: number;
};

function sosQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('sos_events as e')
    .innerJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 'e.organization_id').onRef('g.id', '=', 'e.guard_id'),
    )
    .leftJoin('sites as s', (j) =>
      j.onRef('s.organization_id', '=', 'e.organization_id').onRef('s.id', '=', 'e.site_id'),
    )
    .leftJoin('users as ua', 'ua.id', 'e.acknowledged_by')
    .leftJoin('users as ur', 'ur.id', 'e.resolved_by')
    .where('e.organization_id', '=', organizationId)
    .select([
      'e.id',
      'e.guard_id',
      'g.display_name',
      'g.employee_number',
      'g.phone as guard_phone',
      'e.shift_id',
      'e.site_id',
      's.name as site_name',
      's.timezone as site_timezone',
      'e.device_id',
      'e.activated_at',
      'e.received_at',
      'e.latitude',
      'e.longitude',
      'e.accuracy_m',
      'e.location_captured_at',
      'e.status',
      'e.trigger_count',
      'e.last_triggered_at',
      'e.guard_cancel_requested_at',
      'e.alert_sent_at',
      'e.notified_at',
      'e.acknowledged_by',
      'ua.name as acknowledged_by_name',
      'e.acknowledged_at',
      'e.resolved_by',
      'ur.name as resolved_by_name',
      'e.resolved_at',
      'e.resolution',
      'e.resolution_note',
      'e.is_drill',
      'e.drill_id',
      'e.version',
    ]);
}

type RawSos = Awaited<ReturnType<ReturnType<typeof sosQuery>['executeTakeFirstOrThrow']>>;

function toSos(r: RawSos): SosRow {
  return {
    id: r.id,
    guardId: r.guard_id,
    guardName: r.display_name,
    employeeNumber: r.employee_number,
    guardPhone: r.guard_phone,
    shiftId: r.shift_id,
    siteId: r.site_id,
    siteName: r.site_name,
    siteTimezone: r.site_timezone,
    deviceId: r.device_id,
    activatedAt: r.activated_at,
    receivedAt: r.received_at,
    latitude: r.latitude,
    longitude: r.longitude,
    accuracyM: r.accuracy_m,
    locationCapturedAt: r.location_captured_at,
    status: r.status as SosStatus,
    triggerCount: r.trigger_count,
    lastTriggeredAt: r.last_triggered_at,
    guardCancelRequestedAt: r.guard_cancel_requested_at,
    alertSentAt: r.alert_sent_at,
    notifiedAt: r.notified_at,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedByName: r.acknowledged_by_name,
    acknowledgedAt: r.acknowledged_at,
    resolvedBy: r.resolved_by,
    resolvedByName: r.resolved_by_name,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
    resolutionNote: r.resolution_note,
    isDrill: r.is_drill,
    drillId: r.drill_id,
    version: r.version,
  };
}

export async function getSos(trx: Database, organizationId: string, id: string, forUpdate = false) {
  let q = sosQuery(trx, organizationId).where('e.id', '=', id);
  if (forUpdate) q = q.forUpdate('e');
  const row = await q.executeTakeFirst();
  return row ? toSos(row) : null;
}

/** The guard's open SOS (one at most, PROD §11.9), locked. */
export async function openSosForGuard(trx: Database, organizationId: string, guardId: string) {
  const row = await sosQuery(trx, organizationId)
    .where('e.guard_id', '=', guardId)
    .where('e.status', 'in', ['ACTIVE', 'ACKNOWLEDGED'])
    .forUpdate('e')
    .executeTakeFirst();
  return row ? toSos(row) : null;
}

/** The guard's SOS that was open at `at`, if any: incidents filed then may hold coordinates (INV-08). */
export async function sosOpenAt(trx: Database, organizationId: string, guardId: string, at: Date) {
  const row = await trx
    .selectFrom('sos_events')
    .where('organization_id', '=', organizationId)
    .where('guard_id', '=', guardId)
    .where('activated_at', '<=', new Date(at.getTime() + 60_000))
    .where((eb) => eb.or([eb('resolved_at', 'is', null), eb('resolved_at', '>=', at)]))
    .select(['id', 'is_drill', 'shift_id', 'site_id'])
    .orderBy('activated_at', 'desc')
    .executeTakeFirst();
  return row ?? null;
}

export async function pressByClientEvent(
  trx: Database,
  organizationId: string,
  deviceId: string,
  clientEventId: string,
) {
  const row = await trx
    .selectFrom('sos_presses')
    .where('organization_id', '=', organizationId)
    .where('device_id', '=', deviceId)
    .where('client_event_id', '=', clientEventId)
    .select(['sos_event_id'])
    .executeTakeFirst();
  return row?.sos_event_id ?? null;
}

export async function insertSos(
  trx: Database,
  e: {
    id: string;
    organizationId: string;
    guardId: string;
    shiftId: string | null;
    siteId: string | null;
    deviceId: string;
    clientEventId: string;
    activatedAtRecorded: Date;
    activatedAt: Date;
    receivedAt: Date;
    clockStatus: string;
    location: { lat: number; lng: number; accuracyM: number | null; capturedAt: Date } | null;
    isDrill: boolean;
    drillId: string | null;
  },
): Promise<void> {
  await trx
    .insertInto('sos_events')
    .values({
      id: e.id,
      organization_id: e.organizationId,
      guard_id: e.guardId,
      shift_id: e.shiftId,
      site_id: e.siteId,
      device_id: e.deviceId,
      client_event_id: e.clientEventId,
      activated_at_recorded: e.activatedAtRecorded,
      activated_at: e.activatedAt,
      received_at: e.receivedAt,
      clock_status: e.clockStatus,
      latitude: e.location?.lat ?? null,
      longitude: e.location?.lng ?? null,
      accuracy_m: e.location?.accuracyM ?? null,
      location_captured_at: e.location?.capturedAt ?? null,
      status: 'ACTIVE',
      last_triggered_at: e.receivedAt,
      is_drill: e.isDrill,
      drill_id: e.drillId,
      created_at: e.receivedAt,
      updated_at: e.receivedAt,
    })
    .execute();
}

export async function insertPress(
  trx: Database,
  p: {
    id: string;
    organizationId: string;
    sosEventId: string;
    guardId: string;
    deviceId: string;
    clientEventId: string;
    pressedAtRecorded: Date;
    pressedAt: Date;
    receivedAt: Date;
    auth: 'SESSION' | 'DEVICE_SIGNATURE';
  },
): Promise<boolean> {
  const row = await trx
    .insertInto('sos_presses')
    .values({
      id: p.id,
      organization_id: p.organizationId,
      sos_event_id: p.sosEventId,
      guard_id: p.guardId,
      device_id: p.deviceId,
      client_event_id: p.clientEventId,
      pressed_at_recorded: p.pressedAtRecorded,
      pressed_at: p.pressedAt,
      received_at: p.receivedAt,
      auth: p.auth,
    })
    .onConflict((oc) => oc.columns(['device_id', 'client_event_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export async function updateSos(
  trx: Database,
  organizationId: string,
  id: string,
  changes: {
    status?: SosStatus;
    incrementTrigger?: boolean;
    lastTriggeredAt?: Date;
    location?: { lat: number; lng: number; accuracyM: number | null; capturedAt: Date };
    guardCancelRequestedAt?: Date;
    alertSentAt?: Date;
    notifiedAt?: Date;
    acknowledgedBy?: string | null;
    acknowledgedAt?: Date | null;
    resolvedBy?: string;
    resolvedAt?: Date;
    resolution?: string;
    resolutionNote?: string;
  },
  now: Date,
): Promise<void> {
  await trx
    .updateTable('sos_events')
    .set((eb) => ({
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.incrementTrigger ? { trigger_count: eb('trigger_count', '+', 1) } : {}),
      ...(changes.lastTriggeredAt ? { last_triggered_at: changes.lastTriggeredAt } : {}),
      ...(changes.location
        ? {
            latitude: changes.location.lat,
            longitude: changes.location.lng,
            accuracy_m: changes.location.accuracyM,
            location_captured_at: changes.location.capturedAt,
          }
        : {}),
      ...(changes.guardCancelRequestedAt
        ? { guard_cancel_requested_at: changes.guardCancelRequestedAt }
        : {}),
      ...(changes.alertSentAt ? { alert_sent_at: changes.alertSentAt } : {}),
      ...(changes.notifiedAt ? { notified_at: changes.notifiedAt } : {}),
      ...(changes.acknowledgedBy !== undefined ? { acknowledged_by: changes.acknowledgedBy } : {}),
      ...(changes.acknowledgedAt !== undefined ? { acknowledged_at: changes.acknowledgedAt } : {}),
      ...(changes.resolvedBy ? { resolved_by: changes.resolvedBy } : {}),
      ...(changes.resolvedAt ? { resolved_at: changes.resolvedAt } : {}),
      ...(changes.resolution ? { resolution: changes.resolution } : {}),
      ...(changes.resolutionNote ? { resolution_note: changes.resolutionNote } : {}),
      version: eb('version', '+', 1),
      updated_at: now,
    }))
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

/** Sets a first-time fact (alert_sent_at, notified_at) only if it isn't set yet; true if it was set now. */
export async function markSosFact(
  trx: Database,
  organizationId: string,
  id: string,
  fact: 'alert_sent_at' | 'notified_at',
  at: Date,
): Promise<boolean> {
  const result = await trx
    .updateTable('sos_events')
    .set((eb) => ({ [fact]: at, version: eb('version', '+', 1), updated_at: at }))
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .where(fact, 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Each SOS's newest position: live, like the live map's, carried by its stream events. */
export async function sosPositions(trx: Database, organizationId: string, sosEventIds: readonly string[]) {
  if (sosEventIds.length === 0) return [];
  return trx
    .selectFrom('sos_events')
    .where('organization_id', '=', organizationId)
    .where('id', 'in', sosEventIds)
    .where('latitude', 'is not', null)
    .select(['id', 'latitude', 'longitude', 'accuracy_m', 'location_captured_at'])
    .execute();
}

/** The newest SOS points, newest first (the dashboard's SOS page; audited as SOS_VIEWED). */
export async function sosTrail(trx: Database, organizationId: string, sosEventId: string, limit: number) {
  return trx
    .selectFrom('location_points')
    .where('organization_id', '=', organizationId)
    .where('sos_event_id', '=', sosEventId)
    .select(['latitude', 'longitude', 'accuracy_m', 'captured_at'])
    .orderBy('captured_at', 'desc')
    .limit(limit)
    .execute();
}

/** Organizations with an SOS still unacknowledged since before `before` (ARCH §18.4 operator alarm). */
export async function organizationsWithStaleSos(sweep: Database, before: Date): Promise<string[]> {
  const rows = await sweep
    .selectFrom('sos_events')
    .where('status', '=', 'ACTIVE')
    .where('is_drill', '=', false)
    .where('received_at', '<', before)
    .select('organization_id')
    .distinct()
    .execute();
  return rows.map((r) => r.organization_id);
}

// ── Drills ────────────────────────────────────────────────────────────────────────────────────

/** Drill windows that may be open at `at`, with their guards. */
export async function drillsAround(trx: Database, organizationId: string, at: Date): Promise<DrillWindow[]> {
  const drills = await trx
    .selectFrom('sos_drills')
    .where('organization_id', '=', organizationId)
    .where('started_at', '<=', at)
    .where('ends_at', '>', at)
    .select(['id', 'started_at', 'ends_at', 'ended_at'])
    .execute();
  if (drills.length === 0) return [];
  const guards = await trx
    .selectFrom('sos_drill_guards')
    .where('organization_id', '=', organizationId)
    .where(
      'drill_id',
      'in',
      drills.map((d) => d.id),
    )
    .select(['drill_id', 'guard_id'])
    .execute();
  return drills.map((d) => ({
    id: d.id,
    startedAt: d.started_at,
    endsAt: d.ends_at,
    endedAt: d.ended_at,
    guardIds: guards.filter((g) => g.drill_id === d.id).map((g) => g.guard_id),
  }));
}

export async function drillMemberIds(
  trx: Database,
  organizationId: string,
  drillId: string,
): Promise<string[]> {
  const rows = await trx
    .selectFrom('sos_drill_members')
    .where('organization_id', '=', organizationId)
    .where('drill_id', '=', drillId)
    .select('member_id')
    .execute();
  return rows.map((r) => r.member_id);
}

export type DrillRow = {
  readonly id: string;
  readonly startedAt: Date;
  readonly endsAt: Date;
  readonly endedAt: Date | null;
  readonly startedBy: { id: string; name: string };
  readonly note: string | null;
  readonly guards: { id: string; displayName: string }[];
  readonly members: { id: string; name: string }[];
};

export async function getDrill(trx: Database, organizationId: string, id: string, forUpdate = false) {
  let q = trx
    .selectFrom('sos_drills as d')
    .innerJoin('users as u', 'u.id', 'd.started_by_user_id')
    .where('d.organization_id', '=', organizationId)
    .where('d.id', '=', id)
    .select([
      'd.id',
      'd.started_at',
      'd.ends_at',
      'd.ended_at',
      'd.note',
      'u.id as user_id',
      'u.name as user_name',
    ]);
  if (forUpdate) q = q.forUpdate('d');
  const d = await q.executeTakeFirst();
  if (!d) return null;
  const guards = await trx
    .selectFrom('sos_drill_guards as x')
    .innerJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 'x.organization_id').onRef('g.id', '=', 'x.guard_id'),
    )
    .where('x.organization_id', '=', organizationId)
    .where('x.drill_id', '=', id)
    .select(['g.id', 'g.display_name'])
    .orderBy('g.display_name')
    .execute();
  const members = await trx
    .selectFrom('sos_drill_members as x')
    .innerJoin('organization_members as m', (j) =>
      j.onRef('m.organization_id', '=', 'x.organization_id').onRef('m.id', '=', 'x.member_id'),
    )
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .where('x.organization_id', '=', organizationId)
    .where('x.drill_id', '=', id)
    .select(['m.id', 'u.name'])
    .orderBy('u.name')
    .execute();
  const row: DrillRow = {
    id: d.id,
    startedAt: d.started_at,
    endsAt: d.ends_at,
    endedAt: d.ended_at,
    startedBy: { id: d.user_id, name: d.user_name },
    note: d.note,
    guards: guards.map((g) => ({ id: g.id, displayName: g.display_name })),
    members: members.map((m) => ({ id: m.id, name: m.name })),
  };
  return row;
}

/** The drill open now (started, not ended, not past its end), if any. */
export async function currentDrillId(
  trx: Database,
  organizationId: string,
  now: Date,
): Promise<string | null> {
  const row = await trx
    .selectFrom('sos_drills')
    .where('organization_id', '=', organizationId)
    .where('started_at', '<=', now)
    .where('ends_at', '>', now)
    .where('ended_at', 'is', null)
    .select('id')
    .orderBy('started_at', 'desc')
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function insertDrill(
  trx: Database,
  d: {
    id: string;
    organizationId: string;
    startedBy: string;
    startedAt: Date;
    endsAt: Date;
    note: string | null;
    guards: { id: string; guardId: string }[];
    members: { id: string; memberId: string }[];
  },
): Promise<void> {
  await trx
    .insertInto('sos_drills')
    .values({
      id: d.id,
      organization_id: d.organizationId,
      started_by_user_id: d.startedBy,
      started_at: d.startedAt,
      ends_at: d.endsAt,
      note: d.note,
      created_at: d.startedAt,
      updated_at: d.startedAt,
    })
    .execute();
  await trx
    .insertInto('sos_drill_guards')
    .values(
      d.guards.map((g) => ({
        id: g.id,
        organization_id: d.organizationId,
        drill_id: d.id,
        guard_id: g.guardId,
      })),
    )
    .execute();
  await trx
    .insertInto('sos_drill_members')
    .values(
      d.members.map((m) => ({
        id: m.id,
        organization_id: d.organizationId,
        drill_id: d.id,
        member_id: m.memberId,
      })),
    )
    .execute();
}

export async function endDrill(
  trx: Database,
  organizationId: string,
  id: string,
  userId: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('sos_drills')
    .set({ ended_at: now, ended_by_user_id: userId, updated_at: now })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .where('ended_at', 'is', null)
    .execute();
}
