// SOS (PROD §11, ARCH §13.1, §15.3). The guard's routes are the `sos` class: never rate-limited,
// accepted from a suspended organization, from a phone replaced within its 72 hours, and — when the
// session can't be used — signed with the device key (INV-15; context.ts). The dashboard reads
// (audited: the SOS position is personal data), acknowledges and resolves; drills open and close.
import {
  errorEnvelopeSchema,
  sosAcknowledgeRequestSchema,
  sosCancelRequestSchema,
  sosDetailResponseSchema,
  sosDrillCurrentResponseSchema,
  sosDrillResponseSchema,
  sosDrillStartRequestSchema,
  sosLocationsRequestSchema,
  sosLocationsResponseSchema,
  sosRequestSchema,
  sosResolveRequestSchema,
  sosResponseSchema,
  sosStatusResponseSchema,
  type RoutePolicy,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { z } from 'zod';

import { auditActor, guardOf, orgOf, userOf, type RequestContext } from '../context.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  acceptSos,
  acceptSosLocations,
  acknowledgeSos,
  requestCancel,
  guardSosStatus,
  resolveSos,
  type SosGuard,
} from '../services/sos.ts';
import { currentDrill, drillById, endSosDrill, sosDetail, startSosDrill } from '../services/sos-dashboard.ts';
import { defineRoute } from './registry.ts';

const GUARD_SOS: RoutePolicy = {
  access: { kind: 'permission', permission: 'sos.activate' },
  ownership: 'guard-self',
  rateLimit: 'sos',
  audit: null,
  sos: true,
};
const GUARD_SOS_READ: RoutePolicy = {
  access: { kind: 'permission', permission: 'sos.read.own' },
  ownership: 'guard-self',
  rateLimit: 'sos',
  audit: null,
  sos: true,
};
const READ = { kind: 'permission', permission: 'sos.read' } as const;
const ACK = { kind: 'permission', permission: 'sos.ack' } as const;
const RESOLVE = { kind: 'permission', permission: 'sos.resolve' } as const;
const DRILL = { kind: 'permission', permission: 'sos.drill' } as const;
const params = z.object({ id: z.uuid() });

function sosGuard(ctx: RequestContext, appVersion: unknown): SosGuard {
  const guard = guardOf(ctx);
  return {
    organizationId: orgOf(ctx).id,
    guardId: guard.guardId,
    deviceId: guard.deviceId,
    name: guard.name,
    auth: guard.auth,
    appVersion: typeof appVersion === 'string' ? appVersion.slice(0, 40) : null,
  };
}

