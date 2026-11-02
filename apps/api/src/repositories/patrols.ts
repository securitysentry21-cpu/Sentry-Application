// Patrol routes, runs and checkpoint visits (PROD §9, ARCH §11). Always inside a tenant transaction.
import type { Database } from '@sentryops/db';
import type { RouteStop, RunStatus, ScanOutcome } from '@sentryops/domain';

type SiteStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

// ── Routes ───────────────────────────────────────────────────────────────────────────────────

export type RouteStopRow = RouteStop & {
  readonly name: string;
  readonly location: { lat: number; lng: number } | null;
};

export type PatrolRouteRow = {
  readonly id: string;
  readonly siteId: string;
  readonly name: string;
  readonly description: string | null;
  readonly enforceOrder: boolean;
  readonly intervalMinutes: number | null;
  readonly firstRunOffsetMinutes: number;
  readonly completionWindowMinutes: number | null;
  readonly status: SiteStatus;
  readonly version: number;
  readonly updatedAt: Date;
  readonly stops: readonly RouteStopRow[];
};

function routeQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('patrol_routes')
    .select([
      'id',
      'site_id',
      'name',
      'description',
      'enforce_order',
      'interval_minutes',
      'first_run_offset_minutes',
      'completion_window_minutes',
      'status',
      'version',
      'updated_at',
    ])
    .where('organization_id', '=', organizationId);
}

type RouteRecord = Awaited<ReturnType<ReturnType<typeof routeQuery>['executeTakeFirstOrThrow']>>;

async function withStops(
  trx: Database,
  organizationId: string,
  rows: RouteRecord[],
): Promise<PatrolRouteRow[]> {
  const stops = await stopsForRoutes(
    trx,
    organizationId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    siteId: r.site_id,
    name: r.name,
    description: r.description,
    enforceOrder: r.enforce_order,
    intervalMinutes: r.interval_minutes,
    firstRunOffsetMinutes: r.first_run_offset_minutes,
    completionWindowMinutes: r.completion_window_minutes,
    status: r.status as SiteStatus,
    version: r.version,
    updatedAt: r.updated_at,
    stops: stops.get(r.id) ?? [],
  }));
}

/** The stops of each route, in route order, with the checkpoint's name and position. */
export async function stopsForRoutes(
  trx: Database,
  organizationId: string,
  routeIds: readonly string[],
): Promise<Map<string, RouteStopRow[]>> {
  const out = new Map<string, RouteStopRow[]>();
  if (routeIds.length === 0) return out;
  const rows = await trx
    .selectFrom('patrol_route_checkpoints as rc')
    .innerJoin('checkpoints as c', (j) =>
      j.onRef('c.id', '=', 'rc.checkpoint_id').onRef('c.organization_id', '=', 'rc.organization_id'),
    )
    .select([
      'rc.patrol_route_id',
      'rc.checkpoint_id',
      'rc.sequence',
      'rc.required',
      'c.name',
      'c.latitude',
      'c.longitude',
    ])
    .where('rc.organization_id', '=', organizationId)
    .where('rc.patrol_route_id', 'in', routeIds)
    .orderBy('rc.patrol_route_id')
    .orderBy('rc.sequence')
    .execute();
  for (const r of rows) {
    const list = out.get(r.patrol_route_id) ?? [];
    list.push({
      checkpointId: r.checkpoint_id,
      sequence: r.sequence,
      required: r.required,
      name: r.name,
      location: r.latitude !== null && r.longitude !== null ? { lat: r.latitude, lng: r.longitude } : null,
    });
    out.set(r.patrol_route_id, list);
  }
  return out;
}

/** A site's routes, archived ones left out. */
export async function listRoutes(trx: Database, organizationId: string, siteId: string) {
  const rows = await routeQuery(trx, organizationId)
    .where('site_id', '=', siteId)
    .where('status', '<>', 'ARCHIVED')
    .orderBy('name')
    .orderBy('id')
    .execute();
  return withStops(trx, organizationId, rows);
}

