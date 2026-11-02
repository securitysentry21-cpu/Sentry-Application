// Notifications (PROD §11.5, §13; ARCH §13.4) — dashboard ↔ API contract: Web Push subscriptions,
// the receipts that make an SOS "notified" (INV-10), and the test alert.
import { z } from 'zod';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });

export const DASHBOARD_CLIENTS = ['DESKTOP', 'PHONE'] as const;

/** The VAPID public key the browser subscribes with; null until the environment has one. */
export const webPushConfigResponseSchema = z.object({ vapidPublicKey: z.string().nullable() });

export const webPushSubscribeRequestSchema = z.strictObject({
  endpoint: z.url().max(1000),
  keys: z.strictObject({
    p256dh: z.string().min(80).max(100),
    auth: z.string().min(16).max(30),
  }),
  client: z.enum(DASHBOARD_CLIENTS),
});
export type WebPushSubscribeRequest = z.infer<typeof webPushSubscribeRequestSchema>;

export const webPushSubscriptionSchema = z.object({
  id: uuid,
  client: z.enum(DASHBOARD_CLIENTS),
  status: z.enum(['ACTIVE', 'INVALID']),
  createdAt: instant,
  lastSuccessAt: instant.nullable(),
});
export const webPushSubscriptionResponseSchema = z.object({ subscription: webPushSubscriptionSchema });
export const webPushSubscriptionListResponseSchema = z.object({
  subscriptions: z.array(webPushSubscriptionSchema),
});

/** A dashboard is showing the alarm on screen (display receipt, ARCH §13.1). */
export const alertSeenRequestSchema = z.strictObject({ client: z.enum(DASHBOARD_CLIENTS) });
/** The dashboard's service worker received the push on this device (delivery receipt). */
export const alertDeliveredRequestSchema = z.strictObject({ deliveryId: uuid });
export const receiptResponseSchema = z.object({ recorded: z.boolean() });

/** "Send me a test SOS alert" (PROD §11.5): to the caller's own devices and SOS number. */
export const notificationTestResponseSchema = z.object({
  webPush: z.int(),
  sms: z.int(),
});

/**
 * What a Web Push message carries, as JSON, to the dashboard's service worker. Lock-screen safe: no
 * coordinates and no incident text (PROD §13).
 */
export const webPushPayloadSchema = z.object({
  v: z.literal(1),
  kind: z.enum(['SOS', 'ALERT', 'TEST']),
  title: z.string(),
  body: z.string(),
  /** A dashboard path, opened when the notification is tapped. */
  url: z.string(),
  organizationId: uuid,
  alertId: uuid.nullable(),
  deliveryId: uuid,
  drill: z.boolean(),
});
export type WebPushPayload = z.infer<typeof webPushPayloadSchema>;
