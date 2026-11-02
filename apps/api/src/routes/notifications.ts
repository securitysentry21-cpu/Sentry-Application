// Notifications (PROD §11.5, §13; ARCH §13.4, §15.3): the dashboard's Web Push subscriptions, the
// receipts that make an SOS "notified" (INV-10), the test alert, and the guard phone's push token.
import {
  alertDeliveredRequestSchema,
  alertSeenRequestSchema,
  errorEnvelopeSchema,
  guardPushTokenRequestSchema,
  notificationTestResponseSchema,
  receiptResponseSchema,
  webPushConfigResponseSchema,
  webPushSubscribeRequestSchema,
  webPushSubscriptionListResponseSchema,
  webPushSubscriptionResponseSchema,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { z } from 'zod';

import { guardOf, orgOf, userOf } from '../context.ts';
import { AppError, notFound } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { isPushServiceEndpoint } from '../notify/webpush.ts';
import { setDevicePushToken } from '../repositories/guards.ts';
import { getMember } from '../repositories/memberships.ts';
import {
  deleteSubscription,
  getSubscription,
  subscriptionsOfMembers,
  upsertSubscription,
  type SubscriptionRow,
} from '../repositories/notifications.ts';
import { queueTest } from '../services/notifications.ts';
import { recordDelivered, recordSeen } from '../services/receipts.ts';
import { defineRoute } from './registry.ts';

const MEMBER = { kind: 'permission', permission: 'alerts.read' } as const;
const GUARD_SELF = { kind: 'permission', permission: 'shifts.self' } as const;
const params = z.object({ id: z.uuid() });

const subscriptionDto = (s: SubscriptionRow) => ({
  id: s.id,
  client: s.client,
  status: s.status,
  createdAt: s.createdAt.toISOString(),
  lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
});

export const notificationRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/push/config',
    summary: 'The Web Push public key the dashboard subscribes with (null until the environment has one).',
    policy: { access: MEMBER, ownership: 'organization', rateLimit: 'default', audit: null },
    responses: { 200: webPushConfigResponseSchema },
    handler: ({ deps }) => Promise.resolve({ vapidPublicKey: deps.notify.vapidPublicKey }),
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/push-subscriptions',
    summary: "Registers this browser for the member's alerts in this organization (D-04, D-26).",
    policy: { access: MEMBER, ownership: 'organization', rateLimit: 'default', audit: null },
    body: webPushSubscribeRequestSchema,
    responses: { 201: webPushSubscriptionResponseSchema, 400: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const user = userOf(ctx);
      // The sender calls this address: only real push services, never one a user chose (SSRF).
      if (!isPushServiceEndpoint(body.endpoint)) {
        throw new AppError('VALIDATION_FAILED', 'The request is invalid.', [
          { path: 'endpoint', issue: 'not a known push service' },
        ]);
      }
      const subscription = await withTenantTransaction(deps.db, org.id, (trx) =>
        upsertSubscription(trx, {
          id: uuidv7(deps.clock),
          organizationId: org.id,
          memberId: org.memberId,
          userId: user.userId,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          client: body.client,
          now: deps.clock.now(),
        }),
      );
      void reply.code(201);
      return { subscription: subscriptionDto(subscription) };
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/push-subscriptions',
    summary: "The member's own registered browsers in this organization.",
    policy: { access: MEMBER, ownership: 'organization', rateLimit: 'default', audit: null },
    responses: { 200: webPushSubscriptionListResponseSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const rows = await withTenantTransaction(deps.db, org.id, (trx) =>
        subscriptionsOfMembers(trx, org.id, [org.memberId]),
      );
      return { subscriptions: rows.map(subscriptionDto) };
    },
  }),

  defineRoute({
    method: 'DELETE',
    url: '/api/v1/push-subscriptions/:id',
    summary: "Removes one of the member's own registered browsers.",
    policy: { access: MEMBER, ownership: 'organization', rateLimit: 'default', audit: null },
    params,
    responses: { 204: z.null(), 404: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, params: p }) => {
      const org = orgOf(ctx);
      await withTenantTransaction(deps.db, org.id, async (trx) => {
        const sub = await getSubscription(trx, org.id, p.id);
        // Someone else's browser doesn't exist for this member.
        if (!sub || sub.memberId !== org.memberId) throw notFound();
        await deleteSubscription(trx, org.id, p.id);
      });
      void reply.code(204);
      return null;
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/notifications/test',
    summary: '"Send me a test SOS alert" (PROD §11.5): to the member’s own browsers and SOS number.',
    policy: { access: MEMBER, ownership: 'organization', rateLimit: 'report', audit: null },
    responses: { 202: notificationTestResponseSchema },
    handler: async ({ reply, deps, ctx }) => {
      const org = orgOf(ctx);
      deps.rateLimiter.hit('report', 'user', userOf(ctx).userId);
      const queued = await withTenantTransaction(deps.db, org.id, async (trx) => {
        const member = await getMember(trx, org.id, org.memberId);
        if (!member) throw notFound();
        return queueTest(trx, deps, org.id, { memberId: member.id, alertPhone: member.alertPhone });
      });
      void reply.code(202);
      return queued;
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/alerts/:id/seen',
    summary: 'Display receipt: this dashboard is showing the alarm on screen (makes an SOS "notified").',
    policy: { access: MEMBER, ownership: 'organization', rateLimit: 'default', audit: null },
    params,
    body: alertSeenRequestSchema,
    responses: { 200: receiptResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      const recorded = await withTenantTransaction(deps.db, org.id, (trx) =>
        recordSeen(trx, deps, org.id, p.id, userOf(ctx).userId, body.client),
      );
      return { recorded };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/alerts/:id/delivered',
    summary: "Delivery receipt from the dashboard's push service worker: the push reached this device.",
    policy: { access: MEMBER, ownership: 'organization', rateLimit: 'default', audit: null },
    params,
    body: alertDeliveredRequestSchema,
    responses: { 200: receiptResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      const recorded = await withTenantTransaction(deps.db, org.id, (trx) =>
        recordDelivered(trx, deps, org.id, p.id, userOf(ctx).userId, body.deliveryId),
      );
      return { recorded };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/me/push-token',
    summary: 'The guard phone\'s Firebase token (D-26), for "SOS acknowledged" and shift notices.',
    policy: { access: GUARD_SELF, ownership: 'guard-self', rateLimit: 'default', audit: null },
    body: guardPushTokenRequestSchema,
    responses: { 204: z.null() },
    handler: async ({ reply, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      await withTenantTransaction(deps.db, org.id, (trx) =>
        setDevicePushToken(trx, org.id, guard.deviceId, body.token, deps.clock.now()),
      );
      void reply.code(204);
      return null;
    },
  }),
];