export async function getRoute(trx: Database, organizationId: string, id: string, forUpdate = false) {
  let query = routeQuery(trx, organizationId).where('id', '=', id);
  if (forUpdate) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row ? ((await withStops(trx, organizationId, [row]))[0] ?? null) : null;
}

/** Active routes with a schedule at a site: the ones a shift there has runs of. */
export async function scheduledRoutesForSite(trx: Database, organizationId: string, siteId: string) {
  const rows = await routeQuery(trx, organizationId)
    .where('site_id', '=', siteId)
    .where('status', '=', 'ACTIVE')
    .where('interval_minutes', 'is not', null)
    .orderBy('id')
    .execute();
  return withStops(trx, organizationId, rows);
}

/** Locks a site's routes, so two edits can't both put one checkpoint in two scheduled routes. */
export async function lockSiteRoutes(trx: Database, organizationId: string, siteId: string): Promise<void> {
  await trx
    .selectFrom('patrol_routes')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('site_id', '=', siteId)
    .forUpdate()
    .execute();
}

/** Checkpoints of the list already in another active scheduled route. */
export async function checkpointsInOtherScheduledRoutes(
  trx: Database,
  organizationId: string,
  checkpointIds: readonly string[],
  exceptRouteId: string | null,
): Promise<string[]> {
  if (checkpointIds.length === 0) return [];
  let query = trx
    .selectFrom('patrol_route_checkpoints as rc')
    .innerJoin('patrol_routes as r', (j) =>
      j.onRef('r.id', '=', 'rc.patrol_route_id').onRef('r.organization_id', '=', 'rc.organization_id'),
    )
    .select('rc.checkpoint_id')
    .where('rc.organization_id', '=', organizationId)
    .where('rc.checkpoint_id', 'in', checkpointIds)
    .where('r.status', '=', 'ACTIVE')
    .where('r.interval_minutes', 'is not', null);
  if (exceptRouteId) query = query.where('r.id', '<>', exceptRouteId);
  return (await query.execute()).map((r) => r.checkpoint_id);
}

/** Names of the active routes that list the checkpoint. */
export async function activeRoutesWithCheckpoint(
  trx: Database,
  organizationId: string,
  checkpointId: string,
): Promise<string[]> {
  const rows = await trx
    .selectFrom('patrol_route_checkpoints as rc')
    .innerJoin('patrol_routes as r', (j) =>
      j.onRef('r.id', '=', 'rc.patrol_route_id').onRef('r.organization_id', '=', 'rc.organization_id'),
    )
    .select('r.name')
    .where('rc.organization_id', '=', organizationId)
    .where('rc.checkpoint_id', '=', checkpointId)
    .where('r.status', '=', 'ACTIVE')
    .orderBy('r.name')
    .execute();
  return rows.map((r) => r.name);
}

/** The route a checkpoint belongs to for runs: the active scheduled one, if any (PROD §5.3). */
export async function scheduledRouteOfCheckpoint(
  trx: Database,
  organizationId: string,
  checkpointId: string,
) {
  return (
    (await trx
      .selectFrom('patrol_route_checkpoints as rc')
      .innerJoin('patrol_routes as r', (j) =>
        j.onRef('r.id', '=', 'rc.patrol_route_id').onRef('r.organization_id', '=', 'rc.organization_id'),
      )
      .select(['r.id', 'r.enforce_order'])
      .where('rc.organization_id', '=', organizationId)
      .where('rc.checkpoint_id', '=', checkpointId)
      .where('r.status', '=', 'ACTIVE')
      .where('r.interval_minutes', 'is not', null)
      .executeTakeFirst()) ?? null
  );
}

/** Any active route holding the checkpoint, scheduled ones first: for on-demand scans. */
export async function anyRouteOfCheckpoint(trx: Database, organizationId: string, checkpointId: string) {
  const row = await trx
    .selectFrom('patrol_route_checkpoints as rc')
    .innerJoin('patrol_routes as r', (j) =>
      j.onRef('r.id', '=', 'rc.patrol_route_id').onRef('r.organization_id', '=', 'rc.organization_id'),
    )
    .select('r.id')
    .where('rc.organization_id', '=', organizationId)
    .where('rc.checkpoint_id', '=', checkpointId)
    .where('r.status', '=', 'ACTIVE')
    .orderBy('r.interval_minutes')
    .orderBy('r.id')
    .executeTakeFirst();
  return row?.id ?? null;
}

