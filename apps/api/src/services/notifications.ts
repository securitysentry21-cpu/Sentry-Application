// The notification engine (ARCH §13.3–§13.4; PROD §11.4, §12.5, §13). Deliveries are rows written
// in the transaction that decided them; a worker sends them. "Sent" never means "seen": a provider
// accepting a message is ALERT_SENT; only a screen or a person's device makes an SOS NOTIFIED
// (INV-10).
import type { Database } from '@sentryops/db';
import {
  isValidLadder,
  plainLine,
  shortName,
  sosNotificationText,
  sosSmsText,
  stepActions,
  stepDueAt,
  type EscalationLadder,
  type EscalationRole,
} from '@sentryops/domain';

import type { AppDeps } from '../deps.ts';
import { uuidv7 } from '../ids.ts';
import type { SendResult } from '../notify/providers.ts';
import { insertAlertEvent, updateAlert, type AlertRow } from '../repositories/alerts.ts';
import { setDevicePushToken } from '../repositories/guards.ts';
import { numberSetting, organizationKind, organizationSettings } from '../repositories/organizations.ts';
import {
  claimDueDeliveries,
  devicePushToken,
  finishDelivery,
  getSubscription,
  guardPushTarget,
  insertDelivery,
  membersWithRoles,
  nonSosSmsSince,
  recordSubscriptionResult,
  smsSentRecently,
  subscriptionsOfMembers,
  type ClaimedDelivery,
  type DeliveryInsert,
  type Recipient,
} from '../repositories/notifications.ts';
import { drillMemberIds, getSos, markSosFact } from '../repositories/sos.ts';
import { publish } from './realtime.ts';

/** ARCH §13.4: SOS — 3 attempts within 2 minutes; others — 5 within 30 minutes. */
const RETRY_DELAYS_S = { SOS: [15, 45], OTHER: [60, 180, 480, 1080] } as const;
const MAX_ATTEMPTS = { SOS: 3, OTHER: 5 } as const;
/** PROD §11.9: no more than one text per recipient per SOS per 60 s. */
const SMS_THROTTLE_MS = 60_000;
/** How long the sender holds a claimed delivery before another run may take it again. */
const CLAIM_HOLD_MS = 60_000;

const DEFAULT_LADDER: EscalationLadder = {
  steps: [
    {
      atSeconds: 0,
      dashboardAlarm: true,
      webPushTo: ['SUPERVISOR', 'DISPATCHER', 'ADMIN'],
      smsTo: ['SUPERVISOR'],
      smsEmergencyContacts: false,
    },
  ],
  repeatEverySeconds: 120,
};

export function ladderOf(settings: Record<string, unknown>): EscalationLadder {
  const value = settings['sos.escalation'] as EscalationLadder | undefined;
  return value && Array.isArray(value.steps) && isValidLadder(value) ? value : DEFAULT_LADDER;
}

type RoutingRule = { roles: EscalationRole[]; channels: string[]; escalate: boolean };

function routingOf(settings: Record<string, unknown>, severity: string): RoutingRule {
  const routing = settings['alerts.routing'] as Record<string, RoutingRule> | undefined;
  return routing?.[severity] ?? { roles: [], channels: ['DASHBOARD'], escalate: false };
}

/** SOS always climbs the ladder; other alerts when their severity's routing says so (PROD §12.5). */
export function escalates(
  alert: Pick<AlertRow, 'type' | 'severity'>,
  settings: Record<string, unknown>,
): boolean {
  return alert.type === 'SOS_ACTIVATED' || routingOf(settings, alert.severity).escalate;
}

/** When the first step after opening is due, for an alert that escalates; null otherwise. */
export function firstEscalationAt(
  alert: Pick<AlertRow, 'type' | 'severity'>,
  settings: Record<string, unknown>,
  openedAt: Date,
): Date | null {
  return escalates(alert, settings) ? stepDueAt(ladderOf(settings), openedAt, 1) : null;
}

/** Plain headline per alert type for pushes and texts: no names, places or report text (PROD §13). */
const ALERT_HEADLINES: Readonly<Record<string, string>> = {
  SOS_ACTIVATED: 'SOS',
  INCIDENT_CRITICAL: 'Critical incident',
  INCIDENT_HIGH: 'High-severity incident',
  GUARD_LEFT_SITE: 'Guard left site',
  TRACKING_DISABLED: 'Tracking disabled',
  DEVICE_OFFLINE: 'Device offline',
  LOCATION_STALE: 'Location stale',
  SHIFT_NOT_STARTED: 'Shift not started',
  SHIFT_MISSED: 'Shift missed',
  CHECKPOINT_MISSED: 'Patrol round incomplete',
  SUSPICIOUS_LOCATION: 'Suspicious location',
  STARTED_OFF_SITE: 'Started off site',
  SHIFT_OVERRUN: 'Shift overrun',
  LOW_BATTERY: 'Low battery',
  DEVICE_CHANGED: 'Device changed',
};

