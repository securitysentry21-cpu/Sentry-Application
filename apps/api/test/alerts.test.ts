// Alerts (PROD §12) and the geofence evaluator (PROD §8.4) through the API: dedupe, reopen
// suppression, departure and return from synced points, freshness detectors, shift-end
// auto-resolve, manual changes and their permissions. Items are built the way the guard app builds them.
import { randomUUID } from 'node:crypto';

import { defaultSettings, validateSettings, type SettingKey } from '@sentryops/contracts';
import { withTenantTransaction, type Database } from '@sentryops/db';
import { alertKey, freshnessConditions } from '@sentryops/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clearAlert, raiseAlert } from '../src/services/alerts.ts';
import { alertsForOrganization, applyForOrganization } from '../src/workers/detectors.ts';
import {
  asOwner,
  asPhone,
  call,
  createGuard,
  enrollPhone,
  errorCode,
  refreshPhone,
  seedOrganization,
  signIn,
  startTestApp,
  type EnrolledPhone,
  type TestApp,
} from './support.ts';

let t: TestApp;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let admin: string;
let supervisor: string;
let dispatcher: string;
let siteId: string;
let seq = 0;

const H = 3_600_000;
const MIN = 60_000;
const BOOT = 'boot-a';
const CENTER = { lat: 31.47, lng: 74.4 };
const INSIDE = { lat: 31.4701, lon: 74.4001, accuracyM: 8 };
/** About 1.1 km north of a 300 m circle. */
const OUTSIDE = { lat: 31.48, lon: 74.4, accuracyM: 10 };
let mono = 5_000_000;

type Item = Record<string, unknown>;

function item(type: string, fields: Item, agoMs = 1_000): Item {
  mono += 10;
  return {
    clientEventId: randomUUID(),
    type,
    recordedAt: new Date(t.clock.now().getTime() - agoMs).toISOString(),
    monoMs: mono - agoMs,
    bootId: BOOT,
    ...fields,
  };
}

async function send(phone: EnrolledPhone, items: Item[]) {
  const res = await asPhone(t.app, phone, {
    method: 'POST',
    url: '/api/v1/sync/batch',
    body: {
      batchId: randomUUID(),
      sentAt: t.clock.now().toISOString(),
      sentMonoMs: mono,
      bootId: BOOT,
      items,
    },
  });
  if (res.statusCode !== 200) throw new Error(`sync failed: ${res.statusCode} ${res.body}`);
  return res.json<{ results: { status: string; code?: string }[] }>();
}

/** Moves time on and sends one point captured just now, as an online phone does. */
async function pointAfter(phone: EnrolledPhone, shiftId: string, ms: number, fix: Item) {
  t.clock.advance(ms);
  mono += ms;
  const res = await send(phone, [item('LOCATION', { shiftId, fix })]);
  expect(res.results[0]?.status).toBe('ACCEPTED');
}

async function onShift(): Promise<{ phone: EnrolledPhone; shiftId: string; guardId: string }> {
  const number = `+9230033${String(10_000 + seq++).padStart(5, '0')}`;
  const guardId = await createGuard(t.app, admin, org.id, {
    employeeNumber: `AL-${number.slice(-5)}`,
    displayName: `Alert ${number.slice(-3)}`,
    phone: number,
  });
  const phone = await enrollPhone(t.app, admin, org.id, guardId, number);
  const startsAt = new Date(t.clock.now().getTime() + 5 * MIN);
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
  const started = await send(phone, [
    item('SHIFT_START', {
      shiftId,
      fix: { ...INSIDE, fixAgeS: 2 },
      permission: { location: 'ALWAYS', precise: true },
    }),
  ]);
  expect(started.results[0]?.status).toBe('ACCEPTED');
  return { phone, shiftId, guardId };
}

type AlertDto = {
  id: string;
  type: string;
  status: string;
  triggerCount: number;
  resolutionType: string | null;
  details: Record<string, unknown>;
  acknowledgedBy: { id: string } | null;
};

