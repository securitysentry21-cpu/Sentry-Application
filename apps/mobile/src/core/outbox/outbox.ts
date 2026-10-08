// The phone's durable queue (ARCH §8.6). Every event the guard's phone creates is written here in a
// transaction before anything tries to send it, and deleted only when the server has answered for
// it. It lives in SQLite in app-private storage, never in memory or AsyncStorage.
//
// - Partitioned by (organization, guard): a lent phone never uploads one guard's queue with another
//   guard's session (ARCH §5.5, ADV-O07). Every read for sending names the partition.
// - Two lanes. MAIN goes in `seq` order, one batch at a time; SOS goes immediately and
//   independently (POST /sos), never behind MAIN items.
// - A batch, once formed, is persisted with its ID and items, so a failed or interrupted upload is
//   retried as the same batch with the same IDs (INV-06).
// - Every item carries the bootId of the process run its monoMs was taken in; the server uses the
//   monotonic estimate only for items from the run that sends the batch (ARCH §8.7).
// - Item types whose feature is switched off (INCIDENT, CHECKPOINT_SCAN) are held on the phone,
//   never sent, until the feature is on.
import {
  MAX_BATCH_ITEMS,
  sosRequestSchema,
  syncItemSchema,
  type SyncItem,
  type SyncItemStatus,
} from '@sentryops/contracts';
import type { z } from 'zod';

import type { MetaStore } from '../storage/meta.ts';
import { META_KEYS } from '../storage/meta.ts';
import { placeholders, type SqlDatabase, type SqlExecutor } from '../storage/sql.ts';
import { msFromIso } from '../time.ts';

export type Partition = { readonly organizationId: string; readonly guardId: string };
export const partitionKey = (p: Partition): string => `${p.organizationId}/${p.guardId}`;

export type Lane = 'MAIN' | 'SOS';
export type SosRequest = z.infer<typeof sosRequestSchema>;
export type OutboxItemType = SyncItem['type'] | 'SOS';

/** Items whose outcome the guard sees ("Saved on this phone" → "Received by server"). */
const RECEIPT_TYPES: ReadonlySet<string> = new Set([
  'SHIFT_START',
  'SHIFT_END',
  'INCIDENT',
  'CHECKPOINT_SCAN',
  'SOS',
]);

/** Never dropped by age or thinned (ARCH §8.6). The server decides about them. */
export const PROTECTED_TYPES: ReadonlySet<string> = new Set([
  'SHIFT_START',
  'SHIFT_END',
  'CHECKPOINT_SCAN',
  'INCIDENT',
  'SOS',
]);

/** Dropped once older than sync.maxOfflineAgeHours: the server would reject them (TIMESTAMP_TOO_OLD). */
const EXPIRABLE_TYPES = ['LOCATION', 'HEARTBEAT', 'DEVICE_STATUS'] as const;

/** ARCH §8.6: above this many queued LOCATION items, the oldest are thinned to one per minute. */
export const LOCATION_THINNING_LIMIT = 20_000;

/** Keeps a batch comfortably below the server's 512 KB limit even without compression. */
export const MAX_BATCH_BYTES = 256 * 1024;

export type ReceiptStatus = 'QUEUED' | 'ACCEPTED' | 'DUPLICATE' | 'QUARANTINED' | 'REJECTED' | 'DISCARDED';

