import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncItem } from '@sentryops/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIdFactory } from '../src/core/ids.ts';
import { InvalidItemError, Outbox, type Partition, partitionKey } from '../src/core/outbox/outbox.ts';
import { MetaStore } from '../src/core/storage/meta.ts';
import { configureConnection, migrate } from '../src/core/storage/schema.ts';
import type { SqlDatabase } from '../src/core/storage/sql.ts';
import { isoFromMs, ManualClocks } from '../src/core/time.ts';
import { cryptoRandom } from './support/fakes.ts';
import { GUARD_A, GUARD_B, ORG_ID, SHIFT_1 } from './support/fake-server.ts';
import { fileDatabase, memoryDatabase } from './support/sqlite.ts';

const A: Partition = { organizationId: ORG_ID, guardId: GUARD_A };
const B: Partition = { organizationId: ORG_ID, guardId: GUARD_B };
const T0 = Date.parse('2026-10-08T15:00:00.000Z');

let clocks: ManualClocks;
let ids: ReturnType<typeof createIdFactory>;
let db: SqlDatabase;
let outbox: Outbox;
const dirs: string[] = [];

async function open(database: SqlDatabase): Promise<Outbox> {
  await configureConnection(database);
  await migrate(database);
  return new Outbox(database, new MetaStore(database), () => clocks.wall.nowMs());
}

