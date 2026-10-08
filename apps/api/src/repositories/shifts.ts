// Shifts and shift events (PROD §6, ARCH §7). Always inside a tenant transaction.
import type { SiteBoundary } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import type { ShiftStatus } from '@sentryops/domain';

export type ShiftRow = {
  readonly id: string;
  readonly guardId: string;
  readonly guardName: string;
  readonly employeeNumber: string;
  readonly siteId: string;
  readonly siteName: string;
  readonly siteTimezone: string;
  readonly siteBoundary: SiteBoundary;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly startDeadlineAt: Date;
  readonly status: ShiftStatus;
  readonly actualStartedAt: Date | null;
  readonly actualEndedAt: Date | null;
  readonly startSource: 'APP_ONLINE' | 'APP_OFFLINE_SYNCED' | 'SUPERVISOR_MANUAL' | null;
  readonly startGeofenceClass: 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN' | 'NO_FIX' | null;
  readonly startDistanceM: number | null;
  readonly startFlags: string[];
  readonly endReason:
    'GUARD' | 'GUARD_OFFLINE_SYNCED' | 'SUPERVISOR_FORCE_END' | 'AUTO_TIMEOUT' | 'GUARD_DISABLED' | null;
  readonly cancelledReason: string | null;
  readonly notes: string | null;
  readonly version: number;
};

function shiftQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('shifts as sh')
    .innerJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 'sh.organization_id').onRef('g.id', '=', 'sh.guard_id'),
    )
    .innerJoin('sites as s', (j) =>
      j.onRef('s.organization_id', '=', 'sh.organization_id').onRef('s.id', '=', 'sh.site_id'),
    )
    .select([
      'sh.id',
      'sh.guard_id',
      'g.display_name',
      'g.employee_number',
      'sh.site_id',
      's.name as site_name',
      's.timezone as site_timezone',
      's.boundary_kind',
      's.latitude as site_latitude',
      's.longitude as site_longitude',
      's.geofence_radius_meters',
      's.polygon',
      'sh.starts_at',
      'sh.ends_at',
      'sh.start_deadline_at',
      'sh.status',
      'sh.actual_started_at',
      'sh.actual_ended_at',
      'sh.start_source',
      'sh.start_geofence_class',
      'sh.start_distance_m',
      'sh.start_flags',
      'sh.end_reason',
      'sh.cancelled_reason',
      'sh.notes',
      'sh.version',
    ])
    .where('sh.organization_id', '=', organizationId);
}

type RawShift = Awaited<ReturnType<ReturnType<typeof shiftQuery>['executeTakeFirstOrThrow']>>;

function toShift(r: RawShift): ShiftRow {
  const siteBoundary: SiteBoundary =
    r.boundary_kind === 'POLYGON'
      ? { kind: 'POLYGON', points: r.polygon as { lat: number; lng: number }[] }
      : {
          kind: 'CIRCLE',
          center: { lat: r.site_latitude, lng: r.site_longitude },
          radiusM: r.geofence_radius_meters ?? 100,
        };
  return {
    id: r.id,
    guardId: r.guard_id,
    guardName: r.display_name,
    employeeNumber: r.employee_number,
    siteId: r.site_id,
    siteName: r.site_name,
    siteTimezone: r.site_timezone,
    siteBoundary,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    startDeadlineAt: r.start_deadline_at,
    status: r.status as ShiftStatus,
    actualStartedAt: r.actual_started_at,
    actualEndedAt: r.actual_ended_at,
    startSource: r.start_source as ShiftRow['startSource'],
    startGeofenceClass: r.start_geofence_class as ShiftRow['startGeofenceClass'],
    startDistanceM: r.start_distance_m,
    startFlags: r.start_flags,
    endReason: r.end_reason as ShiftRow['endReason'],
    cancelledReason: r.cancelled_reason,
    notes: r.notes,
    version: r.version,
  };
}

