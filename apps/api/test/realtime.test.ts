// The realtime stream (ARCH §14, D-09) over a real socket: the outbox and its dispatcher, sequence
// order and replay, resync, the snapshot hand-over, monitoring coverage, and tenant isolation of
// open streams (ADV-T02). Timers are shortened; the rules are the same.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createKysely, createPool, withTenantTransaction, type Pool } from '@sentryops/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { publish } from '../src/services/realtime.ts';
import { runDispatcher, sweepStaleStreams } from '../src/workers/outbox.ts';
import {
  asOwner,
  asPhone,
  call,
  createGuard,
  enrollPhone,
  seedOrganization,
  signIn,
  startTestApp,
  type EnrolledPhone,
  type TestApp,
} from './support.ts';

const REVALIDATE_MS = 300;
const H = 3_600_000;
const MIN = 60_000;
const CENTER = { lat: 31.47, lng: 74.4 };

let t: TestApp;
let sweepPool: Pool;
let base: string;
let orgA: Awaited<ReturnType<typeof seedOrganization>>;
let orgB: Awaited<ReturnType<typeof seedOrganization>>;
let adminA: string;
let adminB: string;
let siteA: string;
let mono = 9_000_000;

const dispatch = () => runDispatcher({ ...t.deps, sweep: createKysely(sweepPool) });

type Received = { id: string | null; type: string; data: Record<string, unknown> };

/** A dashboard's stream, read the way the browser reads it: frames separated by blank lines. */
async function openStream(options: {
  cookie: string;
  org: string;
  lastEventId?: number;
  client?: 'phone' | 'desktop';
}) {
  const controller = new AbortController();
  const headers: Record<string, string> = {
    cookie: options.cookie,
    'x-organization-id': options.org,
    'x-sentry-csrf': '1',
    accept: 'text/event-stream',
  };
  if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId);
  const query = options.client ? `?client=${options.client}` : '';
  const res = await fetch(`${base}/api/v1/stream${query}`, { headers, signal: controller.signal });
  const events: Received[] = [];
  let closed = res.status !== 200;
  const parse = (block: string) => {
    let id: string | null = null;
    let type = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('event: ')) type = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (data.length > 0) {
      const envelope = JSON.parse(data.join('\n')) as { data: Record<string, unknown> };
      events.push({ id, type, data: envelope.data });
    }
  };
  if (res.status === 200 && res.body) {
    void (async () => {
      const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
          }
        }
      } catch {
        // aborted by the test
      } finally {
        closed = true;
      }
    })();
  }
  const until = async (condition: () => boolean, what: string, timeoutMs = 5_000) => {
    const deadline = performance.now() + timeoutMs;
    while (!condition()) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return {
    status: res.status,
    headers: res.headers,
    body: res.status === 200 ? null : ((await res.json()) as { error: { code: string } }),
    events,
    isClosed: () => closed,
    close: () => controller.abort(),
    waitFor: (predicate: (e: Received) => boolean, what: string) => until(() => events.some(predicate), what),
    waitClosed: (timeoutMs: number) => until(() => closed, 'the stream to close', timeoutMs),
  };
}

async function snapshot(cookie: string, org: string) {
  const res = await call(t.app, { method: 'GET', url: '/api/v1/dashboard/snapshot', cookie, org });
  expect(res.statusCode).toBe(200);
  return res.json<{
    lastEventId: number;
    guards: { shiftId: string }[];
    coverage: { desktop: number; phone: number };
    shiftsNotStarted: number;
  }>();
}