beforeEach(async () => {
  clocks = new ManualClocks(T0, 'run-now');
  ids = createIdFactory(cryptoRandom, clocks.wall);
  db = memoryDatabase();
  outbox = await open(db);
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const base = (atMs = clocks.wall.nowMs()) => ({
  clientEventId: ids.uuidv7(),
  recordedAt: isoFromMs(atMs),
  monoMs: clocks.mono.nowMs(),
  bootId: clocks.bootId,
});

function location(atMs = clocks.wall.nowMs()): SyncItem {
  return {
    ...base(atMs),
    type: 'LOCATION',
    shiftId: SHIFT_1,
    fix: { lat: 24.8607, lon: 67.0011, accuracyM: 8 },
  };
}

function start(): SyncItem {
  return {
    ...base(),
    type: 'SHIFT_START',
    shiftId: SHIFT_1,
    fix: { lat: 24.8607, lon: 67.0011, accuracyM: 8, fixAgeS: 1 },
    permission: { location: 'ALWAYS', precise: true },
  };
}

function end(): SyncItem {
  return { ...base(), type: 'SHIFT_END', shiftId: SHIFT_1, fix: null };
}

function incident(): SyncItem {
  return {
    ...base(),
    type: 'INCIDENT',
    shiftId: SHIFT_1,
    incident: {
      type: 'THEFT',
      severity: 'HIGH',
      title: 'Gate lock broken',
      description: '',
      occurredAt: isoFromMs(clocks.wall.nowMs()),
    },
    fix: null,
  };
}

const sos = (partition: Partition) =>
  outbox.enqueueSos(partition, {
    clientEventId: ids.uuidv7(),
    recordedAt: isoFromMs(clocks.wall.nowMs()),
    monoMs: clocks.mono.nowMs(),
    bootId: clocks.bootId,
    fix: null,
  });

const next = (
  key: string,
  options: { newBatchId?: string; maxItems?: number; holdTypes?: SyncItem['type'][] } = {},
) =>
  outbox.nextBatch(key, {
    newBatchId: options.newBatchId ?? ids.uuidv7(),
    maxItems: options.maxItems ?? 500,
    formedInBootId: clocks.bootId,
    ...(options.holdTypes ? { holdTypes: options.holdTypes } : {}),
  });

describe('outbox (ARCH §8.6)', () => {
  it('INV-06 refuses an item that does not match the sync contract, so nothing malformed is ever queued', async () => {
    const bad = { ...location(), fix: { lat: 200, lon: 0, accuracyM: 5 } } as SyncItem;
    await expect(outbox.enqueue(A, bad)).rejects.toBeInstanceOf(InvalidItemError);
    expect((await outbox.stats()).pending).toBe(0);
  });

  it('sends the main lane in seq order: START before its points, points before END', async () => {
    const queued = [start(), location(), location(), end()];
    for (const item of queued) await outbox.enqueue(A, item);
    const batch = await next(partitionKey(A));
    expect(batch?.items.map((i) => i.clientEventId)).toEqual(queued.map((i) => i.clientEventId));
    expect(batch?.items.map((i) => i.seq)).toEqual(
      [...(batch?.items.map((i) => i.seq) ?? [])].sort((x, y) => x - y),
    );
  });

  it('keeps SOS out of main-lane batches: SOS has its own lane', async () => {
    await outbox.enqueue(A, location());
    await sos(A);
    const batch = await next(partitionKey(A));
    expect(batch?.items.map((i) => i.type)).toEqual(['LOCATION']);
    expect(await outbox.dueSos(partitionKey(A), clocks.wall.nowMs())).toHaveLength(1);
  });

  it('ADV-O07 never puts one guard’s items in another guard’s batch (partitioned by organization and guard)', async () => {
    await outbox.enqueue(A, location());
    await outbox.enqueue(B, location());
    await outbox.enqueue(A, location());
    await sos(A);
    const batchB = await next(partitionKey(B));
    expect(batchB?.items).toHaveLength(1);
    expect(await outbox.dueSos(partitionKey(B), clocks.wall.nowMs())).toHaveLength(0);
    const batchA = await next(partitionKey(A));
    expect(batchA?.items).toHaveLength(2);
    expect(await outbox.otherPartitions(partitionKey(B))).toEqual([
      { partitionKey: partitionKey(A), count: 3 },
    ]);
  });

  it('caps a batch at 500 items, whatever the server setting says', async () => {
    for (let i = 0; i < 520; i++) await outbox.enqueue(A, location());
    const batch = await next(partitionKey(A), { maxItems: 10_000 });
    expect(batch?.items).toHaveLength(500);
  });

  it('caps a batch by size, so long incident texts cannot exceed the request limit', async () => {
    const long = 'x'.repeat(4_000);
    for (let i = 0; i < 100; i++) {
      const item = incident();
      if (item.type === 'INCIDENT') item.incident.description = long;
      await outbox.enqueue(A, item);
    }
    const batch = await next(partitionKey(A));
    const bytes = JSON.stringify(batch?.items.map((i) => i.item)).length;
    expect(batch?.items.length).toBeLessThan(100);
    expect(bytes).toBeLessThanOrEqual(256 * 1024 + 1_000);
  });

  it('each item keeps the bootId of the run its monoMs came from, so one batch may carry several runs', async () => {
    await outbox.enqueue(A, { ...location(), bootId: 'run-earlier' });
    const recovered = end();
    delete recovered.bootId; // an item whose monoMs means nothing (e.g. a recovered SHIFT_END)
    await outbox.enqueue(A, recovered);
    await outbox.enqueue(A, location());
    const batch = await next(partitionKey(A));
    expect(batch?.items.map((i) => i.item.bootId)).toEqual(['run-earlier', undefined, 'run-now']);
    expect(batch?.items.map((i) => i.bootId)).toEqual(['run-earlier', '', 'run-now']);
    expect(batch?.formedInBootId).toBe('run-now');
  });

  it('holds item types whose feature is off (incidents, scans): they stay queued and are not sent', async () => {
    await outbox.enqueue(A, start());
    await outbox.enqueue(A, incident());
    await outbox.enqueue(A, location());
    const batch = await next(partitionKey(A), { holdTypes: ['INCIDENT', 'CHECKPOINT_SCAN'] });
    expect(batch?.items.map((i) => i.type)).toEqual(['SHIFT_START', 'LOCATION']);
    await outbox.completeBatch(
      batch?.batchId ?? '',
      batch?.items.map((i) => ({ clientEventId: i.clientEventId, status: 'ACCEPTED' as const })) ?? [],
    );
    expect(await next(partitionKey(A), { holdTypes: ['INCIDENT'] })).toBeNull();
    expect((await outbox.stats()).pending).toBe(1); // still on the phone, honestly counted
    expect((await next(partitionKey(A)))?.items.map((i) => i.type)).toEqual(['INCIDENT']);
  });

  it('deletes ACCEPTED, DUPLICATE, QUARANTINED and REJECTED items; keeps RETRY and unanswered ones in place', async () => {
    const queued = [location(), location(), location(), location(), location(), location()];
    for (const item of queued) await outbox.enqueue(A, item);
    const batch = await next(partitionKey(A));
    const [a, b, c, d, e] = queued.map((q) => q.clientEventId);
    const outcomes = await outbox.completeBatch(batch?.batchId ?? '', [
      { clientEventId: a ?? '', status: 'ACCEPTED' },
      { clientEventId: b ?? '', status: 'DUPLICATE' },
      { clientEventId: c ?? '', status: 'QUARANTINED' },
      { clientEventId: d ?? '', status: 'REJECTED', code: 'OUTSIDE_SHIFT_WINDOW' },
      { clientEventId: e ?? '', status: 'RETRY' },
      // the sixth is missing from the response
    ]);
    expect(outcomes.map((o) => o.status)).toEqual([
      'ACCEPTED',
      'DUPLICATE',
      'QUARANTINED',
      'REJECTED',
      'RETRY',
      'MISSING',
    ]);
    const following = await next(partitionKey(A));
    expect(following?.items.map((i) => i.clientEventId)).toEqual([e, queued[5]?.clientEventId]);
    expect(following?.items.every((i) => i.attempts === 1)).toBe(true);
  });

  it('INV-06 a failed batch is resent as the same batch, with the same batchId and item IDs', async () => {
    for (let i = 0; i < 3; i++) await outbox.enqueue(A, location());
    const first = await next(partitionKey(A), { newBatchId: 'b-1' });
    await outbox.failBatch('b-1', 'NETWORK');
    await outbox.enqueue(A, location()); // more items arrive meanwhile
    const again = await next(partitionKey(A), { newBatchId: 'b-2' });
    expect(again?.batchId).toBe('b-1');
    expect(again?.items.map((i) => i.clientEventId)).toEqual(first?.items.map((i) => i.clientEventId));
    expect(again?.attempts).toBe(1);
  });

  it('ADV-O04 the queue and an interrupted batch survive the app being killed (database closed and reopened)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentry-kill-'));
    dirs.push(dir);
    const path = join(dir, 'outbox.db');
    let fileDb = fileDatabase(path);
    let box = await open(fileDb);
    for (let i = 0; i < 5; i++) await box.enqueue(A, location());
    const inFlight = await box.nextBatch(partitionKey(A), {
      newBatchId: 'b-killed',
      maxItems: 3,
      formedInBootId: 'run-1',
    });
    await fileDb.close(); // killed mid-upload: no response was ever processed

    fileDb = fileDatabase(path);
    box = await open(fileDb);
    expect((await box.stats()).pending).toBe(5);
    const resumed = await box.nextBatch(partitionKey(A), {
      newBatchId: 'b-new',
      maxItems: 500,
      formedInBootId: 'run-2',
    });
    expect(resumed?.batchId).toBe('b-killed');
    expect(resumed?.items.map((i) => i.clientEventId)).toEqual(inFlight?.items.map((i) => i.clientEventId));
    await fileDb.close();
  });

  it('thins only LOCATION items above 20,000, to one per minute, oldest first', async () => {
    const limit = 50; // the same rule with a small limit, so the test stays fast
    const t = clocks.wall.nowMs();
    await outbox.enqueue(A, start());
    for (let i = 0; i < 80; i++) await outbox.enqueue(A, location(t + i * 15_000)); // 4 per minute
    await outbox.enqueue(A, incident());
    await outbox.enqueue(A, end());
    const dropped = await outbox.thinLocations(partitionKey(A), limit);
    expect(dropped).toBe(30);
    const rows = await db.all<{ type: string; recorded_at_ms: number }>(
      'SELECT type, recorded_at_ms FROM outbox ORDER BY seq',
    );
    expect(rows.filter((r) => r.type === 'LOCATION')).toHaveLength(50);
    for (const type of ['SHIFT_START', 'INCIDENT', 'SHIFT_END'])
      expect(rows.some((r) => r.type === type)).toBe(true);
    // The oldest are thinned: the first minutes keep one point each, the newest points are all kept.
    const minutes = rows
      .filter((r) => r.type === 'LOCATION')
      .map((r) => Math.floor((r.recorded_at_ms - t) / 60_000));
    expect(minutes.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await outbox.discardedSummary()).count).toBe(30);
  });

  it('drops expired heartbeats and points but never start, end, incidents or SOS', async () => {
    await outbox.enqueue(A, start());
    await outbox.enqueue(A, location());
    await outbox.enqueue(A, incident());
    await outbox.enqueue(A, end());
    await sos(A);
    clocks.advance(200 * 3_600_000);
    const dropped = await outbox.dropExpired(clocks.wall.nowMs(), 168 * 3_600_000);
    expect(dropped).toBe(1);
    const types = (await db.all<{ type: string }>('SELECT type FROM outbox ORDER BY seq')).map((r) => r.type);
    expect(types).toEqual(['SHIFT_START', 'INCIDENT', 'SHIFT_END', 'SOS']);
    expect(await outbox.discardedSummary()).toMatchObject({ count: 1, lastReason: 'EXPIRED' });
  });

  it('drops a rejected start’s points, heartbeats and end, but keeps its incidents (ADV-O03)', async () => {
    await outbox.enqueue(A, location());
    await outbox.enqueue(A, incident());
    await outbox.enqueue(A, end());
    expect(await outbox.dropShiftItemsAfterRejectedStart(partitionKey(A), SHIFT_1)).toBe(2);
    const types = (await db.all<{ type: string }>('SELECT type FROM outbox')).map((r) => r.type);
    expect(types).toEqual(['INCIDENT']);
  });

  it('keeps receipts so the guard sees each action move from “saved on this phone” to the server’s answer', async () => {
    const s = start();
    await outbox.enqueue(A, s);
    await outbox.enqueue(A, location());
    expect((await outbox.receipt(s.clientEventId))?.status).toBe('QUEUED');
    const batch = await next(partitionKey(A));
    await outbox.completeBatch(batch?.batchId ?? '', [
      { clientEventId: s.clientEventId, status: 'REJECTED', code: 'SHIFT_OUTSIDE_START_WINDOW' },
    ]);
    expect(await outbox.receipt(s.clientEventId)).toMatchObject({
      status: 'REJECTED',
      errorCode: 'SHIFT_OUTSIDE_START_WINDOW',
    });
  });

  it('discarding another guard’s partition is counted, so the phone cannot claim it was sent', async () => {
    await outbox.enqueue(A, location());
    await outbox.enqueue(A, start());
    await outbox.enqueue(B, location());
    expect(await outbox.discardOtherPartitions(partitionKey(B))).toBe(2);
    expect((await outbox.stats()).pending).toBe(1);
    expect(await outbox.discardedSummary()).toMatchObject({ count: 2, lastReason: 'OTHER_GUARD' });
    await outbox.acknowledgeDiscarded();
    expect((await outbox.discardedSummary()).count).toBe(0);
  });
});