/** Shifts overlapping [from, to), oldest first. */
export async function listShifts(
  trx: Database,
  organizationId: string,
  filter: { from: Date; to: Date; siteId?: string; guardId?: string; limit?: number; startsWithin?: boolean },
): Promise<ShiftRow[]> {
  let query = shiftQuery(trx, organizationId).where('sh.starts_at', '<', filter.to);
  // Overlapping the period by default; a report counts a shift on the day it was scheduled to start.
  query = filter.startsWithin
    ? query.where('sh.starts_at', '>=', filter.from)
    : query.where('sh.ends_at', '>', filter.from);
  if (filter.siteId) query = query.where('sh.site_id', '=', filter.siteId);
  if (filter.guardId) query = query.where('sh.guard_id', '=', filter.guardId);
  const rows = await query
    .orderBy('sh.starts_at')
    .orderBy('sh.id')
    .limit(filter.limit ?? 2000)
    .execute();
  return rows.map(toShift);
}

export async function getShift(trx: Database, organizationId: string, id: string, forUpdate = false) {
  let query = shiftQuery(trx, organizationId).where('sh.id', '=', id);
  if (forUpdate) query = query.forUpdate('sh');
  const row = await query.executeTakeFirst();
  return row ? toShift(row) : null;
}

export async function insertShift(
  trx: Database,
  input: {
    id: string;
    organizationId: string;
    guardId: string;
    siteId: string;
    startsAt: Date;
    endsAt: Date;
    startDeadlineAt: Date;
    notes: string | null;
    userId: string;
    now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('shifts')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      guard_id: input.guardId,
      site_id: input.siteId,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      start_deadline_at: input.startDeadlineAt,
      notes: input.notes,
      created_at: input.now,
      updated_at: input.now,
      created_by_user_id: input.userId,
      updated_by_user_id: input.userId,
    })
    .execute();
}

export type ShiftUpdate = {
  guardId?: string;
  siteId?: string;
  startsAt?: Date;
  endsAt?: Date;
  startDeadlineAt?: Date;
  status?: ShiftStatus;
  actualStartedAt?: Date;
  actualEndedAt?: Date;
  startSource?: NonNullable<ShiftRow['startSource']>;
  start?: { lat: number; lng: number; accuracyM: number | null } | null;
  startDistanceM?: number | null;
  startGeofenceClass?: NonNullable<ShiftRow['startGeofenceClass']>;
  startDeviceId?: string | null;
  startFlags?: string[];
  endReason?: NonNullable<ShiftRow['endReason']>;
  end?: { lat: number; lng: number; accuracyM: number | null } | null;
  cancelledReason?: string;
  notes?: string | null;
};