export type RouteInput = {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly name: string;
  readonly description: string | null;
  readonly enforceOrder: boolean;
  readonly intervalMinutes: number | null;
  readonly firstRunOffsetMinutes: number;
  readonly completionWindowMinutes: number | null;
  readonly userId: string;
  readonly now: Date;
};

export async function insertRoute(trx: Database, r: RouteInput): Promise<void> {
  await trx
    .insertInto('patrol_routes')
    .values({
      id: r.id,
      organization_id: r.organizationId,
      site_id: r.siteId,
      name: r.name,
      description: r.description,
      enforce_order: r.enforceOrder,
      interval_minutes: r.intervalMinutes,
      first_run_offset_minutes: r.firstRunOffsetMinutes,
      completion_window_minutes: r.completionWindowMinutes,
      created_at: r.now,
      updated_at: r.now,
      created_by_user_id: r.userId,
      updated_by_user_id: r.userId,
    })
    .execute();
}

export type RouteChanges = Partial<{
  name: string;
  description: string | null;
  enforceOrder: boolean;
  schedule: {
    intervalMinutes: number;
    firstRunOffsetMinutes: number;
    completionWindowMinutes: number;
  } | null;
  status: SiteStatus;
}>;

/** Optimistic concurrency (ARCH §15.1): false when the version moved on. */
export async function updateRoute(
  trx: Database,
  u: {
    organizationId: string;
    id: string;
    version: number;
    userId: string;
    now: Date;
    changes: RouteChanges;
  },
): Promise<boolean> {
  const c = u.changes;
  const result = await trx
    .updateTable('patrol_routes')
    .set((eb) => ({
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.enforceOrder !== undefined ? { enforce_order: c.enforceOrder } : {}),
      ...(c.schedule !== undefined
        ? {
            interval_minutes: c.schedule?.intervalMinutes ?? null,
            first_run_offset_minutes: c.schedule?.firstRunOffsetMinutes ?? 0,
            completion_window_minutes: c.schedule?.completionWindowMinutes ?? null,
          }
        : {}),
      ...(c.status !== undefined ? { status: c.status } : {}),
      version: eb('version', '+', 1),
      updated_at: u.now,
      updated_by_user_id: u.userId,
    }))
    .where('organization_id', '=', u.organizationId)
    .where('id', '=', u.id)
    .where('version', '=', u.version)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

/** Replaces a route's stops, in the given order. */
export async function replaceRouteStops(
  trx: Database,
  r: {
    organizationId: string;
    siteId: string;
    routeId: string;
    stops: readonly { id: string; checkpointId: string; required: boolean }[];
  },
): Promise<void> {
  await trx
    .deleteFrom('patrol_route_checkpoints')
    .where('organization_id', '=', r.organizationId)
    .where('patrol_route_id', '=', r.routeId)
    .execute();
  if (r.stops.length === 0) return;
  await trx
    .insertInto('patrol_route_checkpoints')
    .values(
      r.stops.map((s, i) => ({
        id: s.id,
        organization_id: r.organizationId,
        site_id: r.siteId,
        patrol_route_id: r.routeId,
        checkpoint_id: s.checkpointId,
        sequence: i + 1,
        required: s.required,
      })),
    )
    .execute();
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────

export type PatrolRunRow = {
  readonly id: string;
  readonly shiftId: string;
  readonly guardId: string;
  readonly guardName: string;
  readonly siteId: string;
  readonly siteName: string;
  readonly siteTimezone: string;
  readonly routeId: string;
  readonly routeName: string;
  readonly enforceOrder: boolean;
  readonly sequenceNo: number;
  readonly dueAt: Date;
  readonly windowEndsAt: Date;
  readonly status: RunStatus;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly closedAt: Date | null;
  readonly requiredCount: number;
  readonly countedCount: number;
  readonly unconfirmedCount: number;
};

function runQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('patrol_runs as pr')
    .innerJoin('guards as g', (j) =>
      j.onRef('g.id', '=', 'pr.guard_id').onRef('g.organization_id', '=', 'pr.organization_id'),
    )
    .innerJoin('sites as s', (j) =>
      j.onRef('s.id', '=', 'pr.site_id').onRef('s.organization_id', '=', 'pr.organization_id'),
    )
    .innerJoin('patrol_routes as r', (j) =>
      j.onRef('r.id', '=', 'pr.patrol_route_id').onRef('r.organization_id', '=', 'pr.organization_id'),
    )
    .select([
      'pr.id',
      'pr.shift_id',
      'pr.guard_id',
      'g.display_name as guard_name',
      'pr.site_id',
      's.name as site_name',
      's.timezone as site_timezone',
      'pr.patrol_route_id',
      'r.name as route_name',
      'r.enforce_order',
      'pr.sequence_no',
      'pr.due_at',
      'pr.window_ends_at',
      'pr.status',
      'pr.started_at',
      'pr.completed_at',
      'pr.closed_at',
      'pr.required_count',
      'pr.counted_count',
      'pr.unconfirmed_count',
    ])
    .where('pr.organization_id', '=', organizationId);
}

