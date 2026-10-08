// Alerts (PROD §12, ARCH §15.3). Dispatchers and above see and acknowledge; supervisors and above
// resolve and dismiss. Every manual change is audited. Guards can't change alert state.
import {
  alertDetailResponseSchema,
  alertDismissRequestSchema,
  alertListQuerySchema,
  alertListResponseSchema,
  alertResolveRequestSchema,
  alertResponseSchema,
  errorEnvelopeSchema,
  type AuditAction,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { z } from 'zod';

import { auditActor, orgOf, userOf, type RequestContext } from '../context.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, notFound } from '../errors.ts';
import { alertEvents, getAlert, listAlerts, type AlertRow } from '../repositories/alerts.ts';
import { recordAudit } from '../repositories/audit.ts';
import { acknowledge, alertDto, dismiss, resolveManually, type ManualOutcome } from '../services/alerts.ts';
import { defineRoute } from './registry.ts';

const READ = { kind: 'permission', permission: 'alerts.read' } as const;
const ACK = { kind: 'permission', permission: 'alerts.acknowledge' } as const;
const RESOLVE = { kind: 'permission', permission: 'alerts.resolve' } as const;
const params = z.object({ id: z.uuid() });

async function change(
  deps: AppDeps,
  ctx: RequestContext,
  id: string,
  audit: AuditAction,
  run: (
    trx: Parameters<Parameters<typeof withTenantTransaction>[2]>[0],
    alert: AlertRow,
    userId: string,
  ) => Promise<ManualOutcome>,
  reason: string | null,
) {
  const org = orgOf(ctx);
  const actor = userOf(ctx);
  return withTenantTransaction(deps.db, org.id, async (trx) => {
    // Locked: two people acting at once are applied one after the other (AL03).
    const alert = await getAlert(trx, org.id, id, true);
    if (!alert) throw notFound();
    const outcome = await run(trx, alert, actor.userId);
    if (!outcome.ok) {
      throw new AppError(
        'ALERT_INVALID_TRANSITION',
        outcome.reason === 'NOT_DISMISSIBLE'
          ? 'SOS and critical incident alerts must be resolved, not dismissed.'
          : 'This alert is already closed.',
      );
    }
    if (outcome.changed) {
      await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
        action: audit,
        resourceType: 'alert',
        resourceId: alert.id,
        reason,
        metadata: { type: alert.type },
      });
    }
    const updated = await getAlert(trx, org.id, id);
    if (!updated) throw notFound();
    return { alert: alertDto(updated) };
  });
}

export const alertRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/alerts',
    summary: 'Alerts, newest first: active (open or acknowledged), closed, or all.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    query: alertListQuerySchema,
    responses: { 200: alertListResponseSchema },
    handler: async ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      const rows = await withTenantTransaction(deps.db, org.id, (trx) =>
        listAlerts(trx, org.id, { status: query.status, shiftId: query.shiftId, limit: query.limit }),
      );
      return { alerts: rows.map(alertDto) };
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/alerts/:id',
    summary: 'One alert with its history.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    params,
    responses: { 200: alertDetailResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const alert = await getAlert(trx, org.id, p.id);
        if (!alert) throw notFound();
        const events = await alertEvents(trx, org.id, alert.id);
        return {
          alert: alertDto(alert),
          events: events.map((e) => ({
            id: e.id,
            type: e.type,
            actorType: e.actor_type as 'USER' | 'SYSTEM',
            actorUserId: e.actor_user_id,
            note: e.note,
            payload: (e.payload ?? {}) as Record<string, unknown>,
            createdAt: e.created_at.toISOString(),
          })),
        };
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/alerts/:id/acknowledge',
    summary: 'Acknowledges an alert. Idempotent: a second acknowledgement shows who was first.',
    policy: { access: ACK, ownership: 'organization', rateLimit: 'default', audit: 'ALERT_ACKNOWLEDGED' },
    params,
    responses: { 200: alertResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: ({ deps, ctx, params: p }) =>
      change(
        deps,
        ctx,
        p.id,
        'ALERT_ACKNOWLEDGED',
        (trx, alert, userId) => acknowledge(trx, deps, orgOf(ctx).id, alert, userId),
        null,
      ),
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/alerts/:id/resolve',
    summary: 'Resolves an alert, with an optional note.',
    policy: { access: RESOLVE, ownership: 'organization', rateLimit: 'default', audit: 'ALERT_RESOLVED' },
    params,
    body: alertResolveRequestSchema,
    responses: { 200: alertResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: ({ deps, ctx, params: p, body }) =>
      change(
        deps,
        ctx,
        p.id,
        'ALERT_RESOLVED',
        (trx, alert, userId) => resolveManually(trx, deps, orgOf(ctx).id, alert, userId, body.note ?? null),
        body.note ?? null,
      ),
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/alerts/:id/dismiss',
    summary: 'Dismisses an alert with a reason. SOS and critical incident alerts cannot be dismissed.',
    policy: { access: RESOLVE, ownership: 'organization', rateLimit: 'default', audit: 'ALERT_DISMISSED' },
    params,
    body: alertDismissRequestSchema,
    responses: { 200: alertResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: ({ deps, ctx, params: p, body }) =>
      change(
        deps,
        ctx,
        p.id,
        'ALERT_DISMISSED',
        (trx, alert, userId) => dismiss(trx, deps, orgOf(ctx).id, alert, userId, body.reason),
        body.reason,
      ),
  }),
];