function alertText(alert: AlertRow, again: boolean): { title: string; body: string } {
  if (alert.type === 'SOS_ACTIVATED') {
    return sosNotificationText({
      guardName: alert.guardName ?? 'Guard',
      siteName: alert.siteName,
      drill: alert.isDrill,
      again,
      guardDisabled: alert.details.guardDisabled === true,
    });
  }
  const prefix = alert.isDrill ? '[DRILL] ' : '';
  const who = alert.guardName ? ` — ${plainLine(shortName(alert.guardName), 60)}` : '';
  const where = alert.siteName ? ` — ${plainLine(alert.siteName, 80)}` : '';
  return {
    title: `${prefix}${ALERT_HEADLINES[alert.type] ?? 'Alert'}${who}${where}`.slice(0, 200),
    body: 'Open the dashboard for details.',
  };
}

const linkOf = (alert: AlertRow) =>
  alert.sosEventId ? `/sos/${alert.sosEventId}` : `/alerts?id=${alert.id}`;

/** The members an alert may reach: in a drill, only its participants (ADV-S10, owner decision). */
async function eligibleMembers(
  trx: Database,
  organizationId: string,
  alert: AlertRow,
  roles: readonly string[],
): Promise<Recipient[]> {
  const members = await membersWithRoles(trx, organizationId, roles);
  if (!alert.isDrill) return members;
  const drillId = alert.sosEventId ? (await getSos(trx, organizationId, alert.sosEventId))?.drillId : null;
  // Demo and canary organizations have no real people (PROD §17): their own members are the test
  // recipients. A customer organization's drill reaches its participants and nobody else.
  if (!drillId) return (await organizationKind(trx, organizationId)) === 'CUSTOMER' ? [] : members;
  const participants = new Set(await drillMemberIds(trx, organizationId, drillId));
  return members.filter((m) => participants.has(m.memberId));
}

export type StepReason = 'OPENED' | 'REOPENED' | 'ESCALATED' | 'PRESSED_AGAIN';

/**
 * Queues one step of an alert's notifications, in the caller's transaction: the ladder's step for an
 * escalating alert, the routing rule for any other (opening only). Idempotent per step.
 */