type RunRecord = Awaited<ReturnType<ReturnType<typeof runQuery>['executeTakeFirstOrThrow']>>;

function toRun(r: RunRecord): PatrolRunRow {
  return {
    id: r.id,
    shiftId: r.shift_id,
    guardId: r.guard_id,
    guardName: r.guard_name,
    siteId: r.site_id,
    siteName: r.site_name,
    siteTimezone: r.site_timezone,
    routeId: r.patrol_route_id,
    routeName: r.route_name,
    enforceOrder: r.enforce_order,
    sequenceNo: r.sequence_no,
    dueAt: r.due_at,
    windowEndsAt: r.window_ends_at,
    status: r.status as RunStatus,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    closedAt: r.closed_at,
    requiredCount: r.required_count,
    countedCount: r.counted_count,
    unconfirmedCount: r.unconfirmed_count,
  };
}

export type RunFilter = {
  readonly shiftId?: string | undefined;
  readonly siteId?: string | undefined;
  readonly guardId?: string | undefined;
  readonly status?: RunStatus | undefined;
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
};

/** Runs due in [from, to), newest first. */
export async function listRuns(trx: Database, organizationId: string, f: RunFilter): Promise<PatrolRunRow[]> {
  let query = runQuery(trx, organizationId).where('pr.due_at', '>=', f.from).where('pr.due_at', '<', f.to);
  if (f.shiftId) query = query.where('pr.shift_id', '=', f.shiftId);
  if (f.siteId) query = query.where('pr.site_id', '=', f.siteId);
  if (f.guardId) query = query.where('pr.guard_id', '=', f.guardId);
  if (f.status) query = query.where('pr.status', '=', f.status);
  const rows = await query.orderBy('pr.due_at', 'desc').orderBy('pr.id').limit(f.limit).execute();
  return rows.map(toRun);
}

export async function runsForShift(
  trx: Database,
  organizationId: string,
  shiftId: string,
): Promise<PatrolRunRow[]> {
  const rows = await runQuery(trx, organizationId)
    .where('pr.shift_id', '=', shiftId)
    .orderBy('pr.due_at')
    .orderBy('pr.patrol_route_id')
    .execute();
  return rows.map(toRun);
}

export async function getRun(
  trx: Database,
  organizationId: string,
  id: string,
): Promise<PatrolRunRow | null> {
  const row = await runQuery(trx, organizationId).where('pr.id', '=', id).executeTakeFirst();
  return row ? toRun(row) : null;
}

/** Locks a run's row while its progress is recomputed. */
export async function lockRun(trx: Database, organizationId: string, id: string): Promise<void> {
  await trx
    .selectFrom('patrol_runs')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .forUpdate()
    .execute();
}

