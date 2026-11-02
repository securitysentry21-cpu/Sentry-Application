// Patrols (PROD §9, ARCH §11, §15.2): routes and their schedules, runs and the scans in them, and the
// guard's own rounds. Scans themselves arrive through POST /sync/batch (services/patrols.ts). No
// response carries a guard's coordinates: distances and accuracy only.
import {
  checkpointVisitListQuerySchema,
  checkpointVisitListResponseSchema,
  errorEnvelopeSchema,
  guardPatrolsQuerySchema,
  guardPatrolsResponseSchema,
  patrolRouteCreateRequestSchema,
  patrolRouteListResponseSchema,
  patrolRoutePatchRequestSchema,
  patrolRouteSchema,
  patrolRunDetailResponseSchema,
  patrolRunListQuerySchema,
  patrolRunListResponseSchema,
} from '@sentryops/contracts';
import { withTenantTransaction, type Database } from '@sentryops/db';
import { runProgress } from '@sentryops/domain';
import { z } from 'zod';

import { auditActor, guardOf, orgOf, userOf } from '../context.ts';
import { AppError, notFound } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  checkpointsInOtherScheduledRoutes,
  getRoute,
  getRun,
  insertRoute,
  listRoutes,
  listRuns,
  lockSiteRoutes,
  replaceRouteStops,
  runsForShift,
  stopsForRoutes,
  updateRoute,
  visitsForRuns,
  visitsForShift,
  type PatrolRouteRow,
  type PatrolRunRow,
  type RouteStopRow,
  type VisitRow,
} from '../repositories/patrols.ts';
import { getShift } from '../repositories/shifts.ts';
import { getSite, listCheckpoints } from '../repositories/sites.ts';
import { onRouteChanged } from '../services/patrols.ts';
import { defineRoute } from './registry.ts';

const READ = { kind: 'permission', permission: 'patrols.read' } as const;
const WRITE = { kind: 'permission', permission: 'patrols.write' } as const;
const DAY_MS = 86_400_000;
/** A run list covers at most a month. */
const MAX_RANGE_MS = 31 * DAY_MS;
/** A scan that reached the server this long after it was made was sent from the phone's queue. */
const LATE_AFTER_MS = 5 * 60_000;

export function routeDto(r: PatrolRouteRow) {
  return {
    id: r.id,
    siteId: r.siteId,
    name: r.name,
    description: r.description,
    enforceOrder: r.enforceOrder,
    schedule:
      r.intervalMinutes !== null && r.completionWindowMinutes !== null
        ? {
            intervalMinutes: r.intervalMinutes,
            firstRunOffsetMinutes: r.firstRunOffsetMinutes,
            completionWindowMinutes: r.completionWindowMinutes,
          }
        : null,
    status: r.status,
    checkpoints: r.stops.map((s) => ({
      checkpointId: s.checkpointId,
      name: s.name,
      sequence: s.sequence,
      required: s.required,
    })),
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
  };
}

function runDto(run: PatrolRunRow, stops: readonly RouteStopRow[], visits: readonly VisitRow[]) {
  const progress = runProgress(stops, visits.map(asRunVisit));
  return {
    id: run.id,
    shiftId: run.shiftId,
    guard: { id: run.guardId, displayName: run.guardName },
    site: { id: run.siteId, name: run.siteName, timezone: run.siteTimezone },
    route: { id: run.routeId, name: run.routeName },
    sequenceNo: run.sequenceNo,
    dueAt: run.dueAt.toISOString(),
    windowEndsAt: run.windowEndsAt.toISOString(),
    status: run.status,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    closedAt: run.closedAt?.toISOString() ?? null,
    requiredCount: run.requiredCount,
    countedCount: run.countedCount,
    unconfirmedCount: run.unconfirmedCount,
    missing:
      run.status === 'CANCELLED'
        ? []
        : stops.filter((s) => s.required && !progress.done.has(s.checkpointId)).map((s) => s.name),
  };
}

const asRunVisit = (v: VisitRow) => ({
  checkpointId: v.checkpointId ?? '',
  outcome: v.outcome,
  counted: v.counted,
  scannedAtMs: v.scannedAt.getTime(),
});

