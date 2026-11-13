// The load and simulator harness (ARCH §19.2, §21.2, PLAN A5). Simulated guard phones go through the
// real API (enrolled devices, real sessions, signed-in order, the real sync pipeline against a real
// PostgreSQL with row-level security), in this process, against an embedded database. It measures
// the ARCH §18.3 targets and counts rows, so "nothing was lost" is a measured fact.
//
// What a run on one computer means: it measures this computer, one PostgreSQL, one API process, no
// network and no TLS. The numbers are a baseline and a regression guard, not a promise about
// production, whose infrastructure is larger and different. The targets are compared only where the
// run was as large as the target's own wording; otherwise the row says "not comparable".
//
//   pnpm load                              (200 phones, a 15-minute night: a few minutes)
//   LOAD_PHONES=1000 LOAD_NIGHT_MINUTES=60 pnpm load      (the full wording of the scenarios)
//
// The report is printed and written to .local/load-report.md.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { createKysely, createPool, type Pool } from '@sentryops/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SOS_POOL_SIZE } from '../src/server.ts';
import { runDispatcher } from '../src/workers/outbox.ts';
import { runSender } from '../src/workers/notifications.ts';
import { browserSubscription, fakeProviders } from '../test/fake-providers.ts';
import {
  asOwner,
  asPhone,
  call,
  createGuard,
  enrollPhone,
  refreshPhone,
  seedOrganization,
  signIn,
  startTestApp,
  type EnrolledPhone,
  type TestApp,
} from '../test/support.ts';
import { mapLimit, ms, Report, Samples, timed } from './stats.ts';

const PHONES = Number(process.env.LOAD_PHONES ?? 200);
const NIGHT_MINUTES = Number(process.env.LOAD_NIGHT_MINUTES ?? 15);
const NIGHT_GUARDS = Math.min(100, PHONES);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 8);
const SOS_PRESSES = Number(process.env.LOAD_SOS ?? 10);

const MIN = 60_000;
const H = 3_600_000;
const BOOT = 'load-boot';
const SITE = { lat: 31.47, lon: 74.4 };
const AT_SITE = { lat: 31.4702, lon: 74.4001, accuracyM: 8 };
// About 700 m east of the site centre: outside its 300 m circle.
const OFF_SITE = { lat: 31.47, lon: 74.4065, accuracyM: 8 };

type Phone = EnrolledPhone & { shiftId: string };

const report = new Report();
let t: TestApp;
let sweepPool: Pool;
let admin: string;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let phones: Phone[] = [];
let t0 = 0;
const providers = fakeProviders();

/** The phone's monotonic clock: starts at 1,000,000 ms at t0 and moves with the simulated time. */
const mono = () => 1_000_000 + (t.clock.now().getTime() - t0);

type Item = Record<string, unknown>;
const item = (type: string, fields: Item, agoMs: number): Item => ({
  clientEventId: randomUUID(),
  type,
  recordedAt: new Date(t.clock.now().getTime() - agoMs).toISOString(),
  monoMs: Math.max(0, mono() - agoMs),
  bootId: BOOT,
  ...fields,
});

/** Server errors answered during the run: the phones retry them, as the app does, and they are counted. */
let serverErrors = 0;

async function send(phone: Phone, items: Item[]): Promise<{ ms: number; statuses: string[] }> {
  for (let attempt = 1; ; attempt++) {
    const { value, ms: elapsed } = await timed(() =>
      asPhone(t.app, phone, {
        method: 'POST',
        url: '/api/v1/sync/batch',
        body: {
          batchId: randomUUID(),
          sentAt: t.clock.now().toISOString(),
          sentMonoMs: mono(),
          bootId: BOOT,
          items,
        },
      }),
    );
    if (value.statusCode === 200) {
      const results = value.json<{ results: { status: string }[] }>().results;
      return { ms: elapsed, statuses: results.map((r) => r.status) };
    }
    if (value.statusCode === 401 && attempt === 1) {
      // The access token lapsed (15 minutes of simulated time): renew it and send again, as the app does.
      await refreshPhone(t.app, phone);
      continue;
    }
    if (value.statusCode < 500 || attempt >= 8) {
      throw new Error(`sync failed: ${value.statusCode} ${value.body}`);
    }
    // The app's own rule: back off and send the same items again (idempotent per item, INV-06).
    serverErrors++;
    await new Promise((r) => setTimeout(r, 250 * attempt));
  }
}