export const sosRoutes = [
  defineRoute({
    method: 'POST',
    url: '/api/v1/sos',
    summary:
      'Activates (or re-triggers) an SOS. Answers RECEIVED once stored; notifications go out from the worker, never inline.',
    policy: GUARD_SOS,
    body: sosRequestSchema,
    responses: { 200: sosResponseSchema, 401: errorEnvelopeSchema },
    handler: async ({ request, deps, ctx, body }) => {
      const guard = sosGuard(ctx, request.headers['x-app-version']);
      const accepted = await withTenantTransaction(deps.db, guard.organizationId, (trx) =>
        acceptSos(trx, deps, guard, body),
      );
      return {
        sosEventId: accepted.sosEventId,
        status: 'RECEIVED' as const,
        serverTime: deps.clock.now().toISOString(),
        isDrill: accepted.isDrill,
      };
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/sos/:id/status',
    summary:
      'What the server can confirm about the guard’s own SOS (PROD §11.3): each state only with its fact.',
    policy: GUARD_SOS_READ,
    params,
    responses: { 200: sosStatusResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ request, deps, ctx, params: p }) => {
      const guard = sosGuard(ctx, request.headers['x-app-version']);
      return withTenantTransaction(deps.db, guard.organizationId, (trx) =>
        guardSosStatus(trx, deps, guard, p.id),
      );
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/sos/:id/locations',
    summary: 'SOS tracking points (PROD §11.2), sent on the SOS lane; each idempotent by its clientEventId.',
    policy: GUARD_SOS,
    params,
    body: sosLocationsRequestSchema,
    responses: { 200: sosLocationsResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ request, deps, ctx, params: p, body }) => {
      const guard = sosGuard(ctx, request.headers['x-app-version']);
      return withTenantTransaction(deps.db, guard.organizationId, (trx) =>
        acceptSosLocations(trx, deps, guard, p.id, body),
      );
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/sos/:id/cancel-request',
    summary:
      '"I\'m safe / false alarm": noted on the SOS. It stays open and escalation continues (PROD §11.8).',
    policy: GUARD_SOS,
    params,
    body: sosCancelRequestSchema,
    responses: { 200: sosStatusResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ request, deps, ctx, params: p }) => {
      const guard = sosGuard(ctx, request.headers['x-app-version']);
      return withTenantTransaction(deps.db, guard.organizationId, async (trx) => {
        await requestCancel(trx, deps, guard, p.id);
        return guardSosStatus(trx, deps, guard, p.id);
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/sos/:id',
    summary:
      'One SOS for the dashboard: the guard, the position and trail, receipts and deliveries. Audited.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: 'SOS_VIEWED' },
    params,
    responses: { 200: sosDetailResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        // INV-14: the view is recorded before the position is returned.
        const sos = await sosDetail(trx, deps, org.id, p.id, async () => {
          await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
            action: 'SOS_VIEWED',
            resourceType: 'sos_event',
            resourceId: p.id,
          });
        });
        return { sos };
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/sos/:id/acknowledge',
    summary: 'Acknowledges an SOS: escalation stops and the guard is told who. Idempotent.',
    policy: { access: ACK, ownership: 'organization', rateLimit: 'default', audit: 'SOS_ACKNOWLEDGED' },
    params,
    body: sosAcknowledgeRequestSchema,
    responses: { 200: sosDetailResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p }) => {
      const org = orgOf(ctx);
      const user = userOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const { changed } = await acknowledgeSos(trx, deps, org.id, p.id, {
          userId: user.userId,
          name: user.name,
        });
        if (changed) {
          await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
            action: 'SOS_ACKNOWLEDGED',
            resourceType: 'sos_event',
            resourceId: p.id,
          });
        }
        return { sos: await sosDetail(trx, deps, org.id, p.id, () => Promise.resolve()) };
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/sos/:id/resolve',
    summary: 'Resolves an SOS with a resolution type and a note (PROD §11.4).',
    policy: { access: RESOLVE, ownership: 'organization', rateLimit: 'default', audit: 'SOS_RESOLVED' },
    params,
    body: sosResolveRequestSchema,
    responses: { 200: sosDetailResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      const user = userOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        await resolveSos(
          trx,
          deps,
          org.id,
          p.id,
          { userId: user.userId, name: user.name },
          {
            type: body.resolution,
            note: body.note,
          },
        );
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'SOS_RESOLVED',
          resourceType: 'sos_event',
          resourceId: p.id,
          reason: body.note,
          metadata: { resolution: body.resolution },
        });
        return { sos: await sosDetail(trx, deps, org.id, p.id, () => Promise.resolve()) };
      });
    },
  }),

  // ── Drills (PROD §11.10, ADV-S10) ──────────────────────────────────────────────────────────

  defineRoute({
    method: 'GET',
    url: '/api/v1/sos-drills/current',
    summary: 'The drill open now, with its guards and the members it reaches; null when none.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    responses: { 200: sosDrillCurrentResponseSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      return {
        drill: await withTenantTransaction(deps.db, org.id, (trx) => currentDrill(trx, deps, org.id)),
      };
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/sos-drills/:id',
    summary:
      'A drill, open or past, with its guards and the members it reaches: whether a drill alert alarms you.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    params,
    responses: { 200: sosDrillResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p }) => {
      const org = orgOf(ctx);
      return {
        drill: await withTenantTransaction(deps.db, org.id, (trx) => drillById(trx, deps, org.id, p.id)),
      };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/sos-drills',
    summary:
      'Opens a drill window: only the named guards’ SOS is a drill, and it reaches only the members taking part.',
    policy: { access: DRILL, ownership: 'organization', rateLimit: 'default', audit: 'SOS_DRILL_STARTED' },
    body: sosDrillStartRequestSchema,
    responses: { 201: sosDrillResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const drill = await withTenantTransaction(deps.db, org.id, async (trx) => {
        const started = await startSosDrill(trx, deps, org, userOf(ctx).userId, body);
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'SOS_DRILL_STARTED',
          resourceType: 'sos_drill',
          resourceId: started.id,
          metadata: {
            guards: started.guards.length,
            members: started.members.length,
            endsAt: started.endsAt,
          },
        });
        return started;
      });
      void reply.code(201);
      return { drill };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/sos-drills/:id/end',
    summary: 'Ends a drill window early.',
    policy: { access: DRILL, ownership: 'organization', rateLimit: 'default', audit: 'SOS_DRILL_ENDED' },
    params,
    responses: { 200: sosDrillResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const drill = await endSosDrill(trx, deps, org.id, userOf(ctx).userId, p.id);
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'SOS_DRILL_ENDED',
          resourceType: 'sos_drill',
          resourceId: p.id,
        });
        return { drill };
      });
    },
  }),
];