/** The run of a route in a shift whose window holds the time; cancelled runs never take scans. */
export async function runAt(
  trx: Database,
  organizationId: string,
  shiftId: string,
  routeId: string,
  at: Date,
): Promise<PatrolRunRow | null> {
  const row = await runQuery(trx, organizationId)
    .where('pr.shift_id', '=', shiftId)
    .where('pr.patrol_route_id', '=', routeId)
    .where('pr.due_at', '<=', at)
    .where('pr.window_ends_at', '>=', at)
    .where('pr.status', '<>', 'CANCELLED')
    .orderBy('pr.due_at', 'desc')
    .executeTakeFirst();
  return row ? toRun(row) : null;
}

export type RunInsert = {
  readonly id: string;
  readonly organizationId: string;
  readonly shiftId: string;
  readonly guardId: string;
  readonly siteId: string;
  readonly routeId: string;
  readonly sequenceNo: number;
  readonly dueAt: Date;
  readonly windowEndsAt: Date;
  readonly requiredCount: number;
  readonly now: Date;
};

export async function insertRuns(trx: Database, runs: readonly RunInsert[]): Promise<void> {
  if (runs.length === 0) return;
  await trx
    .insertInto('patrol_runs')
    .values(
      runs.map((r) => ({
        id: r.id,
        organization_id: r.organizationId,
        shift_id: r.shiftId,
        guard_id: r.guardId,
        site_id: r.siteId,
        patrol_route_id: r.routeId,
        sequence_no: r.sequenceNo,
        due_at: r.dueAt,
        window_ends_at: r.windowEndsAt,
        required_count: r.requiredCount,
        created_at: r.now,
        updated_at: r.now,
      })),
    )
    .onConflict((oc) => oc.columns(['shift_id', 'patrol_route_id', 'sequence_no']).doNothing())
    .execute();
}

/**
 * Removes a shift's runs that are not yet due. A run can only hold scans once it is due, so nothing
 * recorded goes with them; they are generated again from the current schedule.
 */
export async function deleteRunsNotYetDue(
  trx: Database,
  organizationId: string,
  shiftId: string,
  after: Date,
  routeId?: string,
): Promise<void> {
  let query = trx
    .deleteFrom('patrol_runs')
    .where('organization_id', '=', organizationId)
    .where('shift_id', '=', shiftId)
    .where('status', '=', 'PENDING')
    .where('due_at', '>', after);
  if (routeId) query = query.where('patrol_route_id', '=', routeId);
  await query.execute();
}

export type RunProgressUpdate = {
  readonly status: RunStatus;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly closedAt?: Date | null;
  readonly requiredCount: number;
  readonly countedCount: number;
  readonly unconfirmedCount: number;
  readonly now: Date;
};