const points = async (shiftIds: string[]) =>
  Number(
    (
      await asOwner(t.db, (c) =>
        c.query<{ n: string }>(
          'select count(*)::text as n from location_points where shift_id = any($1::uuid[])',
          [shiftIds],
        ),
      )
    ).rows[0]?.n ?? 0,
  );

/** Counts what a scenario accepted, so nothing is "assumed" stored. */
const accepted = (statuses: string[]) => statuses.filter((s) => s === 'ACCEPTED').length;

beforeAll(async () => {
  console.log(
    `\nLoad harness: ${PHONES} phones, ${NIGHT_GUARDS} on a ${NIGHT_MINUTES}-minute night, concurrency ${CONCURRENCY}`,
  );
  t = await startTestApp({
    notify: providers,
    config: { FEATURE_SOS: true },
    // Server errors are printed: a 500 under load is a finding, not noise.
    logger: { level: 'error' },
    // The API's own pool size (packages/db createPool): saturating it is part of what is measured.
    poolMax: Number(process.env.LOAD_POOL ?? 10),
    // And its SOS pool (server.ts, review L-27), so the SOS figures are the API's.
    sosPoolMax: SOS_POOL_SIZE,
  });
  // The harness is one process behind one address: the limits that protect the real service from a
  // single phone are not what is being measured here.
  (t.deps as { rateLimiter: unknown }).rateLimiter = { hit: () => undefined };
  sweepPool = createPool(t.db.urls.system_worker, { max: 4 });
  org = await seedOrganization(t.db, 'Load Co', [{ email: 'admin@load.test', role: 'ADMIN' }]);
  admin = await signIn(t.app, 'admin@load.test');
  const site = await call(t.app, {
    method: 'POST',
    url: '/api/v1/sites',
    cookie: admin,
    org: org.id,
    body: {
      name: 'Gate',
      boundary: { kind: 'CIRCLE', center: { lat: SITE.lat, lng: SITE.lon }, radiusM: 300 },
    },
  });
  const siteId = site.json<{ id: string }>().id;
  t0 = t.clock.now().getTime();

  const setup = await timed(() =>
    mapLimit(
      Array.from({ length: PHONES }, (_, i) => i),
      8,
      async (i) => {
        const number = `+9230${String(30_000_000 + i)}`;
        const guardId = await createGuard(t.app, admin, org.id, {
          employeeNumber: `L-${i}`,
          displayName: `Load ${i}`,
          phone: number,
        });
        const phone = await enrollPhone(t.app, admin, org.id, guardId, number);
        const startsAt = new Date(t0 + 5 * MIN);
        const created = await call(t.app, {
          method: 'POST',
          url: '/api/v1/shifts',
          cookie: admin,
          org: org.id,
          body: {
            guardId,
            siteId,
            startsAt: startsAt.toISOString(),
            endsAt: new Date(startsAt.getTime() + 8 * H).toISOString(),
          },
        });
        const shiftId = created.json<{ id: string }>().id;
        const started = await send({ ...phone, shiftId }, [
          item(
            'SHIFT_START',
            { shiftId, fix: { ...AT_SITE, fixAgeS: 2 }, permission: { location: 'ALWAYS', precise: true } },
            1000,
          ),
        ]);
        if (started.statuses[0] !== 'ACCEPTED') throw new Error(`shift start ${i}: ${started.statuses[0]}`);
        return { ...phone, shiftId };
      },
    ),
  );
  phones = setup.value;
  report.add({
    scenario: 'setup',
    measure: `${PHONES} guards enrolled, shift created and started`,
    result: `${(setup.ms / 1000).toFixed(1)} s`,
    target: '—',
    verdict: 'info',
  });
});

afterAll(async () => {
  report.write(join(import.meta.dirname, '..', '..', '..', '.local', 'load-report.md'), [
    '# Load baseline',
    '',
    `Run: ${new Date().toISOString()} · ${PHONES} phones · ${NIGHT_GUARDS} guards on a ${NIGHT_MINUTES}-minute night · concurrency ${CONCURRENCY}`,
    '',
    'One computer, one PostgreSQL, one API process, no network, no TLS. A baseline for regressions, not a statement about production.',
  ]);
  await sweepPool?.end();
  await t?.close();
});

