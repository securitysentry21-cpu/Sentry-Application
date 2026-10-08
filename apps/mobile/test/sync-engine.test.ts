import type { SyncBatchRequest, SyncBatchResponse, SyncItem, SyncItemStatus } from '@sentryops/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError, NetworkError, SignedOutError } from '../src/core/api/errors.ts';
import { createIdFactory } from '../src/core/ids.ts';
import { silentLogger } from '../src/core/log.ts';
import { Outbox, type Partition } from '../src/core/outbox/outbox.ts';
import { MetaStore } from '../src/core/storage/meta.ts';
import { configureConnection, migrate } from '../src/core/storage/schema.ts';
import { type BatchExchange, SyncEngine } from '../src/core/sync/engine.ts';
import { isoFromMs, ManualClocks } from '../src/core/time.ts';
import { cryptoRandom } from './support/fakes.ts';
import { GUARD_A, GUARD_B, ORG_ID, SHIFT_1 } from './support/fake-server.ts';
import { memoryDatabase } from './support/sqlite.ts';

const A: Partition = { organizationId: ORG_ID, guardId: GUARD_A };
const T0 = Date.parse('2026-10-08T15:00:00.000Z');

type Reply = SyncItemStatus | ((item: SyncItem) => SyncItemStatus);

/** A server stub: decides each item, or fails the whole request. Records every request. */
class Upstream {
  requests: SyncBatchRequest[] = [];
  failWith: Error[] = [];
  reply: Reply = 'ACCEPTED';
  accepted = new Set<string>();
  hold: Promise<void> | null = null;
  inFlight = 0;
  maxInFlight = 0;

  readonly send = async (body: SyncBatchRequest): Promise<SyncBatchResponse> => {
    this.requests.push(structuredClone(body));
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.hold) await this.hold;
      const failure = this.failWith.shift();
      if (failure) throw failure;
      return {
        serverTime: isoFromMs(T0),
        results: (body.items as SyncItem[]).map((item) => {
          const status = this.accepted.has(item.clientEventId)
            ? 'DUPLICATE'
            : typeof this.reply === 'function'
              ? this.reply(item)
              : this.reply;
          if (status === 'ACCEPTED') this.accepted.add(item.clientEventId);
          return { clientEventId: item.clientEventId, status };
        }),
        shifts: [],
      };
    } finally {
      this.inFlight--;
    }
  };
}

let clocks: ManualClocks;
let ids: ReturnType<typeof createIdFactory>;
let outbox: Outbox;
let upstream: Upstream;
let partition: Partition | null;
let exchanges: BatchExchange[];

function engine(
  random01 = () => 0.5,
  extra: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {},
): SyncEngine {
  return new SyncEngine({
    outbox,
    send: upstream.send,
    clocks,
    ids,
    random01,
    logger: silentLogger,
    partition: () => partition,
    maxBatchItems: () => 500,
    onExchange: (e) => {
      exchanges.push(e);
      return Promise.resolve();
    },
    ...extra,
  });
}

async function queue(
  n: number,
  bootId = clocks.bootId,
  type: 'LOCATION' | 'INCIDENT' = 'LOCATION',
): Promise<string[]> {
  const made: string[] = [];
  for (let i = 0; i < n; i++) {
    const base = {
      clientEventId: ids.uuidv7(),
      recordedAt: isoFromMs(clocks.wall.nowMs()),
      monoMs: clocks.mono.nowMs(),
      bootId,
      shiftId: SHIFT_1,
    };
    const item: SyncItem =
      type === 'LOCATION'
        ? { ...base, type, fix: { lat: 24.86, lon: 67.0, accuracyM: 7 } }
        : {
            ...base,
            type,
            incident: {
              type: 'OTHER',
              severity: 'LOW',
              title: 'Note',
              description: '',
              occurredAt: base.recordedAt,
            },
            fix: null,
          };
    await outbox.enqueue(A, item);
    made.push(item.clientEventId);
  }
  return made;
}

beforeEach(async () => {
  clocks = new ManualClocks(T0, 'run-now', 50_000);
  ids = createIdFactory(cryptoRandom, clocks.wall);
  const db = memoryDatabase();
  await configureConnection(db);
  await migrate(db);
  outbox = new Outbox(db, new MetaStore(db), () => clocks.wall.nowMs());
  upstream = new Upstream();
  partition = A;
  exchanges = [];
});

