// The outbox, the realtime replay buffer and open dashboard streams (ARCH §14, §16.1; PROD §11.5).
// Everything here runs in a tenant transaction as app_runtime, except the two sweeps at the end,
// which run as system_worker and only list organizations with work to do.
import type { RealtimeEventType } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import { sql } from 'kysely';

/** The channel API instances LISTEN on. Payloads are organization IDs only. */
export const REALTIME_CHANNEL = 'sentry_realtime';

export type OutboxRow = {
  id: string;
  topic: RealtimeEventType;
  payload: Record<string, string>;
  createdAt: Date;
};
export type RealtimeRow = {
  seq: number;
  type: RealtimeEventType;
  payload: Record<string, string>;
  createdAt: Date;
};

/** Written in the same transaction as the change it reports (ARCH §16.1). IDs only. */
export async function enqueue(
  trx: Database,
  input: {
    id: string;
    organizationId: string;
    topic: RealtimeEventType;
    payload: Record<string, string>;
    at: Date;
  },
): Promise<void> {
  await trx
    .insertInto('outbox')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      topic: input.topic,
      payload: JSON.stringify(input.payload),
      created_at: input.at,
    })
    .execute();
}

// ── The dispatcher ──────────────────────────────────────────────────────────────────────────

/**
 * One dispatcher at a time per organization: the sequence is read and extended under this lock, so
 * it only ever grows, in commit order (ARCH §14).
 */