describe('load and simulator harness (ARCH §19.2)', () => {
  it('a reconnection storm: every phone uploads a 60-minute backlog at once, and nothing is lost', async () => {
    // The phones were out of coverage for an hour; sessions expired meanwhile and are renewed first.
    t.clock.advance(61 * MIN);
    const renew = new Samples();
    await mapLimit(phones, CONCURRENCY, async (p) => {
      const { ms: elapsed } = await timed(() => refreshPhone(t.app, p));
      renew.add(elapsed);
    });

    // 60 locations and 60 heartbeats per phone, oldest first: two batches (100 + 20).
    const backlog = (p: Phone): Item[] =>
      Array.from({ length: 60 }, (_, k) => {
        const ago = (60 - k) * MIN;
        return [
          item('LOCATION', { shiftId: p.shiftId, fix: AT_SITE }, ago),
          item('HEARTBEAT', { shiftId: p.shiftId }, ago - 1000),
        ];
      }).flat();
    const batches = new Samples();
    let sent = 0;
    let acceptedItems = 0;
    const storm = await timed(() =>
      mapLimit(phones, CONCURRENCY, async (p) => {
        const items = backlog(p);
        for (let from = 0; from < items.length; from += 100) {
          const chunk = items.slice(from, from + 100);
          const result = await send(p, chunk);
          batches.add(result.ms);
          sent += chunk.length;
          acceptedItems += accepted(result.statuses);
        }
      }),
    );
    expect(acceptedItems).toBe(sent);
    expect(await points(phones.map((p) => p.shiftId))).toBe(PHONES * 60);

    report.add({
      scenario: 'reconnection storm',
      measure: `${PHONES} phones × 120 items drained`,
      result: `${(storm.ms / 1000).toFixed(1)} s`,
      target: '1,000 phones within 2 min',
      verdict: PHONES < 1000 ? 'not comparable' : storm.ms <= 120_000 ? 'within' : 'above',
    });
    report.add({
      scenario: 'reconnection storm',
      measure: 'items stored of items sent',
      result: `${acceptedItems} of ${sent}`,
      target: 'all',
      verdict: acceptedItems === sent ? 'within' : 'above',
    });
    report.add({
      scenario: 'reconnection storm',
      measure: `batch latency (${batches.count} batches, ≤ 100 items), p50 / p95 / max`,
      result: `${ms(batches.p(50))} / ${ms(batches.p(95))} / ${ms(Math.max(...batches.values))}`,
      target: 'p95 ≤ 300 ms (100 items, normal load)',
      verdict: 'info',
    });
    report.add({
      scenario: 'session renewal',
      measure: `${renew.count} renewals, p95`,
      result: ms(renew.p(95)),
      target: '—',
      verdict: 'info',
    });
  });

  it('the dashboard snapshot with every phone on duty', async () => {
    const samples = new Samples();
    let guards = 0;
    for (let i = 0; i < 20; i++) {
      const { value, ms: elapsed } = await timed(() =>
        call(t.app, { method: 'GET', url: '/api/v1/dashboard/snapshot', cookie: admin, org: org.id }),
      );
      expect(value.statusCode, value.body).toBe(200);
      guards = value.json<{ guards?: unknown[]; shifts?: unknown[] }>().guards?.length ?? guards;
      samples.add(elapsed);
    }
    report.add({
      scenario: 'dashboard snapshot',
      measure: `${PHONES} active guards, 20 requests, p95 (${guards} in the answer)`,
      result: ms(samples.p(95)),
      target: 'p95 ≤ 1 s with 1,000 active guards',
      verdict: PHONES < 1000 ? 'not comparable' : samples.p(95) <= 1000 ? 'within' : 'above',
    });
  });

  it('a normal night: the guards send a heartbeat and a position every minute', async () => {
    const guards = phones.slice(0, NIGHT_GUARDS);
    const latency = new Samples();
    const full = new Samples();
    let sent = 0;
    let acceptedItems = 0;
    const night = await timed(async () => {
      for (let minute = 1; minute <= NIGHT_MINUTES; minute++) {
        t.clock.advance(MIN);
        // Access tokens last 15 minutes: the phones renew them in time, as the app does.
        if (minute % 10 === 0) await mapLimit(guards, CONCURRENCY, (p) => refreshPhone(t.app, p));
        await mapLimit(guards, CONCURRENCY, async (p) => {
          const items = [
            item('HEARTBEAT', { shiftId: p.shiftId }, 500),
            item('LOCATION', { shiftId: p.shiftId, fix: AT_SITE }, 500),
          ];
          const result = await send(p, items);
          latency.add(result.ms);
          sent += items.length;
          acceptedItems += accepted(result.statuses);
        });
      }
    });
    expect(acceptedItems).toBe(sent);

    // 100 items in one batch, the size the target is written for.
    const hundred = guards[0] as Phone;
    for (let i = 0; i < 20; i++) {
      const items = Array.from({ length: 50 }, (_, k) => [
        item('LOCATION', { shiftId: hundred.shiftId, fix: AT_SITE }, (50 - k) * 1000),
        item('HEARTBEAT', { shiftId: hundred.shiftId }, (50 - k) * 1000 - 100),
      ]).flat();
      const result = await send(hundred, items);
      full.add(result.ms);
      expect(accepted(result.statuses)).toBe(100);
    }

    report.add({
      scenario: 'normal night',
      measure: `${NIGHT_GUARDS} guards × ${NIGHT_MINUTES} min, ${latency.count} batches of 2 items, p95`,
      result: `${ms(latency.p(95))} (${(night.ms / 1000).toFixed(0)} s wall)`,
      target: '—',
      verdict: 'info',
    });
    report.add({
      scenario: 'sync batch of 100 items',
      measure: `20 batches, p50 / p95`,
      result: `${ms(full.p(50))} / ${ms(full.p(95))}`,
      target: 'p95 ≤ 300 ms',
      verdict: full.p(95) <= 300 ? 'within' : 'above',
    });
    report.add({
      scenario: 'normal night',
      measure: 'items stored of items sent',
      result: `${acceptedItems} of ${sent}`,
      target: 'all',
      verdict: acceptedItems === sent ? 'within' : 'above',
    });
  });

  it('thirty minutes offline, then one upload', async () => {
    const p = phones[PHONES - 1] as Phone;
    const before = await points([p.shiftId]);
    const items = Array.from({ length: 30 }, (_, k) => [
      item('LOCATION', { shiftId: p.shiftId, fix: AT_SITE }, (30 - k) * MIN),
      item('HEARTBEAT', { shiftId: p.shiftId }, (30 - k) * MIN - 1000),
    ]).flat();
    const result = await send(p, items);
    expect(accepted(result.statuses)).toBe(60);
    expect(await points([p.shiftId])).toBe(before + 30);
    report.add({
      scenario: 'offline 30 minutes',
      measure: '60 items in one upload, all stored',
      result: `${accepted(result.statuses)} of 60 · ${ms(result.ms)}`,
      target: 'all',
      verdict: 'within',
    });
  });

  it('a guard leaves the site and the control room hears about it', async () => {
    const p = phones[Math.min(1, PHONES - 1)] as Phone;
    for (let minute = 0; minute < 10; minute++) {
      t.clock.advance(MIN);
      await send(p, [item('LOCATION', { shiftId: p.shiftId, fix: OFF_SITE }, 500)]);
    }
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ type: string }>('select type from alerts where organization_id = $1 and shift_id = $2', [
        org.id,
        p.shiftId,
      ]),
    );
    const others = await asOwner(t.db, (c) =>
      c.query('select 1 from alerts where organization_id = $1 and type = $2 and shift_id <> $3', [
        org.id,
        'GUARD_LEFT_SITE',
        p.shiftId,
      ]),
    );
    expect(rows.map((r) => r.type)).toContain('GUARD_LEFT_SITE');
    expect(others.rowCount).toBe(0);
    report.add({
      scenario: 'guard leaves the site',
      measure: '10 minutes outside: "left site" alert opened for that guard only',
      result: 'yes',
      target: 'alert for the one guard',
      verdict: 'within',
    });
  });

  it('SOS presses while the guards keep reporting: to the dashboard and to a first push', async () => {
    // A supervisor's browser is subscribed, so the ladder has a first push to send.
    const sub = await call(t.app, {
      method: 'POST',
      url: '/api/v1/push-subscriptions',
      cookie: admin,
      org: org.id,
      body: browserSubscription('DESKTOP'),
    });
    expect(sub.statusCode, sub.body).toBe(201);

    const workerDeps = { ...t.deps, sweep: createKysely(sweepPool) };
    let running = true;
    const loops = [
      (async () => {
        while (running) {
          await runDispatcher(workerDeps);
          await new Promise((r) => setTimeout(r, 500));
        }
      })(),
      (async () => {
        while (running) {
          await runSender(workerDeps);
          await new Promise((r) => setTimeout(r, 1000));
        }
      })(),
    ];

    const toDashboard = new Samples();
    const toPush = new Samples();
    const events = async () =>
      Number(
        (
          await asOwner(t.db, (c) =>
            c.query<{ n: string }>(
              `select count(*)::text as n from realtime_events where organization_id = $1 and type like 'sos%'`,
              [org.id],
            ),
          )
        ).rows[0]?.n ?? 0,
      );
    const sentAt = async (sosEventId: string) =>
      (
        await asOwner(t.db, (c) =>
          c.query<{ alert_sent_at: Date | null }>('select alert_sent_at from sos_events where id = $1', [
            sosEventId,
          ]),
        )
      ).rows[0]?.alert_sent_at ?? null;

    try {
      for (let i = 0; i < SOS_PRESSES; i++) {
        // A different guard each time: one open SOS per guard (PROD §11), so none is a re-trigger.
        const p = phones[i % PHONES] as Phone;
        await refreshPhone(t.app, p);
        const eventsBefore = await events();
        const start = performance.now();
        const res = await asPhone(t.app, p, {
          method: 'POST',
          url: '/api/v1/sos',
          body: {
            clientEventId: randomUUID(),
            recordedAt: t.clock.now().toISOString(),
            monoMs: mono(),
            bootId: BOOT,
            fix: null,
            sentMonoMs: mono(),
          },
        });
        expect(res.statusCode, res.body).toBe(200);
        const sosEventId = res.json<{ sosEventId: string }>().sosEventId;
        let dashboardAt: number | null = null;
        let pushAt: number | null = null;
        while ((dashboardAt === null || pushAt === null) && performance.now() - start < 30_000) {
          if (dashboardAt === null && (await events()) > eventsBefore)
            dashboardAt = performance.now() - start;
          if (pushAt === null && (await sentAt(sosEventId))) pushAt = performance.now() - start;
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(dashboardAt, 'no event reached the dashboard').not.toBeNull();
        expect(pushAt, 'no provider accepted a push').not.toBeNull();
        toDashboard.add(dashboardAt ?? 30_000);
        toPush.add(pushAt ?? 30_000);
      }
    } finally {
      running = false;
      await Promise.all(loops);
    }
    report.add({
      scenario: 'SOS',
      measure: `${SOS_PRESSES} presses, receipt → event for the dashboard, p95`,
      result: ms(toDashboard.p(95)),
      target: 'p95 ≤ 2 s',
      verdict: toDashboard.p(95) <= 2000 ? 'within' : 'above',
    });
    report.add({
      scenario: 'SOS',
      measure: `${SOS_PRESSES} presses, receipt → first provider-accepted push, p95`,
      result: ms(toPush.p(95)),
      target: 'p95 ≤ 10 s',
      verdict: toPush.p(95) <= 10_000 ? 'within' : 'above',
    });
    report.note(
      'SOS timings include the worker loops at their real cadence (outbox every 0.5 s, sender every 1 s) in this process; the push provider is a fake that accepts at once.',
    );
  });

  it('what this run did not measure', () => {
    report.add({
      scenario: 'server errors',
      measure: 'sync answers of 5xx that a phone retried',
      result: String(serverErrors),
      target: '—',
      verdict: 'info',
    });
    if (serverErrors > 0) {
      report.note(
        `${serverErrors} uploads were answered 500 and succeeded on retry: the API's database pool (${process.env.LOAD_POOL ?? 10} connections, 5 s wait) was saturated by the concurrent uploads. A phone retries with backoff, so nothing is lost, but a saturated pool answers 500 rather than "try again later".`,
      );
    }
    report.note(
      '500 dashboard streams (ARCH §19.2) are not in this harness yet: each browser needs its own sign-in and a stream is limited to 10 per user, so it needs a real listening server and many sessions.',
    );
    report.note(
      'A production-sized run needs production-sized infrastructure (separate database host, several API tasks, TLS and a load balancer in the path).',
    );
    expect(report.rows.every((r) => r.verdict !== 'above' || r.target !== 'all')).toBe(true);
  });
});