export type Receipt = {
  clientEventId: string;
  type: OutboxItemType;
  shiftId: string | null;
  status: ReceiptStatus;
  errorCode: string | null;
  serverRef: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type QueuedItem = {
  seq: number;
  clientEventId: string;
  type: SyncItem['type'];
  shiftId: string | null;
  recordedAtMs: number;
  monoMs: number;
  /** The run the item's monoMs belongs to ('' when it has none, e.g. a recovered item). */
  bootId: string;
  attempts: number;
  item: SyncItem;
};

export type Batch = {
  batchId: string;
  partitionKey: string;
  /** The run that formed the batch (bookkeeping only: a resent batch carries the sending run). */
  formedInBootId: string;
  attempts: number;
  items: QueuedItem[];
};

export type QueuedSos = {
  seq: number;
  clientEventId: string;
  partitionKey: string;
  attempts: number;
  nextAttemptAtMs: number;
  lastError: string | null;
  request: SosRequest;
};

export type ItemOutcome = {
  clientEventId: string;
  type: SyncItem['type'];
  shiftId: string | null;
  /** MISSING: the response had no result for this item; it stays queued, like RETRY. */
  status: SyncItemStatus | 'MISSING';
  errorCode: string | null;
};

export type DiscardedSummary = { count: number; lastReason: string | null; lastAtMs: number | null };

export type QueueStats = {
  pending: number;
  pendingMain: number;
  pendingSos: number;
  inBatch: number;
  oldestRecordedAtMs: number | null;
};

type OutboxRow = {
  seq: number;
  partition_key: string;
  lane: Lane;
  client_event_id: string;
  type: string;
  shift_id: string | null;
  payload: string;
  recorded_at_ms: number;
  mono_ms: number;
  boot_id: string;
  attempts: number;
  batch_id: string | null;
  last_error: string | null;
  created_at_ms: number;
  next_attempt_at_ms: number;
};

type ReceiptRow = {
  client_event_id: string;
  type: string;
  shift_id: string | null;
  status: ReceiptStatus;
  error_code: string | null;
  server_ref: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export class InvalidItemError extends Error {
  override name = 'InvalidItemError';
}

function toQueuedItem(row: OutboxRow): QueuedItem {
  return {
    seq: row.seq,
    clientEventId: row.client_event_id,
    type: row.type as SyncItem['type'],
    shiftId: row.shift_id,
    recordedAtMs: row.recorded_at_ms,
    monoMs: row.mono_ms,
    bootId: row.boot_id,
    attempts: row.attempts,
    item: JSON.parse(row.payload) as SyncItem,
  };
}

function toReceipt(row: ReceiptRow): Receipt {
  return {
    clientEventId: row.client_event_id,
    type: row.type as OutboxItemType,
    shiftId: row.shift_id,
    status: row.status,
    errorCode: row.error_code,
    serverRef: row.server_ref,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

export class Outbox {
  readonly #db: SqlDatabase;
  readonly #meta: MetaStore;
  readonly #now: () => number;

  /** `now` is the phone's wall clock in ms, used only for local bookkeeping columns. */
  constructor(db: SqlDatabase, meta: MetaStore, now: () => number) {
    this.#db = db;
    this.#meta = meta;
    this.#now = now;
  }

  // ── Writing ────────────────────────────────────────────────────────────────────────────────

  /**
   * Queues a main-lane item. The item must satisfy the contract; its `bootId` names the process run
   * its `monoMs` was taken in (omitted only when its monoMs has no meaning, e.g. a recovered item).
   */
  async enqueue(partition: Partition, item: SyncItem): Promise<number> {
    const parsed = syncItemSchema.safeParse(item);
    if (!parsed.success) throw new InvalidItemError(`${item.type} does not match the sync contract`);
    const value = parsed.data;
    const shiftId = value.shiftId;
    const recordedAtMs = msFromIso(value.recordedAt);
    const bootId = value.bootId ?? '';
    const key = partitionKey(partition);
    const now = this.#now();
    return this.#db.transaction(async (tx) => {
      const result = await tx.run(
        `INSERT INTO outbox (partition_key, lane, client_event_id, type, shift_id, payload, recorded_at_ms,
           mono_ms, boot_id, created_at_ms)
         VALUES (?, 'MAIN', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key,
          value.clientEventId,
          value.type,
          shiftId,
          JSON.stringify(value),
          recordedAtMs,
          value.monoMs,
          bootId,
          now,
        ],
      );
      if (RECEIPT_TYPES.has(value.type)) {
        await this.#insertReceipt(tx, key, value.clientEventId, value.type, shiftId, now);
      }
      return result.lastInsertRowId;
    });
  }

  /** Queues an SOS for the SOS lane (PROD §11.2 step 1: saved on the phone before anything else). */
  async enqueueSos(partition: Partition, request: SosRequest): Promise<number> {
    const parsed = sosRequestSchema.safeParse(request);
    if (!parsed.success) throw new InvalidItemError('SOS does not match the contract');
    const value = parsed.data;
    const key = partitionKey(partition);
    const now = this.#now();
    return this.#db.transaction(async (tx) => {
      const result = await tx.run(
        `INSERT INTO outbox (partition_key, lane, client_event_id, type, shift_id, payload, recorded_at_ms,
           mono_ms, boot_id, created_at_ms, next_attempt_at_ms)
         VALUES (?, 'SOS', ?, 'SOS', NULL, ?, ?, ?, ?, ?, 0)`,
        [
          key,
          value.clientEventId,
          JSON.stringify(value),
          msFromIso(value.recordedAt),
          value.monoMs,
          value.bootId,
          now,
        ],
      );
      await this.#insertReceipt(tx, key, value.clientEventId, 'SOS', null, now);
      return result.lastInsertRowId;
    });
  }

  async #insertReceipt(
    tx: SqlExecutor,
    key: string,
    clientEventId: string,
    type: string,
    shiftId: string | null,
    now: number,
  ): Promise<void> {
    await tx.run(
      `INSERT INTO receipts (client_event_id, partition_key, type, shift_id, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'QUEUED', ?, ?)`,
      [clientEventId, key, type, shiftId, now, now],
    );
  }

  // ── Main lane: batches ─────────────────────────────────────────────────────────────────────

  /**
   * The batch to send next for this partition: the one already formed (a retry, same ID and items)
   * or a new one from the oldest unbatched items, skipping `holdTypes` (features switched off).
   * Null when there is nothing to send.
   */
  async nextBatch(
    key: string,
    options: {
      newBatchId: string;
      maxItems: number;
      maxBytes?: number;
      formedInBootId: string;
      holdTypes?: readonly SyncItem['type'][];
    },
  ): Promise<Batch | null> {
    const maxItems = Math.max(1, Math.min(Math.trunc(options.maxItems), MAX_BATCH_ITEMS));
    const maxBytes = options.maxBytes ?? MAX_BATCH_BYTES;
    const held = options.holdTypes ?? [];
    return this.#db.transaction(async (tx) => {
      const open = await tx.get<{ batch_id: string }>(
        'SELECT batch_id FROM batches WHERE partition_key = ? ORDER BY created_at_ms LIMIT 1',
        [key],
      );
      if (open) return this.#loadBatch(tx, open.batch_id);

      const rows = await tx.all<OutboxRow>(
        `SELECT * FROM outbox WHERE partition_key = ? AND lane = 'MAIN' AND batch_id IS NULL
         ${held.length > 0 ? `AND type NOT IN (${placeholders(held.length)})` : ''}
         ORDER BY seq LIMIT ?`,
        [key, ...held, maxItems],
      );
      if (rows.length === 0) return null;
      const chosen: OutboxRow[] = [];
      let bytes = 0;
      for (const row of rows) {
        const size = utf8Length(row.payload) + 1;
        if (chosen.length > 0 && bytes + size > maxBytes) break;
        chosen.push(row);
        bytes += size;
      }
      const now = this.#now();
      await tx.run(
        'INSERT INTO batches (batch_id, partition_key, boot_id, created_at_ms, attempts) VALUES (?, ?, ?, ?, 0)',
        [options.newBatchId, key, options.formedInBootId, now],
      );
      const seqs = chosen.map((r) => r.seq);
      await tx.run(`UPDATE outbox SET batch_id = ? WHERE seq IN (${placeholders(seqs.length)})`, [
        options.newBatchId,
        ...seqs,
      ]);
      return {
        batchId: options.newBatchId,
        partitionKey: key,
        formedInBootId: options.formedInBootId,
        attempts: 0,
        items: chosen.map(toQueuedItem),
      };
    });
  }

  async #loadBatch(tx: SqlExecutor, batchId: string): Promise<Batch | null> {
    const batch = await tx.get<{
      batch_id: string;
      partition_key: string;
      boot_id: string;
      attempts: number;
    }>('SELECT batch_id, partition_key, boot_id, attempts FROM batches WHERE batch_id = ?', [batchId]);
    if (!batch) return null;
    const rows = await tx.all<OutboxRow>('SELECT * FROM outbox WHERE batch_id = ? ORDER BY seq', [batchId]);
    if (rows.length === 0) {
      await tx.run('DELETE FROM batches WHERE batch_id = ?', [batchId]);
      return null;
    }
    return {
      batchId: batch.batch_id,
      partitionKey: batch.partition_key,
      formedInBootId: batch.boot_id,
      attempts: batch.attempts,
      items: rows.map(toQueuedItem),
    };
  }

  /**
   * Applies the server's per-item results to a sent batch. ACCEPTED, DUPLICATE, QUARANTINED and
   * REJECTED are final: the item is deleted. RETRY, and any item the response did not mention, stay
   * queued in their place. The batch itself is closed either way.
   */
  async completeBatch(
    batchId: string,
    results: readonly { clientEventId: string; status: SyncItemStatus; code?: string | undefined }[],
  ): Promise<ItemOutcome[]> {
    const byId = new Map<string, { status: SyncItemStatus; code?: string | undefined }>();
    for (const r of results) if (!byId.has(r.clientEventId)) byId.set(r.clientEventId, r);
    const now = this.#now();
    return this.#db.transaction(async (tx) => {
      const rows = await tx.all<Pick<OutboxRow, 'seq' | 'client_event_id' | 'type' | 'shift_id'>>(
        'SELECT seq, client_event_id, type, shift_id FROM outbox WHERE batch_id = ? ORDER BY seq',
        [batchId],
      );
      const outcomes: ItemOutcome[] = [];
      for (const row of rows) {
        const result = byId.get(row.client_event_id);
        const status = result?.status ?? 'MISSING';
        const errorCode = result?.code ?? null;
        if (status === 'RETRY' || status === 'MISSING') {
          await tx.run(
            'UPDATE outbox SET batch_id = NULL, attempts = attempts + 1, last_error = ? WHERE seq = ?',
            [errorCode ?? status, row.seq],
          );
        } else {
          await tx.run('DELETE FROM outbox WHERE seq = ?', [row.seq]);
          await tx.run(
            `UPDATE receipts SET status = ?, error_code = ?, updated_at_ms = ? WHERE client_event_id = ?`,
            [status, errorCode, now, row.client_event_id],
          );
        }
        outcomes.push({
          clientEventId: row.client_event_id,
          type: row.type as SyncItem['type'],
          shiftId: row.shift_id,
          status,
          errorCode,
        });
      }
      await tx.run('DELETE FROM batches WHERE batch_id = ?', [batchId]);
      return outcomes;
    });
  }

  /** The whole batch failed (no response, 5xx, 429): keep it as it is, to resend with the same IDs. */
  async failBatch(batchId: string, error: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx.run('UPDATE batches SET attempts = attempts + 1 WHERE batch_id = ?', [batchId]);
      await tx.run('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE batch_id = ?', [
        error,
        batchId,
      ]);
    });
  }

  // ── SOS lane ───────────────────────────────────────────────────────────────────────────────

  /** SOS items of this partition that are due, oldest first. */
  async dueSos(key: string, nowMs: number): Promise<QueuedSos[]> {
    const rows = await this.#db.all<OutboxRow>(
      `SELECT * FROM outbox WHERE partition_key = ? AND lane = 'SOS' AND next_attempt_at_ms <= ? ORDER BY seq`,
      [key, nowMs],
    );
    return rows.map((row) => ({
      seq: row.seq,
      clientEventId: row.client_event_id,
      partitionKey: row.partition_key,
      attempts: row.attempts,
      nextAttemptAtMs: row.next_attempt_at_ms,
      lastError: row.last_error,
      request: JSON.parse(row.payload) as SosRequest,
    }));
  }

  async allSos(key: string): Promise<QueuedSos[]> {
    return this.dueSos(key, Number.MAX_SAFE_INTEGER);
  }

  async rescheduleSos(clientEventId: string, nextAttemptAtMs: number, error: string): Promise<void> {
    await this.#db.run(
      `UPDATE outbox SET attempts = attempts + 1, next_attempt_at_ms = ?, last_error = ?
       WHERE client_event_id = ? AND lane = 'SOS'`,
      [nextAttemptAtMs, error, clientEventId],
    );
  }

  /** The server confirmed the SOS (RECEIVED): remove it from the lane, keep the receipt. */
  async completeSos(clientEventId: string, sosEventId: string): Promise<void> {
    const now = this.#now();
    await this.#db.transaction(async (tx) => {
      await tx.run(`DELETE FROM outbox WHERE client_event_id = ? AND lane = 'SOS'`, [clientEventId]);
      await tx.run(
        `UPDATE receipts SET status = 'ACCEPTED', server_ref = ?, error_code = NULL, updated_at_ms = ?
         WHERE client_event_id = ?`,
        [sosEventId, now, clientEventId],
      );
    });
  }

  /** The server refused the SOS permanently (4xx other than auth): keep a receipt saying so. */
  async rejectSos(clientEventId: string, errorCode: string): Promise<void> {
    const now = this.#now();
    await this.#db.transaction(async (tx) => {
      await tx.run(`DELETE FROM outbox WHERE client_event_id = ? AND lane = 'SOS'`, [clientEventId]);
      await tx.run(
        `UPDATE receipts SET status = 'REJECTED', error_code = ?, updated_at_ms = ? WHERE client_event_id = ?`,
        [errorCode, now, clientEventId],
      );
    });
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────────

  async stats(key?: string): Promise<QueueStats> {
    const where = key === undefined ? '' : 'WHERE partition_key = ?';
    const params = key === undefined ? [] : [key];
    const row = await this.#db.get<{
      pending: number;
      main: number | null;
      sos: number | null;
      in_batch: number | null;
      oldest: number | null;
    }>(
      `SELECT COUNT(*) AS pending,
              SUM(CASE WHEN lane = 'MAIN' THEN 1 ELSE 0 END) AS main,
              SUM(CASE WHEN lane = 'SOS' THEN 1 ELSE 0 END) AS sos,
              SUM(CASE WHEN batch_id IS NOT NULL THEN 1 ELSE 0 END) AS in_batch,
              MIN(recorded_at_ms) AS oldest
       FROM outbox ${where}`,
      params,
    );
    return {
      pending: row?.pending ?? 0,
      pendingMain: row?.main ?? 0,
      pendingSos: row?.sos ?? 0,
      inBatch: row?.in_batch ?? 0,
      oldestRecordedAtMs: row?.oldest ?? null,
    };
  }

  /** Partitions other than `key` that still hold items (a previous guard's unsent data). */
  async otherPartitions(key: string | null): Promise<{ partitionKey: string; count: number }[]> {
    const rows = await this.#db.all<{ partition_key: string; n: number }>(
      `SELECT partition_key, COUNT(*) AS n FROM outbox
       ${key === null ? '' : 'WHERE partition_key <> ?'} GROUP BY partition_key`,
      key === null ? [] : [key],
    );
    return rows.map((r) => ({ partitionKey: r.partition_key, count: r.n }));
  }

  async receipt(clientEventId: string): Promise<Receipt | null> {
    const row = await this.#db.get<ReceiptRow>('SELECT * FROM receipts WHERE client_event_id = ?', [
      clientEventId,
    ]);
    return row ? toReceipt(row) : null;
  }

  async recentReceipts(key: string, limit = 20): Promise<Receipt[]> {
    const rows = await this.#db.all<ReceiptRow>(
      'SELECT * FROM receipts WHERE partition_key = ? ORDER BY updated_at_ms DESC, created_at_ms DESC LIMIT ?',
      [key, limit],
    );
    return rows.map(toReceipt);
  }

  /** Items queued for one shift (e.g. to show "42 updates waiting" on the shift screen). */
  async countForShift(key: string, shiftId: string): Promise<number> {
    const row = await this.#db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM outbox WHERE partition_key = ? AND shift_id = ?',
      [key, shiftId],
    );
    return row?.n ?? 0;
  }

  // ── Dropping (always counted, so the phone never claims "All data sent" after a drop) ───────

  /** Drops expirable items older than the server's maximum offline age (ARCH §8.6). */
  async dropExpired(nowMs: number, maxAgeMs: number): Promise<number> {
    const cutoff = nowMs - maxAgeMs;
    return this.#discardWhere(
      `lane = 'MAIN' AND batch_id IS NULL AND type IN (${placeholders(EXPIRABLE_TYPES.length)}) AND recorded_at_ms < ?`,
      [...EXPIRABLE_TYPES, cutoff],
      'EXPIRED',
    );
  }

  /**
   * Above `limit` queued LOCATION items, thins the oldest to one per `bucketMs` until the count is
   * back under the limit (ARCH §8.6). Other item types are never touched.
   */
  async thinLocations(key: string, limit = LOCATION_THINNING_LIMIT, bucketMs = 60_000): Promise<number> {
    const rows = await this.#db.all<{ seq: number; recorded_at_ms: number }>(
      `SELECT seq, recorded_at_ms FROM outbox
       WHERE partition_key = ? AND lane = 'MAIN' AND type = 'LOCATION' AND batch_id IS NULL ORDER BY seq`,
      [key],
    );
    let excess = rows.length - limit;
    if (excess <= 0) return 0;
    const drop: number[] = [];
    let lastBucket: number | null = null;
    for (const row of rows) {
      if (excess <= 0) break;
      const bucket = Math.floor(row.recorded_at_ms / bucketMs);
      if (bucket === lastBucket) {
        drop.push(row.seq);
        excess--;
      } else {
        lastBucket = bucket;
      }
    }
    let dropped = 0;
    for (let i = 0; i < drop.length; i += 500) {
      const chunk = drop.slice(i, i + 500);
      dropped += await this.#discardWhere(`seq IN (${placeholders(chunk.length)})`, chunk, 'THINNED');
    }
    return dropped;
  }

  /**
   * The server rejected this shift's start (ADV-O03): drop the shift's queued points and other items
   * the server would refuse. Incidents and scans stay: the server keeps their facts (INV-08).
   */
  async dropShiftItemsAfterRejectedStart(key: string, shiftId: string): Promise<number> {
    const types = ['LOCATION', 'HEARTBEAT', 'SHIFT_END'];
    return this.#discardWhere(
      `partition_key = ? AND lane = 'MAIN' AND batch_id IS NULL AND shift_id = ? AND type IN (${placeholders(types.length)})`,
      [key, shiftId, ...types],
      'START_REJECTED',
    );
  }

  /**
   * Deletes every partition except `keep` (a different guard enrolled on this phone, and the guard
   * confirmed that the previous guard's unsent data is lost — ARCH §5.5, PROD §4.5).
   */
  async discardOtherPartitions(keep: string | null): Promise<number> {
    const dropped = await this.#discardWhere(
      keep === null ? '1 = 1' : 'partition_key <> ?',
      keep === null ? [] : [keep],
      'OTHER_GUARD',
    );
    await this.#db.run(
      keep === null ? 'DELETE FROM batches' : 'DELETE FROM batches WHERE partition_key <> ?',
      [...(keep === null ? [] : [keep])],
    );
    return dropped;
  }

  async #discardWhere(where: string, params: (string | number)[], reason: string): Promise<number> {
    const now = this.#now();
    return this.#db.transaction(async (tx) => {
      const ids = await tx.all<{ client_event_id: string }>(
        `SELECT client_event_id FROM outbox WHERE ${where}`,
        params,
      );
      if (ids.length === 0) return 0;
      const result = await tx.run(`DELETE FROM outbox WHERE ${where}`, params);
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500).map((r) => r.client_event_id);
        await tx.run(
          `UPDATE receipts SET status = 'DISCARDED', error_code = ?, updated_at_ms = ?
           WHERE client_event_id IN (${placeholders(chunk.length)})`,
          [reason, now, ...chunk],
        );
      }
      const previous = await tx.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
        META_KEYS.discarded,
      ]);
      const summary = previous ? (JSON.parse(previous.value) as DiscardedSummary) : null;
      const next: DiscardedSummary = {
        count: (summary?.count ?? 0) + result.changes,
        lastReason: reason,
        lastAtMs: now,
      };
      await this.#meta.setJson(META_KEYS.discarded, next, tx);
      return result.changes;
    });
  }

  async discardedSummary(): Promise<DiscardedSummary> {
    return (
      (await this.#meta.getJson<DiscardedSummary>(META_KEYS.discarded)) ?? {
        count: 0,
        lastReason: null,
        lastAtMs: null,
      }
    );
  }

  /** The guard has read the "N updates were not sent" notice. */
  async acknowledgeDiscarded(): Promise<void> {
    await this.#meta.delete(META_KEYS.discarded);
  }

  /** Keeps the receipts table small: final receipts older than `maxAgeMs` go. */
  async pruneReceipts(nowMs: number, maxAgeMs: number): Promise<void> {
    await this.#db.run(`DELETE FROM receipts WHERE status <> 'QUEUED' AND updated_at_ms < ?`, [
      nowMs - maxAgeMs,
    ]);
  }
}