export async function queueAlertStep(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  alert: AlertRow,
  level: number,
  reason: StepReason,
): Promise<{ webPush: number; sms: number }> {
  const settings = await organizationSettings(trx, organizationId);
  const sos = alert.type === 'SOS_ACTIVATED';
  let webPushRoles: readonly string[] = [];
  let smsRoles: readonly string[] = [];
  let contacts = false;
  if (escalates(alert, settings)) {
    const actions = stepActions(ladderOf(settings), level);
    webPushRoles = actions.webPushTo;
    smsRoles = actions.smsTo;
    contacts = actions.smsEmergencyContacts;
  } else if (level === 0) {
    const rule = routingOf(settings, alert.severity);
    if (rule.channels.includes('WEB_PUSH')) webPushRoles = rule.roles;
    if (rule.channels.includes('SMS')) smsRoles = rule.roles;
  }
  // Drills never text emergency contacts: they are people outside the drill (ADV-S10).
  if (alert.isDrill) contacts = false;

  const now = deps.clock.now();
  const { title, body } = alertText(alert, reason === 'PRESSED_AGAIN');
  const topic = sos ? 'SOS' : 'ALERT';
  const maxAttempts = sos ? MAX_ATTEMPTS.SOS : MAX_ATTEMPTS.OTHER;
  // A restarted ladder (an SOS pressed again after acknowledgement) or a reopened alert is a new
  // episode: its steps are new messages, while a retried step of the same episode is not.
  const episode = (alert.escalationStartedAt ?? alert.lastTriggeredAt).getTime();
  const base = {
    organizationId,
    topic,
    alertId: alert.id,
    sosEventId: alert.sosEventId,
    escalationLevel: level,
    isDrill: alert.isDrill,
    maxAttempts,
    title,
    body,
    linkPath: linkOf(alert),
    at: now,
  } as const;
  let webPush = 0;
  let sms = 0;

  const pushMembers = await eligibleMembers(trx, organizationId, alert, webPushRoles);
  for (const sub of await subscriptionsOfMembers(
    trx,
    organizationId,
    pushMembers.map((m) => m.memberId),
  )) {
    const inserted = await insertDelivery(trx, {
      ...base,
      id: uuidv7(deps.clock),
      channel: 'WEB_PUSH',
      recipientMemberId: sub.memberId,
      recipientGuardId: null,
      subscriptionId: sub.id,
      recipientDeviceId: null,
      recipientPhone: null,
      status: 'QUEUED',
      errorCode: null,
      dedupeKey: `${alert.id}:${episode}:${sub.id}:WEB_PUSH:${level}`,
    });
    if (inserted) webPush++;
  }

  const textTargets: { memberId: string | null; phone: string }[] = [];
  for (const m of await eligibleMembers(trx, organizationId, alert, smsRoles)) {
    if (m.alertPhone) textTargets.push({ memberId: m.memberId, phone: m.alertPhone });
  }
  if (contacts) {
    const numbers = settings['sos.emergency_contacts'];
    for (const phone of Array.isArray(numbers) ? numbers : []) {
      if (typeof phone === 'string') textTargets.push({ memberId: null, phone });
    }
  }
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let capLeft = sos
    ? Number.POSITIVE_INFINITY
    : numberSetting(settings, 'notifications.non_sos_sms_monthly_cap', 3000) -
      (textTargets.length > 0 ? await nonSosSmsSince(trx, organizationId, monthStart) : 0);
  const seen = new Set<string>();
  for (const target of textTargets) {
    if (seen.has(target.phone)) continue;
    seen.add(target.phone);
    let errorCode: string | null = null;
    if (
      await smsSentRecently(
        trx,
        organizationId,
        alert.id,
        target.phone,
        new Date(now.getTime() - SMS_THROTTLE_MS),
      )
    ) {
      errorCode = 'THROTTLED';
    } else if (capLeft <= 0) {
      errorCode = 'MONTHLY_CAP';
    }
    const delivery: DeliveryInsert = {
      ...base,
      id: uuidv7(deps.clock),
      channel: 'SMS',
      recipientMemberId: target.memberId,
      recipientGuardId: null,
      subscriptionId: null,
      recipientDeviceId: null,
      recipientPhone: target.phone,
      status: errorCode ? 'SUPPRESSED' : 'QUEUED',
      errorCode,
      dedupeKey: `${alert.id}:${episode}:${target.memberId ?? target.phone}:SMS:${level}`,
    };
    if (await insertDelivery(trx, delivery)) {
      if (!errorCode) {
        sms++;
        capLeft--;
      }
    }
  }
  return { webPush, sms };
}

/** A push to the guard's own phone (D-26): "SOS acknowledged", shift changes. Lock-screen safe. */
export async function queueGuardPush(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  guardId: string,
  message: {
    topic: 'SOS_GUARD' | 'SHIFT';
    title: string;
    body: string;
    dedupeKey: string;
    sosEventId?: string | null;
    urgent?: boolean;
  },
): Promise<boolean> {
  const target = await guardPushTarget(trx, organizationId, guardId);
  if (!target) return false;
  return insertDelivery(trx, {
    id: uuidv7(deps.clock),
    organizationId,
    topic: message.topic,
    alertId: null,
    sosEventId: message.sosEventId ?? null,
    channel: 'PUSH',
    recipientMemberId: null,
    recipientGuardId: guardId,
    subscriptionId: null,
    recipientDeviceId: target.deviceId,
    recipientPhone: null,
    escalationLevel: 0,
    isDrill: false,
    status: 'QUEUED',
    errorCode: null,
    dedupeKey: message.dedupeKey,
    maxAttempts: message.urgent ? MAX_ATTEMPTS.SOS : MAX_ATTEMPTS.OTHER,
    title: message.title.slice(0, 200),
    body: message.body.slice(0, 500),
    linkPath: null,
    at: deps.clock.now(),
  });
}

