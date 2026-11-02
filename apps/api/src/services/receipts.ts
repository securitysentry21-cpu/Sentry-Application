// Receipts (ARCH §13.1, INV-10): the only facts that make an SOS NOTIFIED. A dashboard reports the
// alarm on its screen (`/seen`, a display receipt); the dashboard's push service worker reports a push
// that reached its device (`/delivered`, a delivery receipt). One of each per person per alert.
import type { Database } from '@sentryops/db';

import type { AppDeps } from '../deps.ts';
import { notFound } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { getAlert, hasReceipt, insertAlertEvent } from '../repositories/alerts.ts';
import { deliveryForReceipt, markDelivered } from '../repositories/notifications.ts';
import { markSosFact } from '../repositories/sos.ts';
import { publish } from './realtime.ts';

async function notified(trx: Database, deps: AppDeps, organizationId: string, sosEventId: string | null) {
  if (sosEventId && (await markSosFact(trx, organizationId, sosEventId, 'notified_at', deps.clock.now()))) {
    await publish(trx, deps, organizationId, 'sos.updated', { sosEventId });
  }
}

/** POST /alerts/:id/seen: this dashboard is showing the alarm (PROD §11.3 "showing in the control room"). */
export async function recordSeen(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  alertId: string,
  userId: string,
  client: 'DESKTOP' | 'PHONE',
): Promise<boolean> {
  const alert = await getAlert(trx, organizationId, alertId);
  if (!alert) throw notFound();
  if (await hasReceipt(trx, organizationId, alertId, 'SEEN', userId)) return false;
  await insertAlertEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId,
    alertId,
    type: 'SEEN',
    actorUserId: userId,
    payload: { channel: 'DASHBOARD', client },
    at: deps.clock.now(),
  });
  await notified(trx, deps, organizationId, alert.sosEventId);
  return true;
}

/** POST /alerts/:id/delivered: a push reached this person's device ("reached 2 supervisors' phones"). */
export async function recordDelivered(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  alertId: string,
  userId: string,
  deliveryId: string,
): Promise<boolean> {
  const alert = await getAlert(trx, organizationId, alertId);
  if (!alert) throw notFound();
  // Only the recipient's own delivery of this alert counts; anything else is not found.
  const delivery = await deliveryForReceipt(trx, organizationId, deliveryId, alertId, userId);
  if (!delivery) throw notFound();
  await markDelivered(trx, organizationId, delivery.id, deps.clock.now());
  if (await hasReceipt(trx, organizationId, alertId, 'NOTIFIED', userId)) return false;
  await insertAlertEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId,
    alertId,
    type: 'NOTIFIED',
    actorUserId: userId,
    payload: { channel: delivery.channel, deliveryId: delivery.id },
    at: deps.clock.now(),
  });
  await notified(trx, deps, organizationId, alert.sosEventId);
  return true;
}