async function alertsFor(shiftId: string): Promise<AlertDto[]> {
  const res = await call(t.app, {
    method: 'GET',
    url: `/api/v1/alerts?status=all&shiftId=${shiftId}`,
    cookie: admin,
    org: org.id,
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ alerts: AlertDto[] }>().alerts;
}

const detectors = () => alertsForOrganization(t.deps, org.id);

async function seedAlert(type: string, shiftId: string | null, guardId: string | null): Promise<string> {
  const id = randomUUID();
  await asOwner(t.db, (c) =>
    c.query(
      `insert into alerts (id, organization_id, type, severity, dedupe_key, summary, guard_id, shift_id, opened_at, last_triggered_at)
       values ($1, $2, $3, 'CRITICAL', $4, 'Seeded', $5, $6, now(), now())`,
      [id, org.id, type, `seed:${id}`, guardId, shiftId],
    ),
  );
  return id;
}

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'Alert Co', [
    { email: 'admin@alert.test', role: 'ADMIN' },
    { email: 'sup@alert.test', role: 'SUPERVISOR' },
    { email: 'disp@alert.test', role: 'DISPATCHER' },
  ]);
  admin = await signIn(t.app, 'admin@alert.test');
  supervisor = await signIn(t.app, 'sup@alert.test');
  dispatcher = await signIn(t.app, 'disp@alert.test');
  const site = await call(t.app, {
    method: 'POST',
    url: '/api/v1/sites',
    cookie: admin,
    org: org.id,
    body: { name: 'Depot', boundary: { kind: 'CIRCLE', center: CENTER, radiusM: 300 } },
  });
  siteId = site.json<{ id: string }>().id;
});

afterAll(async () => {
  await t?.close();
});

describe('alert engine (PROD §12.3)', () => {
  it('ADV-AL01 a repeat trigger counts on the open alert instead of opening another', async () => {
    const intent = {
      type: 'GUARD_LEFT_SITE' as const,
      dedupeKey: `test:${randomUUID()}`,
      summary: 'Left site',
    };
    const run = <T>(fn: (trx: Database) => Promise<T>) => withTenantTransaction(t.deps.db, org.id, fn);
    const first = await run((trx) => raiseAlert(trx, t.deps, org.id, intent, 120_000));
    const second = await run((trx) => raiseAlert(trx, t.deps, org.id, intent, 120_000));
    expect(first?.outcome).toBe('OPENED');
    expect(second).toEqual({ alertId: first?.alertId, outcome: 'RETRIGGERED' });
    const rows = await asOwner(t.db, (c) =>
      c.query<{ trigger_count: number }>('select trigger_count from alerts where dedupe_key = $1', [
        intent.dedupeKey,
      ]),
    );
    expect(rows.rows).toEqual([{ trigger_count: 2 }]);

    // Cleared, then back within the suppression window: the same alert reopens (no flapping storm).
    await run((trx) => clearAlert(trx, t.deps, org.id, intent.dedupeKey, 'CONDITION_CLEARED'));
    t.clock.advance(MIN);
    expect(await run((trx) => raiseAlert(trx, t.deps, org.id, intent, 120_000))).toEqual({
      alertId: first?.alertId,
      outcome: 'REOPENED',
    });
    // Cleared, and back after the window: a new alert.
    await run((trx) => clearAlert(trx, t.deps, org.id, intent.dedupeKey, 'CONDITION_CLEARED'));
    t.clock.advance(3 * MIN);
    const later = await run((trx) => raiseAlert(trx, t.deps, org.id, intent, 120_000));
    expect(later?.outcome).toBe('OPENED');
    expect(later?.alertId).not.toBe(first?.alertId);
  });

  it('ADV-AL05 simulated healthy phones never trip a freshness alert under any valid settings', () => {
    // A healthy phone: a fix every fixEvery seconds, a heartbeat every heartbeat seconds, uploads every
    // upload seconds, each on a location callback up to SLACK seconds late. Checked at the worst
    // moment (just before the next upload) for every combination on the grid that the settings
    // validator accepts, with every threshold at the lowest value the rules allow.
    const SLACK = 30;
    let valid = 0;
    for (const heartbeat of [30, 60, 120, 300]) {
      for (const upload of [15, 30, 60, 120, 300]) {
        for (const maxInterval of [30, 60, 120, 300]) {
          for (const stationary of [60, 120, 300, 900]) {
            const offlineAfter = Math.max(60, 3 * heartbeat);
            const candidate: Record<string, unknown> = {
              ...defaultSettings(),
              'sync.heartbeat_interval_s': heartbeat,
              'sync.upload_interval_s': upload,
              'tracking.max_interval_s': maxInterval,
              'tracking.min_interval_s': Math.min(15, maxInterval),
              'tracking.stationary_fix_interval_s': stationary,
              'freshness.health_live_max_s': heartbeat + 30,
              'freshness.offline_after_s': offlineAfter,
              'freshness.location_current_max_s': maxInterval + upload + 30,
              'freshness.location_stale_after_s': Math.max(60, stationary + upload + 60),
              'alerts.device_offline_after_s': offlineAfter,
            };
            if (!validateSettings(candidate).success) continue;
            valid++;
            const n = (key: SettingKey) => candidate[key] as number;
            const settings = {
              deviceOfflineAfterS: n('alerts.device_offline_after_s'),
              locationStaleAfterS: n('freshness.location_stale_after_s'),
              inContactMaxS: n('freshness.offline_after_s'),
              detectorIntervalS: 60,
            };
            for (const moving of [true, false]) {
              const fixEvery = moving ? maxInterval : stationary;
              const now = new Date(t.clock.now().getTime() + 6 * H);
              const lastContact = new Date(now.getTime() - (heartbeat + upload + SLACK - 1) * 1000);
              const lastFix = new Date(now.getTime() - (fixEvery + upload + SLACK - 1) * 1000);
              const label = JSON.stringify({ heartbeat, upload, maxInterval, stationary, moving });
              expect(freshnessConditions(now, t.clock.now(), lastContact, lastFix, settings), label).toEqual({
                deviceOffline: false,
                locationStale: false,
              });
            }
          }
        }
      }
    }
    expect(valid).toBeGreaterThan(50);
  });
});