/** "Send me a test SOS alert" (PROD §11.5): to the caller's own browsers and SOS number. */
export async function queueTest(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  member: { memberId: string; alertPhone: string | null },
): Promise<{ webPush: number; sms: number }> {
  const now = deps.clock.now();
  const base = {
    organizationId,
    topic: 'TEST',
    alertId: null,
    sosEventId: null,
    recipientMemberId: member.memberId,
    recipientGuardId: null,
    recipientDeviceId: null,
    escalationLevel: 0,
    isDrill: false,
    status: 'QUEUED',
    errorCode: null,
    maxAttempts: MAX_ATTEMPTS.SOS,
    title: 'TEST — SOS alert test',
    body: 'If you can read this, SOS alerts reach this device.',
    linkPath: '/settings/notifications',
    at: now,
  } as const;
  let webPush = 0;
  for (const sub of await subscriptionsOfMembers(trx, organizationId, [member.memberId])) {
    await insertDelivery(trx, {
      ...base,
      id: uuidv7(deps.clock),
      channel: 'WEB_PUSH',
      subscriptionId: sub.id,
      recipientPhone: null,
      dedupeKey: `test:${now.getTime()}:${sub.id}`,
    });
    webPush++;
  }
  let sms = 0;
  if (member.alertPhone) {
    await insertDelivery(trx, {
      ...base,
      id: uuidv7(deps.clock),
      channel: 'SMS',
      subscriptionId: null,
      recipientPhone: member.alertPhone,
      dedupeKey: `test:${now.getTime()}:${member.memberId}:SMS`,
    });
    sms++;
  }
  return { webPush, sms };
}

// ── Escalation (ARCH §13.3) ──────────────────────────────────────────────────────────────────

/** Applies the next ladder step to every alert due one, in the organization's transaction. */
export async function escalateDue(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  due: readonly AlertRow[],
): Promise<number> {
  if (due.length === 0) return 0;
  const settings = await organizationSettings(trx, organizationId);
  const ladder = ladderOf(settings);
  const now = deps.clock.now();
  for (const alert of due) {
    const level = alert.escalationLevel + 1;
    await queueAlertStep(trx, deps, organizationId, alert, level, 'ESCALATED');
    await insertAlertEvent(trx, {
      id: uuidv7(deps.clock),
      organizationId,
      alertId: alert.id,
      type: 'ESCALATED',
      actorUserId: null,
      payload: { level },
      at: now,
    });
    const startedAt = alert.escalationStartedAt ?? alert.openedAt;
    await updateAlert(
      trx,
      organizationId,
      alert.id,
      { escalationLevel: level, nextEscalationAt: stepDueAt(ladder, startedAt, level + 1) },
      now,
    );
    await publish(trx, deps, organizationId, 'alert.updated', { alertId: alert.id });
  }
  return due.length;
}

// ── Sending (ARCH §13.4) ─────────────────────────────────────────────────────────────────────

export type SendOutcome = { readonly channel: string; readonly ok: boolean; readonly code: string | null };

export async function claimDue(trx: Database, deps: AppDeps, organizationId: string, limit = 50) {
  return claimDueDeliveries(trx, organizationId, deps.clock.now(), limit, CLAIM_HOLD_MS);
}

/** Sends one claimed delivery through its provider. Never throws: every failure is a result. */
export async function sendOne(
  deps: AppDeps,
  organizationId: string,
  d: ClaimedDelivery,
  target: { endpoint?: string; p256dh?: string; auth?: string; token?: string; smsText?: string },
): Promise<SendResult & { provider: string }> {
  try {
    if (d.channel === 'WEB_PUSH') {
      const sender = deps.notify.webPush;
      if (!sender)
        return { ok: false, retryable: false, code: 'WEB_PUSH_NOT_CONFIGURED', provider: 'webpush' };
      if (!target.endpoint || !target.p256dh || !target.auth) {
        return { ok: false, retryable: false, code: 'NO_SUBSCRIPTION', provider: 'webpush' };
      }
      const payload = JSON.stringify({
        v: 1,
        kind: d.topic === 'SOS' ? 'SOS' : d.topic === 'TEST' ? 'TEST' : 'ALERT',
        title: d.title,
        body: d.body,
        url: d.linkPath ?? '/',
        organizationId,
        alertId: d.alertId,
        deliveryId: d.id,
        drill: d.isDrill,
      });
      const result = await sender.send({
        endpoint: target.endpoint,
        p256dh: target.p256dh,
        auth: target.auth,
        payload,
        urgency: d.topic === 'SOS' || d.topic === 'TEST' ? 'high' : 'normal',
        ttlS: d.topic === 'SOS' ? 600 : 3600,
      });
      return { ...result, provider: 'webpush' };
    }
    if (d.channel === 'PUSH') {
      const sender = deps.notify.fcm;
      if (!sender) return { ok: false, retryable: false, code: 'FCM_NOT_CONFIGURED', provider: 'fcm' };
      if (!target.token) return { ok: false, retryable: false, code: 'NO_PUSH_TOKEN', provider: 'fcm' };
      const result = await sender.send({
        token: target.token,
        title: d.title,
        body: d.body,
        data: { kind: d.topic, ...(d.sosEventId ? { sosEventId: d.sosEventId } : {}) },
        urgent: d.topic === 'SOS_GUARD',
      });
      return { ...result, provider: 'fcm' };
    }
    const sms = deps.notify.sms;
    const to = d.recipientPhone ?? '';
    // Outside production, texts go only to allow-listed numbers (ARCH §13.4, SEC §20 #30).
    if (deps.config.NODE_ENV !== 'production' && !deps.config.SMS_ALLOWED_NUMBERS.includes(to)) {
      return { ok: false, retryable: false, code: 'NOT_ALLOW_LISTED', provider: sms.name };
    }
    const result = await sms.send(to, target.smsText ?? `${d.title}.`);
    return { ...result, provider: sms.name };
  } catch {
    return { ok: false, retryable: true, code: 'SEND_ERROR', provider: d.channel.toLowerCase() };
  }
}