describe('main-lane sync engine (ARCH §8.5–§8.6)', () => {
  it('sends everything in order and clears the queue on ACCEPTED', async () => {
    const made = await queue(3);
    const result = await engine().flush();
    expect(result).toMatchObject({ kind: 'IDLE', batches: 1 });
    expect(upstream.requests[0]?.items.map((i) => (i as SyncItem).clientEventId)).toEqual(made);
    expect((await outbox.stats()).pending).toBe(0);
    expect(exchanges).toHaveLength(1);
  });

  it('stamps the batch with the sending run (sentAt, sentMonoMs, bootId); each item keeps its own bootId', async () => {
    await queue(1, 'run-earlier');
    await queue(1);
    await engine().flush();
    expect(upstream.requests).toHaveLength(1);
    const [request] = upstream.requests;
    expect(request).toMatchObject({
      bootId: 'run-now',
      sentMonoMs: clocks.mono.nowMs(),
      sentAt: isoFromMs(T0),
    });
    // The server uses the monotonic estimate only where item.bootId equals the batch's.
    expect(request?.items.map((i) => (i as SyncItem).bootId)).toEqual(['run-earlier', 'run-now']);
  });

  it('a batch formed in an earlier run and resent now speaks for the run that sends it', async () => {
    await queue(2);
    upstream.failWith = [new NetworkError('NETWORK')];
    await engine().flush();
    const restarted = clocks.restart('run-later', 7_000);
    clocks = restarted;
    await engine().flush({ urgent: true });
    const [first, second] = upstream.requests;
    expect(second?.batchId).toBe(first?.batchId);
    expect(second).toMatchObject({ bootId: 'run-later', sentMonoMs: 7_000 });
    expect(second?.items.map((i) => (i as SyncItem).bootId)).toEqual(['run-now', 'run-now']);
  });

  it('never sends item types the server does not take yet (features off): they wait, counted', async () => {
    await queue(1, clocks.bootId, 'INCIDENT');
    await queue(2);
    let held: ('INCIDENT' | 'CHECKPOINT_SCAN')[] = ['INCIDENT', 'CHECKPOINT_SCAN'];
    const sync = engine(() => 0.5, { heldTypes: () => held });
    await sync.flush();
    expect(upstream.requests.flatMap((r) => r.items as SyncItem[]).map((i) => i.type)).toEqual([
      'LOCATION',
      'LOCATION',
    ]);
    expect((await outbox.stats()).pending).toBe(1);
    held = [];
    await sync.flush();
    expect(upstream.requests.at(-1)?.items.map((i) => (i as SyncItem).type)).toEqual(['INCIDENT']);
    expect((await outbox.stats()).pending).toBe(0);
  });

  it('keeps ONE batch in flight: concurrent flushes share the upload instead of starting another', async () => {
    await queue(600);
    let release: () => void = () => undefined;
    upstream.hold = new Promise((r) => (release = r));
    const sync = engine();
    const flushes = [sync.flush(), sync.flush({ urgent: true }), sync.flush()];
    await Promise.resolve();
    expect(sync.status().inFlight).toBe(true);
    release();
    upstream.hold = null;
    await Promise.all(flushes);
    expect(upstream.maxInFlight).toBe(1);
    expect(upstream.requests.map((r) => r.items.length)).toEqual([500, 100]);
    expect((await outbox.stats()).pending).toBe(0);
  });

  it('INV-06 a whole-batch failure (no response, 5xx) resends the same batchId and the same item IDs', async () => {
    await queue(4);
    upstream.failWith = [new NetworkError('TIMEOUT'), new ApiError(503, 'NOT_READY', null, null)];
    const sync = engine();
    expect((await sync.flush()).kind).toBe('FAILED');
    clocks.advance(10 * 60_000);
    expect((await sync.flush()).kind).toBe('FAILED');
    clocks.advance(10 * 60_000);
    expect((await sync.flush()).kind).toBe('IDLE');
    const [a, b, c] = upstream.requests;
    expect(b?.batchId).toBe(a?.batchId);
    expect(c?.batchId).toBe(a?.batchId);
    expect(c?.items).toEqual(a?.items);
    expect((await outbox.stats()).pending).toBe(0);
  });

  it('backs off with full jitter (base 5 s, doubling, cap 5 min) after consecutive failures', async () => {
    await queue(1);
    upstream.failWith = Array.from({ length: 12 }, () => new NetworkError('NETWORK'));
    const sync = engine(() => 0.999_999);
    const waits: number[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await sync.flush();
      if (result.kind !== 'FAILED') throw new Error('expected a failure');
      waits.push(result.untilMs - clocks.wall.nowMs());
      clocks.advance(result.untilMs - clocks.wall.nowMs());
    }
    expect(waits.slice(0, 6)).toEqual([4_999, 9_999, 19_999, 39_999, 79_999, 159_999]);
    expect(waits.slice(6).every((w) => w === 299_999)).toBe(true);
  });

  it('an urgent request made while a failing attempt is in flight gets one more attempt; an ordinary one waits', async () => {
    await queue(2);
    for (const urgent of [false, true]) {
      let release: () => void = () => undefined;
      upstream.hold = new Promise((r) => (release = r));
      upstream.failWith = [new NetworkError('NETWORK')];
      const before = upstream.requests.length;
      const sync = engine();
      const first = sync.flush();
      await Promise.resolve();
      const second = sync.flush({ urgent });
      release();
      upstream.hold = null;
      await Promise.all([first, second]);
      expect(upstream.requests.length - before).toBe(urgent ? 2 : 1);
    }
    expect((await outbox.stats()).pending).toBe(0);
  });

  it('does not retry before the backoff ends, unless the flush is urgent', async () => {
    await queue(1);
    upstream.failWith = [new NetworkError('NETWORK')];
    const sync = engine(() => 0.999_999);
    await sync.flush();
    expect((await sync.flush()).kind).toBe('BACKING_OFF');
    expect(upstream.requests).toHaveLength(1);
    expect((await sync.flush({ urgent: true })).kind).toBe('IDLE');
    expect(upstream.requests).toHaveLength(2);
  });

  it('ADV-L12 on 429 keeps every item and waits for Retry-After, even for urgent flushes', async () => {
    await queue(5);
    upstream.failWith = [new ApiError(429, 'RATE_LIMITED', null, 120_000)];
    const sync = engine(() => 0);
    const first = await sync.flush();
    expect(first.kind).toBe('FAILED');
    expect((await outbox.stats()).pending).toBe(5);
    clocks.advance(119_000);
    expect((await sync.flush({ urgent: true })).kind).toBe('BACKING_OFF');
    expect(upstream.requests).toHaveLength(1);
    clocks.advance(1_000);
    expect((await sync.flush()).kind).toBe('IDLE');
    expect(upstream.requests).toHaveLength(2);
    expect((await outbox.stats()).pending).toBe(0);
  });

  it('ADV-O09 a QUARANTINED item is final: the lane moves on and the next items are accepted', async () => {
    const made = await queue(6);
    upstream.reply = (item) => (item.clientEventId === made[2] ? 'QUARANTINED' : 'ACCEPTED');
    await engine().flush();
    await queue(3);
    await engine().flush();
    expect((await outbox.stats()).pending).toBe(0);
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1]?.items).toHaveLength(3);
  });

  it('per-item RETRY keeps those items in place and backs off before offering them again', async () => {
    const made = await queue(3);
    let first = true;
    upstream.reply = (item) => (first && item.clientEventId === made[1] ? 'RETRY' : 'ACCEPTED');
    const sync = engine(() => 0.5);
    const result = await sync.flush();
    first = false;
    expect(result.kind).toBe('BACKING_OFF');
    expect((await outbox.stats()).pending).toBe(1);
    clocks.advance(10_000);
    await sync.flush();
    expect(upstream.requests[1]?.items.map((i) => (i as SyncItem).clientEventId)).toEqual([made[1]]);
    expect((await outbox.stats()).pending).toBe(0);
  });

  it('a response that does not match the contract deletes nothing (success needs a valid server answer)', async () => {
    await queue(2);
    const { ProtocolError } = await import('../src/core/api/errors.ts');
    upstream.failWith = [new ProtocolError(200)];
    expect((await engine().flush()).kind).toBe('FAILED');
    expect((await outbox.stats()).pending).toBe(2);
  });

  it('stops for a signed-out session or a revoked app version, keeping the queue', async () => {
    await queue(2);
    upstream.failWith = [new SignedOutError('REVOKED')];
    const sync = engine();
    expect(await sync.flush()).toMatchObject({ kind: 'BLOCKED', reason: 'SIGNED_OUT' });
    expect((await sync.flush({ urgent: true })).kind).toBe('BLOCKED');
    expect((await outbox.stats()).pending).toBe(2);

    const other = engine();
    upstream.failWith = [new ApiError(426, 'APP_VERSION_UNSUPPORTED', null, null)];
    expect(await other.flush()).toMatchObject({ kind: 'BLOCKED', reason: 'UPDATE_REQUIRED' });
    expect((await outbox.stats()).pending).toBe(2);
  });

  it('ADV-O07 uploads only the signed-in guard’s partition', async () => {
    await queue(2);
    partition = { organizationId: ORG_ID, guardId: GUARD_B };
    expect((await engine().flush()).kind).toBe('IDLE');
    expect(upstream.requests).toHaveLength(0);
    partition = null;
    expect(await engine().flush()).toMatchObject({ kind: 'BLOCKED', reason: 'NO_SESSION' });
  });

  it('ADV-O01 after a 30-minute outage every item is delivered exactly once, in order', async () => {
    const sync = engine(() => 0.7);
    const made: string[] = [];
    // 30 minutes offline: a point every 15 s, a flush attempt every minute, all failing.
    for (let minute = 0; minute < 30; minute++) {
      for (let i = 0; i < 4; i++) {
        made.push(...(await queue(1)));
        clocks.advance(15_000);
      }
      upstream.failWith = [new NetworkError('NETWORK')];
      await sync.flush({ urgent: true });
    }
    upstream.failWith = [];
    sync.resetBackoff();
    clocks.advance(300_000);
    await sync.flush();
    expect((await outbox.stats()).pending).toBe(0);
    const delivered = [...upstream.accepted];
    expect(delivered).toEqual(made); // each exactly once, in capture order
    expect(new Set(delivered).size).toBe(made.length);
    const answered = upstream.requests.slice(-1).flatMap((r) => r.items);
    expect(answered.length).toBeLessThanOrEqual(500);
  });

  it('records the time of the last complete response for “Server confirmed … ago”', async () => {
    await queue(1);
    const sync = engine();
    expect(sync.status().lastSuccessAtMs).toBeNull();
    clocks.advance(5_000);
    await sync.flush();
    expect(sync.status().lastSuccessAtMs).toBe(T0 + 5_000);
  });
});