describe('geofence through sync (PROD §8.4)', () => {
  it('ADV-G02 a sustained departure opens exactly one GUARD_LEFT_SITE; ADV-G05 the return resolves it with the time outside', async () => {
    const { phone, shiftId } = await onShift();
    await pointAfter(phone, shiftId, 30_000, INSIDE);
    await pointAfter(phone, shiftId, MIN, OUTSIDE);
    await pointAfter(phone, shiftId, 150_000, OUTSIDE);
    expect(await alertsFor(shiftId)).toEqual([]); // two points over 2.5 min: not yet
    await pointAfter(phone, shiftId, 150_000, OUTSIDE);
    await pointAfter(phone, shiftId, MIN, OUTSIDE);
    await pointAfter(phone, shiftId, MIN, OUTSIDE);
    const open = await alertsFor(shiftId);
    expect(open.map((a) => [a.type, a.status, a.triggerCount])).toEqual([['GUARD_LEFT_SITE', 'OPEN', 1]]);

    await pointAfter(phone, shiftId, MIN, INSIDE);
    const [resolved] = await alertsFor(shiftId);
    expect(resolved?.status).toBe('RESOLVED');
    expect(resolved?.resolutionType).toBe('CONDITION_CLEARED');
    expect(resolved?.details.outsideSeconds).toBe(8 * 60); // first outside fix to the return
    const events = await asOwner(t.db, (c) =>
      c.query<{ type: string }>(
        `select type from shift_events where shift_id = $1 and type in ('LEFT_SITE', 'ENTERED_SITE') order by occurred_at`,
        [shiftId],
      ),
    );
    expect(events.rows.map((r) => r.type)).toEqual(['LEFT_SITE', 'ENTERED_SITE']);
  });

  it('an excursion that started and ended within one offline backlog is history, not a live alert', async () => {
    const { phone, shiftId } = await onShift();
    t.clock.advance(20 * MIN);
    mono += 20 * MIN;
    const backlog = [
      item('LOCATION', { shiftId, fix: INSIDE }, 18 * MIN),
      item('LOCATION', { shiftId, fix: OUTSIDE }, 16 * MIN),
      item('LOCATION', { shiftId, fix: OUTSIDE }, 13 * MIN),
      item('LOCATION', { shiftId, fix: OUTSIDE }, 10 * MIN),
      item('LOCATION', { shiftId, fix: INSIDE }, 8 * MIN),
    ];
    await refreshPhone(t.app, phone); // the access token lasts 15 minutes
    const res = await send(phone, backlog);
    expect(res.results.map((r) => r.status)).toEqual(Array(5).fill('ACCEPTED'));
    expect(await alertsFor(shiftId)).toEqual([]);
    const events = await asOwner(t.db, (c) =>
      c.query<{ type: string; payload: { detectedAfterSync: boolean } }>(
        `select type, payload from shift_events where shift_id = $1 and type in ('LEFT_SITE', 'ENTERED_SITE') order by occurred_at`,
        [shiftId],
      ),
    );
    expect(events.rows.map((r) => [r.type, r.payload.detectedAfterSync])).toEqual([
      ['LEFT_SITE', true],
      ['ENTERED_SITE', true],
    ]);
  });
});

