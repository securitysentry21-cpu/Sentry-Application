// What the platform operator's commands read and change in one organization (D-19, runbooks). Always
// inside a tenant transaction. These queries return counts, ages, IDs and codes: never coordinates,
// incident text, titles, phone numbers or the content of a quarantined item (SEC §15).
import type { Database } from '@sentryops/db';
import { sql } from 'kysely';

export type DeliveryCount = {
  readonly channel: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly count: number;
  readonly isDrill: boolean;
};

export async function deliveryCounts(
  trx: Database,
  organizationId: string,
  since: Date,
): Promise<DeliveryCount[]> {
  const rows = await trx
    .selectFrom('notification_deliveries')
    .select(['channel', 'status', 'error_code', 'is_drill'])
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('organization_id', '=', organizationId)
    .where('created_at', '>=', since)
    .groupBy(['channel', 'status', 'error_code', 'is_drill'])
    .orderBy('channel')
    .orderBy('status')
    .execute();
  return rows.map((r) => ({
    channel: r.channel,
    status: r.status,
    errorCode: r.error_code,
    isDrill: r.is_drill,
    count: Number(r.n),
  }));
}

/** When the oldest delivery still waiting to be sent was queued (null: nothing waits). */
export async function oldestQueuedDelivery(trx: Database, organizationId: string): Promise<Date | null> {
  const row = await trx
    .selectFrom('notification_deliveries')
    .select((eb) => eb.fn.min('created_at').as('oldest'))
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'QUEUED')
    .executeTakeFirst();
  return row?.oldest ?? null;
}

export type OpenSos = {
  readonly status: string;
  readonly isDrill: boolean;
  readonly activatedAt: Date;
  readonly alertSent: boolean;
  readonly notified: boolean;
};

/** SOS events not yet resolved: how long they have waited and how far the alerting got (INV-10). */
export async function openSos(trx: Database, organizationId: string): Promise<OpenSos[]> {
  const rows = await trx
    .selectFrom('sos_events')
    .select(['status', 'is_drill', 'activated_at', 'alert_sent_at', 'notified_at'])
    .where('organization_id', '=', organizationId)
    .where('status', '!=', 'RESOLVED')
    .orderBy('activated_at')
    .execute();
  return rows.map((r) => ({
    status: r.status,
    isDrill: r.is_drill,
    activatedAt: r.activated_at,
    alertSent: r.alert_sent_at !== null,
    notified: r.notified_at !== null,
  }));
}

export type QuarantinedRow = {
  readonly id: string;
  readonly deviceId: string;
  readonly batchId: string;
  readonly clientEventId: string;
  readonly itemType: string | null;
  readonly errorCode: string;
  readonly createdAt: Date;
  readonly replayedAt: Date | null;
};

/** Only the item's type is read out of its JSON: the rest can hold positions and incident text. */
export async function quarantinedRows(
  trx: Database,
  organizationId: string,
  options: { readonly onlyOpen: boolean; readonly id?: string; readonly limit: number },
): Promise<QuarantinedRow[]> {
  let query = trx
    .selectFrom('quarantined_items')
    .select(['id', 'device_id', 'batch_id', 'client_event_id', 'error_code', 'created_at', 'replayed_at'])
    .select(sql<string | null>`item->>'type'`.as('item_type'))
    .where('organization_id', '=', organizationId);
  if (options.onlyOpen) query = query.where('replayed_at', 'is', null);
  if (options.id) query = query.where('id', '=', options.id);
  const rows = await query.orderBy('created_at').orderBy('id').limit(options.limit).execute();
  return rows.map((r) => ({
    id: r.id,
    deviceId: r.device_id,
    batchId: r.batch_id,
    clientEventId: r.client_event_id,
    itemType: r.item_type,
    errorCode: r.error_code,
    createdAt: r.created_at,
    replayedAt: r.replayed_at,
  }));
}

/** The raw item, for the replay only. Never printed. */
export async function quarantinedItem(trx: Database, organizationId: string, id: string): Promise<unknown> {
  const row = await trx
    .selectFrom('quarantined_items')
    .select('item')
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .executeTakeFirst();
  return row?.item;
}

export async function markReplayed(
  trx: Database,
  organizationId: string,
  id: string,
  at: Date,
): Promise<void> {
  await trx
    .updateTable('quarantined_items')
    .set({ replayed_at: at })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .where('replayed_at', 'is', null)
    .execute();
}

export type ReplayDevice = {
  readonly deviceId: string;
  readonly guardId: string;
  readonly userId: string | null;
  readonly status: string;
  readonly revokedReason: string | null;
  readonly revokedAt: Date | null;
};

export async function replayDevice(
  trx: Database,
  organizationId: string,
  deviceId: string,
): Promise<ReplayDevice | null> {
  const row = await trx
    .selectFrom('guard_devices as d')
    .innerJoin('guards as g', (join) =>
      join.onRef('g.organization_id', '=', 'd.organization_id').onRef('g.id', '=', 'd.guard_id'),
    )
    .select(['d.id', 'd.guard_id', 'g.user_id', 'd.status', 'd.revoked_reason', 'd.revoked_at'])
    .where('d.organization_id', '=', organizationId)
    .where('d.id', '=', deviceId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    deviceId: row.id,
    guardId: row.guard_id,
    userId: row.user_id,
    status: row.status,
    revokedReason: row.revoked_reason,
    revokedAt: row.revoked_at,
  };
}