export async function updateShift(
  trx: Database,
  input: {
    organizationId: string;
    id: string;
    version: number;
    userId: string | null;
    now: Date;
    changes: ShiftUpdate;
  },
): Promise<boolean> {
  const c = input.changes;
  const result = await trx
    .updateTable('shifts')
    .set({
      ...(c.guardId !== undefined ? { guard_id: c.guardId } : {}),
      ...(c.siteId !== undefined ? { site_id: c.siteId } : {}),
      ...(c.startsAt !== undefined ? { starts_at: c.startsAt } : {}),
      ...(c.endsAt !== undefined ? { ends_at: c.endsAt } : {}),
      ...(c.startDeadlineAt !== undefined ? { start_deadline_at: c.startDeadlineAt } : {}),
      ...(c.status !== undefined ? { status: c.status } : {}),
      ...(c.actualStartedAt !== undefined ? { actual_started_at: c.actualStartedAt } : {}),
      ...(c.actualEndedAt !== undefined ? { actual_ended_at: c.actualEndedAt } : {}),
      ...(c.startSource !== undefined ? { start_source: c.startSource } : {}),
      ...(c.start !== undefined
        ? {
            start_latitude: c.start?.lat ?? null,
            start_longitude: c.start?.lng ?? null,
            start_accuracy_m: c.start?.accuracyM ?? null,
          }
        : {}),
      ...(c.startDistanceM !== undefined ? { start_distance_m: c.startDistanceM } : {}),
      ...(c.startGeofenceClass !== undefined ? { start_geofence_class: c.startGeofenceClass } : {}),
      ...(c.startDeviceId !== undefined ? { start_device_id: c.startDeviceId } : {}),
      ...(c.startFlags !== undefined ? { start_flags: c.startFlags } : {}),
      ...(c.endReason !== undefined ? { end_reason: c.endReason } : {}),
      ...(c.end !== undefined
        ? {
            end_latitude: c.end?.lat ?? null,
            end_longitude: c.end?.lng ?? null,
            end_accuracy_m: c.end?.accuracyM ?? null,
          }
        : {}),
      ...(c.cancelledReason !== undefined ? { cancelled_reason: c.cancelledReason } : {}),
      ...(c.notes !== undefined ? { notes: c.notes } : {}),
      version: input.version + 1,
      updated_at: input.now,
      ...(input.userId ? { updated_by_user_id: input.userId } : {}),
    })
    .where('organization_id', '=', input.organizationId)
    .where('id', '=', input.id)
    .where('version', '=', input.version)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function insertShiftEvent(
  trx: Database,
  input: {
    id: string;
    organizationId: string;
    shiftId: string;
    type: string;
    actorType: 'GUARD' | 'USER' | 'SYSTEM';
    actorUserId: string | null;
    deviceId: string | null;
    clientEventId: string | null;
    occurredAt: Date;
    clientRecordedAt: Date | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await trx
    .insertInto('shift_events')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      shift_id: input.shiftId,
      type: input.type,
      actor_type: input.actorType,
      actor_user_id: input.actorUserId,
      device_id: input.deviceId,
      client_event_id: input.clientEventId,
      occurred_at: input.occurredAt,
      client_recorded_at: input.clientRecordedAt,
      payload: JSON.stringify(input.payload),
      created_at: input.occurredAt,
    })
    .execute();
}

export async function eventByClientId(
  trx: Database,
  organizationId: string,
  shiftId: string,
  clientEventId: string,
) {
  return trx
    .selectFrom('shift_events')
    .select(['type', 'payload'])
    .where('organization_id', '=', organizationId)
    .where('shift_id', '=', shiftId)
    .where('client_event_id', '=', clientEventId)
    .executeTakeFirst();
}

export async function otherActiveShift(
  trx: Database,
  organizationId: string,
  guardId: string,
  exceptShiftId: string,
) {
  const row = await trx
    .selectFrom('shifts')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('guard_id', '=', guardId)
    .where('status', '=', 'ACTIVE')
    .where('id', '<>', exceptShiftId)
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function activeShiftsForGuard(trx: Database, organizationId: string, guardId: string) {
  const rows = await shiftQuery(trx, organizationId)
    .where('sh.guard_id', '=', guardId)
    .where('sh.status', '=', 'ACTIVE')
    .forUpdate('sh')
    .execute();
  return rows.map(toShift);
}

/** The guard's own shifts around now, for the guard app. */
export async function guardShifts(
  trx: Database,
  organizationId: string,
  guardId: string,
  from: Date,
  to: Date,
) {
  const rows = await shiftQuery(trx, organizationId)
    .where('sh.guard_id', '=', guardId)
    .where('sh.status', 'in', ['SCHEDULED', 'ACTIVE', 'MISSED'])
    .where('sh.ends_at', '>', from)
    .where('sh.starts_at', '<', to)
    .orderBy('sh.starts_at')
    .limit(50)
    .execute();
  return rows.map(toShift);
}

/** Existing shifts of a guard overlapping a period, for the bulk-create preview. */
export async function overlapping(
  trx: Database,
  organizationId: string,
  guardId: string,
  from: Date,
  to: Date,
) {
  return trx
    .selectFrom('shifts')
    .select(['starts_at', 'ends_at'])
    .where('organization_id', '=', organizationId)
    .where('guard_id', '=', guardId)
    .where('status', '<>', 'CANCELLED')
    .where('starts_at', '<', to)
    .where('ends_at', '>', from)
    .execute();
}