describe('location evidence (PROD §8.5)', () => {
  it('ADV-L11 mock points are stored with their flag and open one SUSPICIOUS_LOCATION that counts repeats', async () => {
    const { phone, shiftId } = await onShift();
    await pointAfter(phone, shiftId, 30_000, { ...INSIDE, isMock: true });
    await pointAfter(phone, shiftId, 30_000, { ...INSIDE, isMock: true });
    const stored = await asOwner(t.db, (c) =>
      c.query<{ flags: string[] }>('select flags from location_points where shift_id = $1 and is_mock', [
        shiftId,
      ]),
    );
    expect(stored.rows).toHaveLength(2);
    for (const row of stored.rows) expect(row.flags).toContain('MOCK_LOCATION');
    const alerts = await alertsFor(shiftId);
    expect(alerts.map((a) => [a.type, a.status, a.triggerCount])).toEqual([
      ['SUSPICIOUS_LOCATION', 'OPEN', 2],
    ]);
  });
});

describe('detectors (PROD §12.1)', () => {
  it('DEVICE_OFFLINE opens after the threshold and resolves when contact resumes', async () => {
    const { phone, shiftId } = await onShift();
    t.clock.advance(5 * MIN);
    await detectors();
    expect(await alertsFor(shiftId)).toEqual([]);
    t.clock.advance(6 * MIN); // 11 min without contact > 10 min
    await detectors();
    await detectors(); // a second run changes nothing
    expect((await alertsFor(shiftId)).map((a) => [a.type, a.status, a.triggerCount])).toEqual([
      ['DEVICE_OFFLINE', 'OPEN', 1],
    ]);
    await send(phone, [item('HEARTBEAT', { shiftId })]);
    await detectors();
    const byType = Object.fromEntries(
      (await alertsFor(shiftId)).map((a) => [a.type, [a.status, a.resolutionType]]),
    );
    // In contact again, but the newest fix is still from the start 11 minutes ago: stale (PROD §12.1).
    expect(byType).toEqual({
      DEVICE_OFFLINE: ['RESOLVED', 'CONDITION_CLEARED'],
      LOCATION_STALE: ['OPEN', null],
    });
    await pointAfter(phone, shiftId, 1_000, INSIDE);
    await detectors();
    expect((await alertsFor(shiftId)).find((a) => a.type === 'LOCATION_STALE')?.status).toBe('RESOLVED');
  });

  it('TRACKING_DISABLED follows the device report', async () => {
    const { phone, shiftId } = await onShift();
    const status = (locationPermission: string) =>
      item('DEVICE_STATUS', {
        shiftId,
        status: {
          locationPermission,
          preciseLocation: true,
          locationServicesEnabled: true,
          trackingServiceState: 'RUNNING',
        },
      });
    await send(phone, [status('WHEN_IN_USE')]);
    expect((await alertsFor(shiftId)).map((a) => [a.type, a.status])).toEqual([
      ['TRACKING_DISABLED', 'OPEN'],
    ]);
    await send(phone, [status('ALWAYS')]);
    expect((await alertsFor(shiftId)).map((a) => [a.type, a.status])).toEqual([
      ['TRACKING_DISABLED', 'RESOLVED'],
    ]);
  });

  it('SHIFT_NOT_STARTED opens when late; SHIFT_MISSED supersedes it', async () => {
    const guardId = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'AL-LATE',
      displayName: 'Late',
      phone: '+923003399999',
    });
    const startsAt = new Date(t.clock.now().getTime() + MIN);
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
    t.clock.advance(12 * MIN);
    await detectors();
    expect((await alertsFor(shiftId)).map((a) => [a.type, a.status])).toEqual([
      ['SHIFT_NOT_STARTED', 'OPEN'],
    ]);
    t.clock.advance(2 * H);
    await applyForOrganization(t.deps, org.id, [
      { id: shiftId, organization_id: org.id, kind: 'MARK_MISSED' },
    ]);
    const byType = Object.fromEntries(
      (await alertsFor(shiftId)).map((a) => [a.type, [a.status, a.resolutionType]]),
    );
    expect(byType).toEqual({ SHIFT_NOT_STARTED: ['RESOLVED', 'SUPERSEDED'], SHIFT_MISSED: ['OPEN', null] });
  });

  it('ADV-AL04 when a shift ends, condition alerts resolve as "shift ended"; SOS and missed-shift alerts stay', async () => {
    const { phone, shiftId, guardId } = await onShift();
    t.clock.advance(11 * MIN);
    await detectors();
    const sos = await seedAlert('SOS_ACTIVATED', shiftId, guardId);
    const missed = await seedAlert('SHIFT_MISSED', shiftId, guardId);
    const ended = await send(phone, [item('SHIFT_END', { shiftId, fix: { ...INSIDE, fixAgeS: 1 } })]);
    expect(ended.results[0]?.status).toBe('ACCEPTED');
    const byId = new Map((await alertsFor(shiftId)).map((a) => [a.id, a]));
    const offline = [...byId.values()].find((a) => a.type === 'DEVICE_OFFLINE');
    expect([offline?.status, offline?.resolutionType]).toEqual(['RESOLVED', 'SHIFT_ENDED']);
    expect(byId.get(sos)?.status).toBe('OPEN');
    expect(byId.get(missed)?.status).toBe('OPEN');
  });
});