export async function lockOrganizationSequence(trx: Database, organizationId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`realtime:${organizationId}`}, 0))`.execute(trx);
}

export async function pendingOutbox(
  trx: Database,
  organizationId: string,
  limit: number,
): Promise<OutboxRow[]> {
  const rows = await trx
    .selectFrom('outbox')
    .select(['id', 'topic', 'payload', 'created_at'])
    .where('organization_id', '=', organizationId)
    .where('processed_at', 'is', null)
    .orderBy('position')
    .limit(limit)
    .forUpdate()
    .execute();
  return rows.map((r) => ({
    id: r.id,
    topic: r.topic as RealtimeEventType,
    payload: r.payload as Record<string, string>,
    createdAt: r.created_at,
  }));
}

export async function lastSequence(trx: Database, organizationId: string): Promise<number> {
  const row = await trx
    .selectFrom('realtime_events')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
  return row?.seq ? Number(row.seq) : 0;
}

/** `createdAt` is when the change happened (the outbox row's time); the stream sends it as occurredAt. */
export async function insertRealtimeEvents(
  trx: Database,
  organizationId: string,
  rows: readonly {
    id: string;
    seq: number;
    type: RealtimeEventType;
    payload: Record<string, string>;
    createdAt: Date;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  await trx
    .insertInto('realtime_events')
    .values(
      rows.map((r) => ({
        id: r.id,
        organization_id: organizationId,
        seq: r.seq,
        type: r.type,
        payload: JSON.stringify(r.payload),
        created_at: r.createdAt,
      })),
    )
    .execute();
}

export async function markProcessed(
  trx: Database,
  organizationId: string,
  ids: readonly string[],
  now: Date,
): Promise<void> {
  if (ids.length === 0) return;
  await trx
    .updateTable('outbox')
    .set({ processed_at: now })
    .where('organization_id', '=', organizationId)
    .where('id', 'in', ids)
    .execute();
}

/** Sent at commit, so a listener never reads ahead of what is visible. */
export async function notifyOrganization(trx: Database, organizationId: string): Promise<void> {
  await sql`select pg_notify(${REALTIME_CHANNEL}, ${organizationId})`.execute(trx);
}

/** Processed outbox rows are kept for an hour for diagnosis, then removed. */
export async function pruneOutbox(trx: Database, organizationId: string, before: Date): Promise<void> {
  await trx
    .deleteFrom('outbox')
    .where('organization_id', '=', organizationId)
    .where('processed_at', '<', before)
    .execute();
}

/**
 * The replay buffer keeps 5 minutes and at most `keep` events (ARCH §14). The newest event always
 * stays, so the sequence never restarts and an old position is always recognisable as too old.
 */
export async function pruneRealtimeEvents(
  trx: Database,
  organizationId: string,
  before: Date,
  newest: number,
  keep: number,
): Promise<void> {
  await trx
    .deleteFrom('realtime_events')
    .where('organization_id', '=', organizationId)
    // bigint columns compare as text parameters (Kysely reads int8 as a string).
    .where('seq', '<', String(newest))
    .where((eb) => eb.or([eb('created_at', '<', before), eb('seq', '<=', String(newest - keep))]))
    .execute();
}

// ── The stream ──────────────────────────────────────────────────────────────────────────────

/** The oldest and newest sequence still in the buffer; 0 and 0 when nothing was ever sent. */
export async function sequenceBounds(
  trx: Database,
  organizationId: string,
): Promise<{ oldest: number; newest: number }> {
  const row = await trx
    .selectFrom('realtime_events')
    .select((eb) => [eb.fn.min('seq').as('oldest'), eb.fn.max('seq').as('newest')])
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
  return { oldest: row?.oldest ? Number(row.oldest) : 0, newest: row?.newest ? Number(row.newest) : 0 };
}

export async function eventsAfter(
  trx: Database,
  organizationId: string,
  after: number,
  limit: number,
): Promise<RealtimeRow[]> {
  const rows = await trx
    .selectFrom('realtime_events')
    .select(['seq', 'type', 'payload', 'created_at'])
    .where('organization_id', '=', organizationId)
    .where('seq', '>', String(after))
    .orderBy('seq')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    seq: Number(r.seq),
    type: r.type as RealtimeEventType,
    payload: r.payload as Record<string, string>,
    createdAt: r.created_at,
  }));
}

// ── Open streams and monitoring coverage ────────────────────────────────────────────────────

export async function insertStreamConnection(
  trx: Database,
  row: {
    id: string;
    organizationId: string;
    userId: string;
    client: 'DESKTOP' | 'PHONE';
    instanceId: string;
    now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('stream_connections')
    .values({
      id: row.id,
      organization_id: row.organizationId,
      user_id: row.userId,
      client: row.client,
      instance_id: row.instanceId,
      connected_at: row.now,
      last_seen_at: row.now,
    })
    .execute();
}

export async function touchStreamConnection(
  trx: Database,
  organizationId: string,
  id: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('stream_connections')
    .set({ last_seen_at: now })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

export async function deleteStreamConnection(
  trx: Database,
  organizationId: string,
  id: string,
): Promise<void> {
  await trx
    .deleteFrom('stream_connections')
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

/** Streams seen since `since`: the dashboards watching right now (PROD §11.5). */
export async function coverageCounts(
  trx: Database,
  organizationId: string,
  since: Date,
): Promise<{ desktop: number; phone: number }> {
  const rows = await trx
    .selectFrom('stream_connections')
    .select(['client', (eb) => eb.fn.countAll<string>().as('n')])
    .where('organization_id', '=', organizationId)
    .where('last_seen_at', '>=', since)
    .groupBy('client')
    .execute();
  const count = (client: string) => Number(rows.find((r) => r.client === client)?.n ?? 0);
  return { desktop: count('DESKTOP'), phone: count('PHONE') };
}

/** Removes streams of an API instance that stopped without closing them. */
export async function deleteStaleConnections(
  trx: Database,
  organizationId: string,
  before: Date,
): Promise<number> {
  const result = await trx
    .deleteFrom('stream_connections')
    .where('organization_id', '=', organizationId)
    .where('last_seen_at', '<', before)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

// ── Sweeps (system_worker): which organizations have work ───────────────────────────────────

export async function organizationsWithPendingOutbox(sweep: Database, limit: number): Promise<string[]> {
  const { rows } = await sql<{ organization_id: string }>`
    select distinct organization_id
      from outbox
     where processed_at is null
     order by organization_id
     limit ${limit}`.execute(sweep);
  return rows.map((r) => r.organization_id);
}

export async function organizationsWithStaleConnections(
  sweep: Database,
  before: Date,
  limit: number,
): Promise<string[]> {
  const { rows } = await sql<{ organization_id: string }>`
    select distinct organization_id
      from stream_connections
     where last_seen_at < ${before}
     order by organization_id
     limit ${limit}`.execute(sweep);
  return rows.map((r) => r.organization_id);
}