export async function updateRunProgress(
  trx: Database,
  organizationId: string,
  id: string,
  u: RunProgressUpdate,
): Promise<void> {
  await trx
    .updateTable('patrol_runs')
    .set({
      status: u.status,
      started_at: u.startedAt,
      completed_at: u.completedAt,
      ...(u.closedAt !== undefined ? { closed_at: u.closedAt } : {}),
      required_count: u.requiredCount,
      counted_count: u.countedCount,
      unconfirmed_count: u.unconfirmedCount,
      updated_at: u.now,
    })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

/** A run's status and counters, for a scan result. */
export async function runCounters(
  trx: Database,
  organizationId: string,
  id: string,
): Promise<{ status: RunStatus; countedCount: number; requiredCount: number } | null> {
  const row = await trx
    .selectFrom('patrol_runs')
    .select(['status', 'counted_count', 'required_count'])
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .executeTakeFirst();
  return row
    ? { status: row.status as RunStatus, countedCount: row.counted_count, requiredCount: row.required_count }
    : null;
}

/** Active shifts at a site, whose runs follow a route change. */
export async function activeShiftIdsAtSite(trx: Database, organizationId: string, siteId: string) {
  const rows = await trx
    .selectFrom('shifts')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('site_id', '=', siteId)
    .where('status', '=', 'ACTIVE')
    .execute();
  return rows.map((r) => r.id);
}

/** Open runs whose window ended before the time, oldest first. */
export async function openRunsEndedBefore(
  trx: Database,
  organizationId: string,
  before: Date,
  limit: number,
): Promise<PatrolRunRow[]> {
  const rows = await runQuery(trx, organizationId)
    .where('pr.status', 'in', ['PENDING', 'IN_PROGRESS'])
    .where('pr.window_ends_at', '<', before)
    .orderBy('pr.window_ends_at')
    .limit(limit)
    .execute();
  return rows.map(toRun);
}

// ── Visits ───────────────────────────────────────────────────────────────────────────────────

export type VisitInsert = {
  readonly id: string;
  readonly organizationId: string;
  readonly guardId: string;
  readonly shiftId: string | null;
  readonly checkpointId: string | null;
  readonly routeId: string | null;
  readonly runId: string | null;
  readonly deviceId: string;
  readonly clientEventId: string;
  readonly scannedAtRecorded: Date;
  readonly scannedAt: Date;
  readonly receivedAt: Date;
  readonly clockStatus: string;
  readonly position: { lat: number; lng: number } | null;
  readonly accuracyM: number | null;
  readonly fixAgeS: number | null;
  readonly distanceM: number | null;
  readonly distanceBand: string | null;
  readonly isMock: boolean | null;
  readonly outcome: ScanOutcome;
  readonly reason: string | null;
  readonly flags: readonly string[];
  readonly counted: boolean;
  readonly qrTokenVersion: number | null;
};

/** False when the device already sent this event (INV-06): the first one stands. */
export async function insertVisit(trx: Database, v: VisitInsert): Promise<boolean> {
  const row = await trx
    .insertInto('checkpoint_visits')
    .values({
      id: v.id,
      organization_id: v.organizationId,
      guard_id: v.guardId,
      shift_id: v.shiftId,
      checkpoint_id: v.checkpointId,
      patrol_route_id: v.routeId,
      patrol_run_id: v.runId,
      device_id: v.deviceId,
      client_event_id: v.clientEventId,
      scanned_at_recorded: v.scannedAtRecorded,
      scanned_at: v.scannedAt,
      received_at: v.receivedAt,
      clock_status: v.clockStatus,
      latitude: v.position?.lat ?? null,
      longitude: v.position?.lng ?? null,
      accuracy_m: v.accuracyM,
      fix_age_s: v.fixAgeS,
      distance_m: v.distanceM,
      distance_band: v.distanceBand,
      is_mock: v.isMock,
      verification_status: v.outcome,
      verification_reason: v.reason,
      flags: [...v.flags],
      counted: v.counted,
      qr_token_version: v.qrTokenVersion,
    })
    .onConflict((oc) => oc.columns(['device_id', 'client_event_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export type VisitRow = {
  readonly id: string;
  readonly shiftId: string | null;
  readonly runId: string | null;
  readonly routeId: string | null;
  readonly checkpointId: string | null;
  readonly checkpointName: string | null;
  readonly scannedAt: Date;
  readonly receivedAt: Date;
  readonly outcome: ScanOutcome;
  readonly reason: string | null;
  readonly counted: boolean;
  readonly distanceM: number | null;
  readonly accuracyM: number | null;
  readonly flags: readonly string[];
};

function visitQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('checkpoint_visits as v')
    .leftJoin('checkpoints as c', (j) =>
      j.onRef('c.id', '=', 'v.checkpoint_id').onRef('c.organization_id', '=', 'v.organization_id'),
    )
    .select([
      'v.id',
      'v.shift_id',
      'v.patrol_run_id',
      'v.patrol_route_id',
      'v.checkpoint_id',
      'c.name as checkpoint_name',
      'v.scanned_at',
      'v.received_at',
      'v.verification_status',
      'v.verification_reason',
      'v.counted',
      'v.distance_m',
      'v.accuracy_m',
      'v.flags',
    ])
    .where('v.organization_id', '=', organizationId);
}

type VisitRecord = Awaited<ReturnType<ReturnType<typeof visitQuery>['executeTakeFirstOrThrow']>>;

function toVisit(r: VisitRecord): VisitRow {
  return {
    id: r.id,
    shiftId: r.shift_id,
    runId: r.patrol_run_id,
    routeId: r.patrol_route_id,
    checkpointId: r.checkpoint_id,
    checkpointName: r.checkpoint_name,
    scannedAt: r.scanned_at,
    receivedAt: r.received_at,
    outcome: r.verification_status as ScanOutcome,
    reason: r.verification_reason,
    counted: r.counted,
    distanceM: r.distance_m,
    accuracyM: r.accuracy_m,
    flags: r.flags,
  };
}

export async function visitByClientEvent(
  trx: Database,
  organizationId: string,
  deviceId: string,
  clientEventId: string,
): Promise<(VisitRow & { readonly guardId: string }) | null> {
  const row = await visitQuery(trx, organizationId)
    .select('v.guard_id')
    .where('v.device_id', '=', deviceId)
    .where('v.client_event_id', '=', clientEventId)
    .executeTakeFirst();
  return row ? { ...toVisit(row), guardId: row.guard_id } : null;
}

export async function visitsForRuns(
  trx: Database,
  organizationId: string,
  runIds: readonly string[],
): Promise<VisitRow[]> {
  if (runIds.length === 0) return [];
  const rows = await visitQuery(trx, organizationId)
    .where('v.patrol_run_id', 'in', runIds)
    .orderBy('v.scanned_at')
    .orderBy('v.id')
    .execute();
  return rows.map(toVisit);
}

export async function visitsForShift(
  trx: Database,
  organizationId: string,
  shiftId: string,
): Promise<VisitRow[]> {
  const rows = await visitQuery(trx, organizationId)
    .where('v.shift_id', '=', shiftId)
    .orderBy('v.scanned_at')
    .orderBy('v.id')
    .execute();
  return rows.map(toVisit);
}

/** The latest counting visit in the shift at or before the time, with its checkpoint's position. */
export async function previousCountingVisit(
  trx: Database,
  organizationId: string,
  shiftId: string,
  at: Date,
): Promise<{ scannedAt: Date; location: { lat: number; lng: number } | null } | null> {
  const row = await trx
    .selectFrom('checkpoint_visits as v')
    .innerJoin('checkpoints as c', (j) =>
      j.onRef('c.id', '=', 'v.checkpoint_id').onRef('c.organization_id', '=', 'v.organization_id'),
    )
    .select(['v.scanned_at', 'c.latitude', 'c.longitude'])
    .where('v.organization_id', '=', organizationId)
    .where('v.shift_id', '=', shiftId)
    .where('v.counted', '=', true)
    .where('v.scanned_at', '<=', at)
    .orderBy('v.scanned_at', 'desc')
    .orderBy('v.id', 'desc')
    .executeTakeFirst();
  if (!row) return null;
  return {
    scannedAt: row.scanned_at,
    location:
      row.latitude !== null && row.longitude !== null ? { lat: row.latitude, lng: row.longitude } : null,
  };
}

/** The checkpoint was already counted in the run (or, without a run, the shift) since the time. */
export async function countedSince(
  trx: Database,
  organizationId: string,
  scope: { runId: string } | { shiftId: string },
  checkpointId: string,
  since: Date,
  until: Date,
): Promise<boolean> {
  let query = trx
    .selectFrom('checkpoint_visits')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('checkpoint_id', '=', checkpointId)
    .where('counted', '=', true)
    .where('scanned_at', '>=', since)
    .where('scanned_at', '<=', until);
  query =
    'runId' in scope
      ? query.where('patrol_run_id', '=', scope.runId)
      : query.where('shift_id', '=', scope.shiftId);
  return (await query.limit(1).executeTakeFirst()) !== undefined;
}

/** Scans this guard sent in the last window, for the rate limit (SEC §9). */
export async function scansReceivedSince(
  trx: Database,
  organizationId: string,
  guardId: string,
  since: Date,
): Promise<number> {
  const row = await trx
    .selectFrom('checkpoint_visits')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('organization_id', '=', organizationId)
    .where('guard_id', '=', guardId)
    .where('received_at', '>=', since)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