function visitDto(v: VisitRow) {
  return {
    id: v.id,
    shiftId: v.shiftId,
    runId: v.runId,
    checkpoint: v.checkpointId && v.checkpointName ? { id: v.checkpointId, name: v.checkpointName } : null,
    scannedAt: v.scannedAt.toISOString(),
    receivedAt: v.receivedAt.toISOString(),
    outcome: v.outcome,
    reason: v.reason,
    counted: v.counted,
    distanceM: v.distanceM,
    accuracyM: v.accuracyM,
    flags: [...v.flags],
    late: v.receivedAt.getTime() - v.scannedAt.getTime() > LATE_AFTER_MS,
  };
}

/** Runs with what each still misses, from their routes' stops and their visits. */
async function runDtos(trx: Database, organizationId: string, runs: readonly PatrolRunRow[]) {
  const stops = await stopsForRoutes(trx, organizationId, [...new Set(runs.map((r) => r.routeId))]);
  const visits = await visitsForRuns(
    trx,
    organizationId,
    runs.map((r) => r.id),
  );
  const byRun = new Map<string, VisitRow[]>();
  for (const v of visits) if (v.runId) byRun.set(v.runId, [...(byRun.get(v.runId) ?? []), v]);
  return runs.map((r) => runDto(r, stops.get(r.routeId) ?? [], byRun.get(r.id) ?? []));
}

type StopInput = { checkpointId: string; required: boolean };

/**
 * PROD §5.3, §9.1: a route's checkpoints belong to its site and are listed once; an active route's
 * checkpoints are active (an inactive one's label is refused, so its rounds could never complete);
 * a checkpoint is in at most one scheduled route; a schedule needs a required checkpoint. Another
 * organization's checkpoint is unknown here, like one that doesn't exist (ADV-T04).
 */
async function checkStops(
  trx: Database,
  organizationId: string,
  siteId: string,
  routeId: string | null,
  stops: readonly StopInput[],
  route: { readonly active: boolean; readonly scheduled: boolean },
): Promise<void> {
  const known = new Map((await listCheckpoints(trx, organizationId, siteId)).map((c) => [c.id, c]));
  const details = stops.flatMap((s, i) =>
    known.has(s.checkpointId)
      ? []
      : [{ path: `checkpoints.${i}.checkpointId`, issue: 'not a checkpoint of this site' }],
  );
  if (details.length > 0)
    throw new AppError('VALIDATION_FAILED', 'A checkpoint is not at this site.', details);
  if (!route.active) return;
  const inactive = stops.filter((s) => known.get(s.checkpointId)?.status !== 'ACTIVE');
  if (inactive.length > 0) {
    const names = inactive.map((s) => known.get(s.checkpointId)?.name ?? s.checkpointId).join(', ');
    throw new AppError(
      'VALIDATION_FAILED',
      `An active route can't include an inactive checkpoint: ${names}.`,
      [{ path: 'checkpoints', issue: 'checkpoint not active' }],
    );
  }
  if (!route.scheduled) return;
  if (!stops.some((s) => s.required)) {
    throw new AppError('VALIDATION_FAILED', 'A scheduled route needs at least one required checkpoint.', [
      { path: 'checkpoints', issue: 'no required checkpoint' },
    ]);
  }
  const taken = await checkpointsInOtherScheduledRoutes(
    trx,
    organizationId,
    stops.map((s) => s.checkpointId),
    routeId,
  );
  if (taken.length > 0) {
    const names = taken.map((id) => known.get(id)?.name ?? id).join(', ');
    throw new AppError('VALIDATION_FAILED', `Already in another scheduled route: ${names}.`, [
      { path: 'checkpoints', issue: 'a checkpoint can be in only one scheduled route' },
    ]);
  }
}

const siteParams = z.object({ id: z.uuid() });
const idParams = z.object({ id: z.uuid() });