/** A guard on an active shift at site A, with an enrolled phone. */
async function onShift(): Promise<{ phone: EnrolledPhone; shiftId: string }> {
  const number = `+92300555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const guardId = await createGuard(t.app, adminA, orgA.id, {
    employeeNumber: `RT-${number.slice(-4)}`,
    displayName: `Realtime ${number.slice(-4)}`,
    phone: number,
  });
  const phone = await enrollPhone(t.app, adminA, orgA.id, guardId, number);
  const startsAt = new Date(t.clock.now().getTime() + 5 * MIN);
  const created = await call(t.app, {
    method: 'POST',
    url: '/api/v1/shifts',
    cookie: adminA,
    org: orgA.id,
    body: {
      guardId,
      siteId: siteA,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 8 * H).toISOString(),
    },
  });
  const shiftId = created.json<{ id: string }>().id;
  const res = await sync(phone, [
    {
      type: 'SHIFT_START',
      shiftId,
      fix: { lat: CENTER.lat, lon: CENTER.lng, accuracyM: 8, fixAgeS: 2 },
      permission: { location: 'ALWAYS', precise: true },
    },
  ]);
  expect(res[0]).toBe('ACCEPTED');
  return { phone, shiftId };
}

async function sync(phone: EnrolledPhone, items: Record<string, unknown>[]): Promise<string[]> {
  const res = await asPhone(t.app, phone, {
    method: 'POST',
    url: '/api/v1/sync/batch',
    body: {
      batchId: randomUUID(),
      sentAt: t.clock.now().toISOString(),
      sentMonoMs: (mono += 1000),
      bootId: 'boot-rt',
      items: items.map((i) => ({
        clientEventId: randomUUID(),
        recordedAt: new Date(t.clock.now().getTime() - 1000).toISOString(),
        monoMs: mono - 1000,
        bootId: 'boot-rt',
        ...i,
      })),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ results: { status: string }[] }>().results.map((r) => r.status);
}

beforeAll(async () => {
  t = await startTestApp({ realtime: { revalidateMs: REVALIDATE_MS, keepAliveMs: 200, catchUpMs: 1_000 } });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  sweepPool = createPool(t.db.urls.system_worker, { max: 2 });
  orgA = await seedOrganization(t.db, 'Stream A', [
    { email: 'admin@stream-a.test', role: 'ADMIN' },
    { email: 'watcher@stream-a.test', role: 'DISPATCHER' },
    { email: 'leaver@stream-a.test', role: 'SUPERVISOR' },
  ]);
  orgB = await seedOrganization(t.db, 'Stream B', [{ email: 'admin@stream-b.test', role: 'ADMIN' }]);
  adminA = await signIn(t.app, 'admin@stream-a.test');
  adminB = await signIn(t.app, 'admin@stream-b.test');
  const site = await call(t.app, {
    method: 'POST',
    url: '/api/v1/sites',
    cookie: adminA,
    org: orgA.id,
    body: { name: 'Gate', boundary: { kind: 'CIRCLE', center: CENTER, radiusM: 300 } },
  });
  siteA = site.json<{ id: string }>().id;
});

afterAll(async () => {
  // The worker's pool first: dropping the test database would cut its idle connection.
  await sweepPool?.end();
  await t?.close();
});

describe('outbox and dispatcher (ARCH §14, §16.1)', () => {
  it('numbers committed events after commit, in order, and keeps only IDs', async () => {
    await dispatch(); // anything left from setup
    const first = randomUUID();
    const second = randomUUID();
    await withTenantTransaction(t.deps.db, orgA.id, (trx) =>
      publish(trx, t.deps, orgA.id, 'shift.updated', { shiftId: first }),
    );
    // A change that rolls back leaves no event behind.
    await expect(
      withTenantTransaction(t.deps.db, orgA.id, async (trx) => {
        await publish(trx, t.deps, orgA.id, 'shift.updated', { shiftId: randomUUID() });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await withTenantTransaction(t.deps.db, orgA.id, (trx) =>
      publish(trx, t.deps, orgA.id, 'shift.updated', { shiftId: second }),
    );
    await dispatch();
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ seq: string; payload: Record<string, string> }>(
        `select seq, payload from realtime_events where organization_id = $1 order by seq desc limit 2`,
        [orgA.id],
      ),
    );
    expect(rows.map((r) => r.payload.shiftId)).toEqual([second, first]);
    expect(Number(rows[0]!.seq)).toBe(Number(rows[1]!.seq) + 1);
    const pending = await asOwner(t.db, (c) =>
      c.query('select 1 from outbox where organization_id = $1 and processed_at is null', [orgA.id]),
    );
    expect(pending.rowCount).toBe(0);
  });

  it('prunes the buffer but keeps the sequence going: it never restarts', async () => {
    const newest = (await snapshot(adminA, orgA.id)).lastEventId;
    // Everything in the buffer is older than its 5 minutes now.
    await asOwner(t.db, (c) =>
      c.query(
        `update realtime_events set created_at = $2::timestamptz - interval '1 day' where organization_id = $1`,
        [orgA.id, t.clock.now()],
      ),
    );
    const next = async () => {
      await withTenantTransaction(t.deps.db, orgA.id, (trx) =>
        publish(trx, t.deps, orgA.id, 'shift.updated', { shiftId: randomUUID() }),
      );
      await dispatch();
    };
    await next();
    const left = await asOwner(t.db, (c) =>
      c.query<{ seq: string }>('select seq from realtime_events where organization_id = $1', [orgA.id]),
    );
    expect(left.rows.map((r) => Number(r.seq))).toEqual([newest + 1]);
    await next();
    expect((await snapshot(adminA, orgA.id)).lastEventId).toBe(newest + 2);
  });
});

describe('the stream (ARCH §14)', () => {
  it('continues exactly where the snapshot ended, with the current state of each guard', async () => {
    const { phone, shiftId } = await onShift();
    await dispatch();
    const snap = await snapshot(adminA, orgA.id);
    expect(snap.guards.map((g) => g.shiftId)).toContain(shiftId);
    const stream = await openStream({ cookie: adminA, org: orgA.id, lastEventId: snap.lastEventId });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    // A compressing proxy (the dashboard's dev server) would otherwise hold events back.
    expect(stream.headers.get('cache-control')).toContain('no-transform');
    try {
      t.clock.advance(30_000);
      mono += 30_000;
      expect(
        await sync(phone, [
          { type: 'LOCATION', shiftId, fix: { lat: CENTER.lat, lon: CENTER.lng, accuracyM: 9 } },
        ]),
      ).toEqual(['ACCEPTED']);
      await dispatch();
      await stream.waitFor((e) => e.type === 'guard.state', 'guard.state');
      const event = stream.events.find((e) => e.type === 'guard.state')!;
      expect(Number(event.id)).toBeGreaterThan(snap.lastEventId);
      const guard = event.data.guard as { shiftId: string; trackingHealth: string; lastFix: unknown };
      expect(guard.shiftId).toBe(shiftId);
      expect(guard.trackingHealth).toBe('LIVE');
      expect(guard.lastFix).not.toBeNull();
    } finally {
      stream.close();
    }
  });

  it('replays what a reconnecting dashboard missed, in order, and asks it to resync when that is gone', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const shiftId = randomUUID();
      ids.push(shiftId);
      await withTenantTransaction(t.deps.db, orgA.id, (trx) =>
        publish(trx, t.deps, orgA.id, 'shift.updated', { shiftId }),
      );
    }
    await dispatch();
    // Other events (a dashboard closing elsewhere) may sit between these three; replay keeps them all.
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ seq: string }>(
        `select seq from realtime_events where organization_id = $1 and payload->>'shiftId' = any($2) order by seq`,
        [orgA.id, ids],
      ),
    );
    const seqs = rows.map((r) => Number(r.seq));
    const newest = (await snapshot(adminA, orgA.id)).lastEventId;

    const replay = await openStream({ cookie: adminA, org: orgA.id, lastEventId: seqs[0]! - 1 });
    try {
      await replay.waitFor((e) => e.id === String(newest), 'the newest event');
      const received = replay.events.map((e) => Number(e.id));
      expect(received).toEqual([...received].sort((a, b) => a - b));
      expect(received[0]).toBe(seqs[0]);
      const mine = replay.events.filter((e) => ids.includes(String(e.data.shiftId)));
      expect(mine.map((e) => e.data.shiftId)).toEqual(ids);
      expect(mine.map((e) => Number(e.id))).toEqual(seqs);
    } finally {
      replay.close();
    }

    // From the future (a restored database): resync.
    const future = await openStream({ cookie: adminA, org: orgA.id, lastEventId: newest + 1000 });
    try {
      await future.waitFor((e) => e.type === 'resync', 'resync');
    } finally {
      future.close();
    }

    // Already pruned from the buffer: resync too.
    await asOwner(t.db, (c) =>
      c.query('delete from realtime_events where organization_id = $1 and seq < $2', [orgA.id, newest]),
    );
    const pruned = await openStream({ cookie: adminA, org: orgA.id, lastEventId: newest - 3 });
    try {
      await pruned.waitFor((e) => e.type === 'resync', 'resync');
    } finally {
      pruned.close();
    }
  });

  it('counts open dashboards for monitoring coverage, desktops and phones (PROD §11.5)', async () => {
    const empty = await snapshot(adminB, orgB.id);
    expect(empty.coverage).toEqual({ desktop: 0, phone: 0 });
    const desk = await openStream({ cookie: adminB, org: orgB.id });
    const phone = await openStream({ cookie: adminB, org: orgB.id, client: 'phone' });
    try {
      expect((await snapshot(adminB, orgB.id)).coverage).toEqual({ desktop: 1, phone: 1 });
      await dispatch();
      await desk.waitFor((e) => e.type === 'coverage.updated', 'coverage.updated');
    } finally {
      desk.close();
      phone.close();
    }
    const deadline = performance.now() + 5_000;
    const watching = async () => {
      const { coverage } = await snapshot(adminB, orgB.id);
      return coverage.desktop + coverage.phone;
    };
    while ((await watching()) > 0 && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await snapshot(adminB, orgB.id)).coverage).toEqual({ desktop: 0, phone: 0 });
  });

  it('removes streams that a stopped API instance left behind', async () => {
    const userId = orgB.members['admin@stream-b.test']!.userId;
    await asOwner(t.db, (c) =>
      c.query(
        `insert into stream_connections (id, organization_id, user_id, client, instance_id, connected_at, last_seen_at)
         values ($1, $2, $3, 'DESKTOP', 'gone', $4, $4)`,
        [randomUUID(), orgB.id, userId, new Date(t.clock.now().getTime() - 10 * MIN)],
      ),
    );
    expect(await sweepStaleStreams({ ...t.deps, sweep: createKysely(sweepPool) })).toBe(1);
  });
});

describe('tenant isolation of the stream (SEC §4)', () => {
  it("ADV-T02 a stream for another organization's ID is refused before anything is sent", async () => {
    const stream = await openStream({ cookie: adminA, org: orgB.id });
    expect(stream.status).toBe(403);
    expect(stream.body?.error.code).toBe('FORBIDDEN');
    expect(t.app.realtime.streamsOf(orgA.members['admin@stream-a.test']!.userId)).toBe(0);
  });

  it('ADV-T02 a stream never carries another organization’s events', async () => {
    await dispatch();
    const stream = await openStream({ cookie: adminA, org: orgA.id });
    try {
      const secret = randomUUID();
      await withTenantTransaction(t.deps.db, orgB.id, (trx) =>
        publish(trx, t.deps, orgB.id, 'shift.updated', { shiftId: secret }),
      );
      const mine = randomUUID();
      await withTenantTransaction(t.deps.db, orgA.id, (trx) =>
        publish(trx, t.deps, orgA.id, 'shift.updated', { shiftId: mine }),
      );
      await dispatch();
      await stream.waitFor((e) => e.data.shiftId === mine, "A's own event");
      expect(stream.events.some((e) => JSON.stringify(e).includes(secret))).toBe(false);
    } finally {
      stream.close();
    }
  });

  it('ADV-T02 a stream kept open after the membership is removed is closed within 60 s, with nothing more sent', async () => {
    const leaver = await signIn(t.app, 'leaver@stream-a.test');
    const stream = await openStream({ cookie: leaver, org: orgA.id });
    expect(stream.status).toBe(200);
    await asOwner(t.db, (c) =>
      c.query(`update organization_members set status = 'REMOVED' where id = $1`, [
        orgA.members['leaver@stream-a.test']!.memberId,
      ]),
    );
    const removedAt = performance.now();
    await stream.waitClosed(60_000);
    // Re-checked every REVALIDATE_MS here; every 30 s in production, so well within 60 s.
    expect(performance.now() - removedAt).toBeLessThan(5_000);
    const received = stream.events.length;
    await withTenantTransaction(t.deps.db, orgA.id, (trx) =>
      publish(trx, t.deps, orgA.id, 'shift.updated', { shiftId: randomUUID() }),
    );
    await dispatch();
    await new Promise((r) => setTimeout(r, 300));
    expect(stream.events.length).toBe(received);
  });

  it('ADV-T02 signing out ends the open stream', async () => {
    const watcher = await signIn(t.app, 'watcher@stream-a.test');
    const stream = await openStream({ cookie: watcher, org: orgA.id });
    expect(stream.status).toBe(200);
    const out = await call(t.app, { method: 'POST', url: '/api/v1/auth/logout', cookie: watcher });
    expect(out.statusCode).toBe(200);
    await stream.waitClosed(5_000);
  });
});