describe('manual changes (PROD §12.2, §12.5)', () => {
  it('ADV-AL02 a dispatcher cannot resolve or dismiss, and nobody can dismiss an SOS', async () => {
    const sos = await seedAlert('SOS_ACTIVATED', null, null);
    const post = (cookie: string, action: string, body?: Record<string, unknown>) =>
      call(t.app, {
        method: 'POST',
        url: `/api/v1/alerts/${sos}/${action}`,
        cookie,
        org: org.id,
        body: body ?? {},
      });
    expect(errorCode(await post(dispatcher, 'resolve'))).toBe('FORBIDDEN');
    expect(errorCode(await post(dispatcher, 'dismiss', { reason: 'test' }))).toBe('FORBIDDEN');
    for (const cookie of [supervisor, admin]) {
      const res = await post(cookie, 'dismiss', { reason: 'false alarm' });
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('ALERT_INVALID_TRANSITION');
    }
    expect((await post(dispatcher, 'acknowledge')).statusCode).toBe(200);
    const resolved = await post(supervisor, 'resolve', { note: 'Guard safe, called back' });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json<{ alert: { status: string } }>().alert.status).toBe('RESOLVED');
    // A dismissible alert still needs a reason.
    const other = await seedAlert('DEVICE_CHANGED', null, null);
    const noReason = await call(t.app, {
      method: 'POST',
      url: `/api/v1/alerts/${other}/dismiss`,
      cookie: supervisor,
      org: org.id,
      body: {},
    });
    expect(errorCode(noReason)).toBe('VALIDATION_FAILED');
  });

  it('ADV-AL03 two people acknowledging at once both succeed, and the first is recorded', async () => {
    const id = await seedAlert('DEVICE_CHANGED', null, null);
    const ack = (cookie: string) =>
      call(t.app, { method: 'POST', url: `/api/v1/alerts/${id}/acknowledge`, cookie, org: org.id, body: {} });
    const [a, b] = await Promise.all([ack(dispatcher), ack(supervisor)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const first = a.json<{ alert: AlertDto }>().alert.acknowledgedBy?.id;
    expect(first).toBeDefined();
    expect(b.json<{ alert: AlertDto }>().alert.acknowledgedBy?.id).toBe(first);
    const audits = await asOwner(t.db, (c) =>
      c.query(`select 1 from audit_logs where action = 'ALERT_ACKNOWLEDGED' and resource_id = $1`, [id]),
    );
    expect(audits.rowCount).toBe(1);
  });

  it("the list never holds another organization's alerts", async () => {
    const other = await seedOrganization(t.db, 'Other Alerts', [
      { email: 'admin@other-alerts.test', role: 'ADMIN' },
    ]);
    const foreign = randomUUID();
    await asOwner(t.db, (c) =>
      c.query(
        `insert into alerts (id, organization_id, type, severity, dedupe_key, summary, opened_at, last_triggered_at)
         values ($1, $2, 'DEVICE_CHANGED', 'LOW', 'x', 'Other', now(), now())`,
        [foreign, other.id],
      ),
    );
    const res = await call(t.app, {
      method: 'GET',
      url: '/api/v1/alerts?status=all',
      cookie: admin,
      org: org.id,
    });
    const ids = res.json<{ alerts: { id: string }[] }>().alerts.map((a) => a.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(foreign);
  });

  it('alert keys are per shift', () => {
    expect(alertKey.leftSite('s1')).not.toBe(alertKey.leftSite('s2'));
  });
});