export const patrolRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/sites/:id/patrol-routes',
    summary: "A site's patrol routes with their checkpoints in order.",
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    params: siteParams,
    responses: { 200: patrolRouteListResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const site = await getSite(trx, org.id, params.id);
        if (!site) throw notFound();
        return { routes: (await listRoutes(trx, org.id, site.id)).map(routeDto) };
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/sites/:id/patrol-routes',
    summary: 'Creates a patrol route: on demand, or with a schedule. Active shifts at the site get its runs.',
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'PATROL_ROUTE_CREATED' },
    params: siteParams,
    body: patrolRouteCreateRequestSchema,
    responses: { 201: patrolRouteSchema, 400: errorEnvelopeSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params, body, reply }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const route = await withTenantTransaction(deps.db, org.id, async (trx) => {
        const site = await getSite(trx, org.id, params.id);
        if (!site) throw notFound();
        await lockSiteRoutes(trx, org.id, site.id);
        await checkStops(trx, org.id, site.id, null, body.checkpoints, {
          active: true,
          scheduled: body.schedule !== null,
        });
        const id = uuidv7(deps.clock);
        await insertRoute(trx, {
          id,
          organizationId: org.id,
          siteId: site.id,
          name: body.name,
          description: body.description ?? null,
          enforceOrder: body.enforceOrder,
          intervalMinutes: body.schedule?.intervalMinutes ?? null,
          firstRunOffsetMinutes: body.schedule?.firstRunOffsetMinutes ?? 0,
          completionWindowMinutes: body.schedule?.completionWindowMinutes ?? null,
          userId: actor.userId,
          now: deps.clock.now(),
        });
        await replaceRouteStops(trx, {
          organizationId: org.id,
          siteId: site.id,
          routeId: id,
          stops: body.checkpoints.map((s) => ({ id: uuidv7(deps.clock), ...s })),
        });
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'PATROL_ROUTE_CREATED',
          resourceType: 'patrol_route',
          resourceId: id,
          metadata: {
            siteId: site.id,
            checkpoints: body.checkpoints.length,
            scheduled: body.schedule !== null,
          },
        });
        await onRouteChanged(trx, deps, org.id, site.id, id);
        return getRoute(trx, org.id, id);
      });
      if (!route) throw notFound();
      void reply.code(201);
      return routeDto(route);
    },
  }),

  defineRoute({
    method: 'PATCH',
    url: '/api/v1/patrol-routes/:id',
    summary: "Edits a route; active shifts' runs that are not yet due follow the change.",
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'PATROL_ROUTE_UPDATED' },
    params: idParams,
    body: patrolRoutePatchRequestSchema,
    responses: {
      200: patrolRouteSchema,
      400: errorEnvelopeSchema,
      404: errorEnvelopeSchema,
      409: errorEnvelopeSchema,
    },
    handler: async ({ deps, ctx, params, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const current = await getRoute(trx, org.id, params.id);
        if (!current) throw notFound();
        await lockSiteRoutes(trx, org.id, current.siteId);
        const route = await getRoute(trx, org.id, params.id, true);
        if (!route) throw notFound();
        const { version, checkpoints, ...changes } = body;
        const stops =
          checkpoints ?? route.stops.map((s) => ({ checkpointId: s.checkpointId, required: s.required }));
        const active = (changes.status ?? route.status) === 'ACTIVE';
        const scheduled =
          active &&
          (changes.schedule !== undefined ? changes.schedule !== null : route.intervalMinutes !== null);
        await checkStops(trx, org.id, route.siteId, route.id, stops, { active, scheduled });
        const ok = await updateRoute(trx, {
          organizationId: org.id,
          id: route.id,
          version,
          userId: actor.userId,
          now: deps.clock.now(),
          changes,
        });
        if (!ok) {
          throw new AppError(
            'VERSION_CONFLICT',
            'This route was changed by someone else.',
            undefined,
            undefined,
            routeDto(route),
          );
        }
        if (checkpoints) {
          await replaceRouteStops(trx, {
            organizationId: org.id,
            siteId: route.siteId,
            routeId: route.id,
            stops: checkpoints.map((s) => ({ id: uuidv7(deps.clock), ...s })),
          });
        }
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'PATROL_ROUTE_UPDATED',
          resourceType: 'patrol_route',
          resourceId: route.id,
          metadata: { fields: [...Object.keys(changes), ...(checkpoints ? ['checkpoints'] : [])] },
        });
        await onRouteChanged(trx, deps, org.id, route.siteId, route.id);
        const updated = await getRoute(trx, org.id, route.id);
        if (!updated) throw notFound();
        return routeDto(updated);
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/patrol-runs',
    summary: 'Patrol runs due in a range (default: the last and next 24 hours), newest first.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    query: patrolRunListQuerySchema,
    responses: { 200: patrolRunListResponseSchema, 400: errorEnvelopeSchema },
    handler: async ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      const now = deps.clock.now().getTime();
      const from = query.from ? new Date(query.from) : new Date(now - DAY_MS);
      const to = query.to ? new Date(query.to) : new Date(now + DAY_MS);
      if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_RANGE_MS) {
        throw new AppError('VALIDATION_FAILED', 'Choose a range of up to 31 days.', [
          { path: 'to', issue: 'must be after from, at most 31 days later' },
        ]);
      }
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const runs = await listRuns(trx, org.id, {
          shiftId: query.shiftId,
          siteId: query.siteId,
          guardId: query.guardId,
          status: query.status,
          from,
          to,
          limit: query.limit,
        });
        return { runs: await runDtos(trx, org.id, runs) };
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/patrol-runs/:id',
    summary: 'One run: its checkpoints in order, what was done, and every scan attached to it.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    params: idParams,
    responses: { 200: patrolRunDetailResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const run = await getRun(trx, org.id, params.id);
        if (!run) throw notFound();
        const stops = (await stopsForRoutes(trx, org.id, [run.routeId])).get(run.routeId) ?? [];
        const visits = await visitsForRuns(trx, org.id, [run.id]);
        const progress = runProgress(stops, visits.map(asRunVisit));
        return {
          run: runDto(run, stops, visits),
          enforceOrder: run.enforceOrder,
          checkpoints: stops.map((s) => ({
            checkpointId: s.checkpointId,
            name: s.name,
            sequence: s.sequence,
            required: s.required,
            location: s.location,
            done: progress.done.get(s.checkpointId) ?? null,
          })),
          visits: visits.map(visitDto),
        };
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/checkpoint-visits',
    summary: 'Every scan in a shift, run or not, in scan order: failed ones included.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    query: checkpointVisitListQuerySchema,
    responses: { 200: checkpointVisitListResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const shift = await getShift(trx, org.id, query.shiftId);
        if (!shift) throw notFound();
        return { visits: (await visitsForShift(trx, org.id, shift.id)).map(visitDto) };
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/me/patrols',
    summary: "The guard's rounds in their own shift: due times, checkpoints in order, what is done.",
    policy: {
      access: { kind: 'permission', permission: 'patrols.read.assigned' },
      ownership: 'guard-self',
      rateLimit: 'default',
      audit: null,
    },
    query: guardPatrolsQuerySchema,
    responses: { 200: guardPatrolsResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const shift = await getShift(trx, org.id, query.shiftId);
        // Another guard's shift is not found (ADV-A03).
        if (!shift || shift.guardId !== guard.guardId) throw notFound();
        const runs = await runsForShift(trx, org.id, shift.id);
        const stops = await stopsForRoutes(trx, org.id, [...new Set(runs.map((r) => r.routeId))]);
        const visits = await visitsForRuns(
          trx,
          org.id,
          runs.map((r) => r.id),
        );
        return {
          serverTime: deps.clock.now().toISOString(),
          shiftId: shift.id,
          runs: runs.map((run) => {
            const mine = stops.get(run.routeId) ?? [];
            const progress = runProgress(mine, visits.filter((v) => v.runId === run.id).map(asRunVisit));
            return {
              id: run.id,
              routeName: run.routeName,
              sequenceNo: run.sequenceNo,
              dueAt: run.dueAt.toISOString(),
              windowEndsAt: run.windowEndsAt.toISOString(),
              status: run.status,
              requiredCount: run.requiredCount,
              countedCount: run.countedCount,
              enforceOrder: run.enforceOrder,
              checkpoints: mine.map((s) => ({
                checkpointId: s.checkpointId,
                name: s.name,
                sequence: s.sequence,
                required: s.required,
                done: progress.done.get(s.checkpointId) ?? null,
              })),
            };
          }),
        };
      });
    },
  }),
];