/** What a claimed delivery needs from the database before it can be sent (outside the transaction). */
export async function sendTarget(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  d: ClaimedDelivery,
): Promise<{ endpoint?: string; p256dh?: string; auth?: string; token?: string; smsText?: string }> {
  if (d.channel === 'WEB_PUSH' && d.subscriptionId) {
    const sub = await getSubscription(trx, organizationId, d.subscriptionId);
    return sub && sub.status === 'ACTIVE'
      ? { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }
      : {};
  }
  if (d.channel === 'PUSH' && d.recipientDeviceId) {
    const token = await devicePushToken(trx, organizationId, d.recipientDeviceId);
    return token ? { token } : {};
  }
  if (d.channel === 'SMS') {
    const link = `${new URL(deps.config.PUBLIC_ORIGIN).origin}${d.linkPath ?? '/'}`;
    let position: { lat: number; lng: number } | null = null;
    if (d.sosEventId) {
      const settings = await organizationSettings(trx, organizationId);
      // Off by default (PROD §13); taken at send time, so the text carries the newest SOS position.
      if (settings['sos.sms_include_coordinates'] === true) {
        const sos = await getSos(trx, organizationId, d.sosEventId);
        if (sos?.latitude != null && sos.longitude != null)
          position = { lat: sos.latitude, lng: sos.longitude };
      }
    }
    return { smsText: sosSmsText({ text: { title: d.title, body: d.body }, link, position }) };
  }
  return {};
}

/** Records a send's result; the first accepted SOS message makes the SOS ALERT_SENT (INV-10). */
export async function recordSend(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  d: ClaimedDelivery,
  result: SendResult & { provider: string },
): Promise<SendOutcome> {
  const now = deps.clock.now();
  if (result.ok) {
    await finishDelivery(
      trx,
      organizationId,
      d.id,
      { status: 'SENT', provider: result.provider, providerMessageId: result.providerMessageId },
      now,
    );
    if (d.subscriptionId)
      await recordSubscriptionResult(trx, organizationId, d.subscriptionId, 'SUCCESS', now);
    if (
      d.sosEventId &&
      d.topic === 'SOS' &&
      (await markSosFact(trx, organizationId, d.sosEventId, 'alert_sent_at', now))
    ) {
      await publish(trx, deps, organizationId, 'sos.updated', { sosEventId: d.sosEventId });
    }
    return { channel: d.channel, ok: true, code: null };
  }
  const delays = d.topic === 'SOS' || d.topic === 'SOS_GUARD' ? RETRY_DELAYS_S.SOS : RETRY_DELAYS_S.OTHER;
  const delay = delays[d.attempt - 1];
  if (result.retryable && d.attempt < d.maxAttempts && delay !== undefined) {
    await finishDelivery(
      trx,
      organizationId,
      d.id,
      {
        status: 'QUEUED',
        provider: result.provider,
        errorCode: result.code,
        nextAttemptAt: new Date(now.getTime() + delay * 1000),
      },
      now,
    );
  } else {
    const status = result.code === 'NOT_ALLOW_LISTED' ? 'SUPPRESSED' : 'FAILED';
    await finishDelivery(
      trx,
      organizationId,
      d.id,
      { status, provider: result.provider, errorCode: result.code },
      now,
    );
  }
  if (d.subscriptionId) {
    await recordSubscriptionResult(
      trx,
      organizationId,
      d.subscriptionId,
      result.invalidRecipient ? 'INVALID' : 'FAILURE',
      now,
    );
  }
  if (d.recipientDeviceId && result.invalidRecipient) {
    // ARCH §13.4: an invalid token is dropped; the phone registers a new one when it has it.
    await setDevicePushToken(trx, organizationId, d.recipientDeviceId, null, now);
  }
  return { channel: d.channel, ok: false, code: result.code };
}
