// Web Push subscriptions, recipients and notification deliveries (ARCH §6.3, §13.4). Always inside
// a tenant transaction, except the sweeps, which run as system_worker and read organization IDs only.
import type { Database } from '@sentryops/db';

export type Recipient = {
  readonly memberId: string;
  readonly userId: string;
  readonly name: string;
  readonly role: string;
  readonly alertPhone: string | null;
};

/** ACTIVE members holding one of these roles (PROD §11.4, §12.5). */
export async function membersWithRoles(
  trx: Database,
  organizationId: string,
  roles: readonly string[],
): Promise<Recipient[]> {
  if (roles.length === 0) return [];
  const rows = await trx
    .selectFrom('organization_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .where('m.organization_id', '=', organizationId)
    .where('m.status', '=', 'ACTIVE')
    .where('u.status', '=', 'ACTIVE')
    .where('m.role', 'in', [...roles])
    .select(['m.id', 'm.user_id', 'u.name', 'm.role', 'm.alert_phone'])
    .orderBy('m.id')
    .execute();
  return rows.map((r) => ({
    memberId: r.id,
    userId: r.user_id,
    name: r.name,
    role: r.role,
    alertPhone: r.alert_phone,
  }));
}

export async function setMemberAlertPhone(
  trx: Database,
  organizationId: string,
  memberId: string,
  phone: string | null,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('organization_members')
    .set((eb) => ({ alert_phone: phone, version: eb('version', '+', 1), updated_at: now }))
    .where('organization_id', '=', organizationId)
    .where('id', '=', memberId)
    .execute();
}

// ── Web Push subscriptions ────────────────────────────────────────────────────────────────────

export type SubscriptionRow = {
  readonly id: string;
  readonly memberId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly client: 'DESKTOP' | 'PHONE';
  readonly status: 'ACTIVE' | 'INVALID';
  readonly createdAt: Date;
  readonly lastSuccessAt: Date | null;
};

const subscriptionColumns = [
  'id',
  'member_id',
  'endpoint',
  'p256dh',
  'auth',
  'client',
  'status',
  'created_at',
  'last_success_at',
] as const;

type RawSubscription = {
  id: string;
  member_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  client: string;
  status: string;
  created_at: Date;
  last_success_at: Date | null;
};

function toSubscription(r: RawSubscription): SubscriptionRow {
  return {
    id: r.id,
    memberId: r.member_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    client: r.client === 'PHONE' ? 'PHONE' : 'DESKTOP',
    status: r.status === 'INVALID' ? 'INVALID' : 'ACTIVE',
    createdAt: r.created_at,
    lastSuccessAt: r.last_success_at,
  };
}

/**
 * One row per browser endpoint in the organization. Subscribing again from the same browser (or a
 * browser handed to another member) moves the endpoint to this member with fresh keys.
 */
export async function upsertSubscription(
  trx: Database,
  s: {
    id: string;
    organizationId: string;
    memberId: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    client: 'DESKTOP' | 'PHONE';
    now: Date;
  },
): Promise<SubscriptionRow> {
  const row = await trx
    .insertInto('web_push_subscriptions')
    .values({
      id: s.id,
      organization_id: s.organizationId,
      member_id: s.memberId,
      user_id: s.userId,
      endpoint: s.endpoint,
      p256dh: s.p256dh,
      auth: s.auth,
      client: s.client,
      status: 'ACTIVE',
      created_at: s.now,
      updated_at: s.now,
    })
    .onConflict((oc) =>
      oc.columns(['organization_id', 'endpoint']).doUpdateSet({
        member_id: s.memberId,
        user_id: s.userId,
        p256dh: s.p256dh,
        auth: s.auth,
        client: s.client,
        status: 'ACTIVE',
        failure_count: 0,
        updated_at: s.now,
      }),
    )
    .returning([...subscriptionColumns])
    .executeTakeFirstOrThrow();
  return toSubscription(row);
}

export async function subscriptionsOfMembers(
  trx: Database,
  organizationId: string,
  memberIds: readonly string[],
): Promise<SubscriptionRow[]> {
  if (memberIds.length === 0) return [];
  const rows = await trx
    .selectFrom('web_push_subscriptions')
    .where('organization_id', '=', organizationId)
    .where('member_id', 'in', [...memberIds])
    .where('status', '=', 'ACTIVE')
    .select([...subscriptionColumns])
    .execute();
  return rows.map(toSubscription);
}

export async function getSubscription(trx: Database, organizationId: string, id: string) {
  const row = await trx
    .selectFrom('web_push_subscriptions')
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .select([...subscriptionColumns])
    .executeTakeFirst();
  return row ? toSubscription(row) : null;
}

export async function deleteSubscription(trx: Database, organizationId: string, id: string): Promise<void> {
  await trx
    .deleteFrom('web_push_subscriptions')
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

export async function recordSubscriptionResult(
  trx: Database,
  organizationId: string,
  id: string,
  outcome: 'SUCCESS' | 'FAILURE' | 'INVALID',
  now: Date,
): Promise<void> {
  await trx
    .updateTable('web_push_subscriptions')
    .set((eb) =>
      outcome === 'SUCCESS'
        ? { last_success_at: now, failure_count: 0, updated_at: now }
        : outcome === 'INVALID'
          ? { status: 'INVALID', updated_at: now }
          : { failure_count: eb('failure_count', '+', 1), updated_at: now },
    )
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

/** The guard's ACTIVE phone and its Firebase token, if it registered one (D-26). */
export async function guardPushTarget(trx: Database, organizationId: string, guardId: string) {
  const row = await trx
    .selectFrom('guard_devices')
    .where('organization_id', '=', organizationId)
    .where('guard_id', '=', guardId)
    .where('status', '=', 'ACTIVE')
    .where('push_token', 'is not', null)
    .select(['id', 'push_token'])
    .executeTakeFirst();
  return row?.push_token ? { deviceId: row.id, token: row.push_token } : null;
}

export async function devicePushToken(trx: Database, organizationId: string, deviceId: string) {
  const row = await trx
    .selectFrom('guard_devices')
    .where('organization_id', '=', organizationId)
    .where('id', '=', deviceId)
    .where('status', '=', 'ACTIVE')
    .select('push_token')
    .executeTakeFirst();
  return row?.push_token ?? null;
}

// ── Deliveries ────────────────────────────────────────────────────────────────────────────────

export type DeliveryTopic = 'ALERT' | 'SOS' | 'SOS_GUARD' | 'SHIFT' | 'TEST';
export type DeliveryChannel = 'WEB_PUSH' | 'PUSH' | 'SMS';
export type DeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'SUPPRESSED';

export type DeliveryInsert = {
  readonly id: string;
  readonly organizationId: string;
  readonly topic: DeliveryTopic;
  readonly alertId: string | null;
  readonly sosEventId: string | null;
  readonly channel: DeliveryChannel;
  readonly recipientMemberId: string | null;
  readonly recipientGuardId: string | null;
  readonly subscriptionId: string | null;
  readonly recipientDeviceId: string | null;
  readonly recipientPhone: string | null;
  readonly escalationLevel: number;
  readonly isDrill: boolean;
  readonly status: 'QUEUED' | 'SUPPRESSED';
  readonly errorCode: string | null;
  readonly dedupeKey: string;
  readonly maxAttempts: number;
  readonly title: string;
  readonly body: string;
  readonly linkPath: string | null;
  readonly at: Date;
};

/** Inserts a delivery unless one with the same key exists (a retried job never double-sends). */
export async function insertDelivery(trx: Database, d: DeliveryInsert): Promise<boolean> {
  const row = await trx
    .insertInto('notification_deliveries')
    .values({
      id: d.id,
      organization_id: d.organizationId,
      topic: d.topic,
      alert_id: d.alertId,
      sos_event_id: d.sosEventId,
      channel: d.channel,
      recipient_member_id: d.recipientMemberId,
      recipient_guard_id: d.recipientGuardId,
      subscription_id: d.subscriptionId,
      recipient_device_id: d.recipientDeviceId,
      recipient_phone: d.recipientPhone,
      escalation_level: d.escalationLevel,
      is_drill: d.isDrill,
      status: d.status,
      error_code: d.errorCode,
      dedupe_key: d.dedupeKey,
      max_attempts: d.maxAttempts,
      next_attempt_at: d.at,
      title: d.title,
      body: d.body,
      link_path: d.linkPath,
      created_at: d.at,
      updated_at: d.at,
    })
    .onConflict((oc) => oc.columns(['organization_id', 'dedupe_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** A text to this number about this alert within the window (PROD §11.9: one per 60 s). */
export async function smsSentRecently(
  trx: Database,
  organizationId: string,
  alertId: string,
  phone: string,
  since: Date,
): Promise<boolean> {
  const row = await trx
    .selectFrom('notification_deliveries')
    .where('organization_id', '=', organizationId)
    .where('alert_id', '=', alertId)
    .where('channel', '=', 'SMS')
    .where('recipient_phone', '=', phone)
    .where('status', '<>', 'SUPPRESSED')
    .where('created_at', '>=', since)
    .select('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** Texts that count toward the monthly cap (PROD §13: SOS texts never do). */
export async function nonSosSmsSince(trx: Database, organizationId: string, since: Date): Promise<number> {
  const row = await trx
    .selectFrom('notification_deliveries')
    .where('organization_id', '=', organizationId)
    .where('channel', '=', 'SMS')
    .where('topic', '<>', 'SOS')
    .where('status', '<>', 'SUPPRESSED')
    .where('created_at', '>=', since)
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function organizationsWithDueDeliveries(sweep: Database, now: Date): Promise<string[]> {
  const rows = await sweep
    .selectFrom('notification_deliveries')
    .where('status', '=', 'QUEUED')
    .where('next_attempt_at', '<=', now)
    .select('organization_id')
    .distinct()
    .execute();
  return rows.map((r) => r.organization_id);
}

export type ClaimedDelivery = {
  readonly id: string;
  readonly topic: DeliveryTopic;
  readonly alertId: string | null;
  readonly sosEventId: string | null;
  readonly channel: DeliveryChannel;
  readonly recipientMemberId: string | null;
  readonly subscriptionId: string | null;
  readonly recipientDeviceId: string | null;
  readonly recipientPhone: string | null;
  readonly isDrill: boolean;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly title: string;
  readonly body: string;
  readonly linkPath: string | null;
  readonly createdAt: Date;
};

/**
 * Takes up to `limit` due deliveries for sending: counts the attempt and holds them for `holdMs`,
 * so another worker (or this one after a crash) only picks them up once the hold lapses.
 */
export async function claimDueDeliveries(
  trx: Database,
  organizationId: string,
  now: Date,
  limit: number,
  holdMs: number,
): Promise<ClaimedDelivery[]> {
  const due = await trx
    .selectFrom('notification_deliveries')
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'QUEUED')
    .where('next_attempt_at', '<=', now)
    .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<', now)]))
    .select('id')
    .orderBy('next_attempt_at')
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();
  if (due.length === 0) return [];
  const rows = await trx
    .updateTable('notification_deliveries')
    .set((eb) => ({
      attempt: eb('attempt', '+', 1),
      locked_until: new Date(now.getTime() + holdMs),
      updated_at: now,
    }))
    .where('organization_id', '=', organizationId)
    .where(
      'id',
      'in',
      due.map((d) => d.id),
    )
    .returning([
      'id',
      'topic',
      'alert_id',
      'sos_event_id',
      'channel',
      'recipient_member_id',
      'subscription_id',
      'recipient_device_id',
      'recipient_phone',
      'is_drill',
      'attempt',
      'max_attempts',
      'title',
      'body',
      'link_path',
      'created_at',
    ])
    .execute();
  return rows.map((r) => ({
    id: r.id,
    topic: r.topic as DeliveryTopic,
    alertId: r.alert_id,
    sosEventId: r.sos_event_id,
    channel: r.channel as DeliveryChannel,
    recipientMemberId: r.recipient_member_id,
    subscriptionId: r.subscription_id,
    recipientDeviceId: r.recipient_device_id,
    recipientPhone: r.recipient_phone,
    isDrill: r.is_drill,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    title: r.title,
    body: r.body,
    linkPath: r.link_path,
    createdAt: r.created_at,
  }));
}

export async function finishDelivery(
  trx: Database,
  organizationId: string,
  id: string,
  outcome:
    | { status: 'SENT'; provider: string; providerMessageId: string | null }
    | { status: 'FAILED' | 'SUPPRESSED'; provider: string | null; errorCode: string }
    | { status: 'QUEUED'; provider: string; errorCode: string; nextAttemptAt: Date },
  now: Date,
): Promise<void> {
  await trx
    .updateTable('notification_deliveries')
    .set({
      status: outcome.status,
      provider: outcome.provider,
      locked_until: null,
      updated_at: now,
      ...(outcome.status === 'SENT'
        ? { sent_at: now, provider_message_id: outcome.providerMessageId, error_code: null }
        : outcome.status === 'QUEUED'
          ? { error_code: outcome.errorCode, next_attempt_at: outcome.nextAttemptAt }
          : { error_code: outcome.errorCode, ...(outcome.status === 'FAILED' ? { failed_at: now } : {}) }),
    })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

/** A delivery the receiving device reports (ARCH §13.1 `/delivered`): this user's, for this alert. */
export async function deliveryForReceipt(
  trx: Database,
  organizationId: string,
  id: string,
  alertId: string,
  userId: string,
) {
  const row = await trx
    .selectFrom('notification_deliveries as d')
    .innerJoin('organization_members as m', (j) =>
      j.onRef('m.organization_id', '=', 'd.organization_id').onRef('m.id', '=', 'd.recipient_member_id'),
    )
    .where('d.organization_id', '=', organizationId)
    .where('d.id', '=', id)
    .where('d.alert_id', '=', alertId)
    .where('m.user_id', '=', userId)
    .select(['d.id', 'd.status', 'd.channel'])
    .forUpdate('d')
    .executeTakeFirst();
  return row ?? null;
}

export async function markDelivered(
  trx: Database,
  organizationId: string,
  id: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('notification_deliveries')
    .set({ status: 'DELIVERED', delivered_at: now, updated_at: now })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .where('status', 'in', ['QUEUED', 'SENT'])
    .execute();
}

/** People a provider accepted a push or text for, about this alert (ALERT_SENT's count). */
export async function sentRecipientCount(
  trx: Database,
  organizationId: string,
  alertId: string,
): Promise<number> {
  const row = await trx
    .selectFrom('notification_deliveries')
    .where('organization_id', '=', organizationId)
    .where('alert_id', '=', alertId)
    .where('status', 'in', ['SENT', 'DELIVERED'])
    .select((eb) =>
      eb.fn
        .count<string>(eb.fn.coalesce(eb.cast<string>('recipient_member_id', 'text'), 'recipient_phone'))
        .distinct()
        .as('n'),
    )
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** What went to whom about an SOS, for its page: member names, emergency contacts masked. */
export async function deliveriesForAlert(trx: Database, organizationId: string, alertId: string) {
  return trx
    .selectFrom('notification_deliveries as d')
    .leftJoin('organization_members as m', (j) =>
      j.onRef('m.organization_id', '=', 'd.organization_id').onRef('m.id', '=', 'd.recipient_member_id'),
    )
    .leftJoin('users as u', 'u.id', 'm.user_id')
    .where('d.organization_id', '=', organizationId)
    .where('d.alert_id', '=', alertId)
    .select([
      'd.channel',
      'd.status',
      'd.escalation_level',
      'd.sent_at',
      'd.error_code',
      'd.recipient_phone',
      'u.name as member_name',
      'd.created_at',
    ])
    .orderBy('d.created_at')
    .orderBy('d.id')
    .limit(500)
    .execute();
}

export async function hasActiveSubscriptions(trx: Database, organizationId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('web_push_subscriptions')
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'ACTIVE')
    .select('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** A delivery about this alert that a provider accepted (the canary's push check). */
export async function acceptedDeliveryFor(trx: Database, organizationId: string, alertId: string) {
  const row = await trx
    .selectFrom('notification_deliveries')
    .where('organization_id', '=', organizationId)
    .where('alert_id', '=', alertId)
    .where('status', 'in', ['SENT', 'DELIVERED'])
    .select('id')
    .executeTakeFirst();
  return row?.id ?? null;
}
