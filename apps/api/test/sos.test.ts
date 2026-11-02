// SOS end to end on the server (PROD §11, ARCH §13, INV-10, INV-15): acceptance that nothing can
// block, honest states for the phone, the escalation ladder on a fake clock, drills, the device-key
// fallback, and the synthetic canary. Phones are driven the way the guard app drives them.
import { randomUUID, type KeyObject } from 'node:crypto';

import { createKysely, createPool, type Pool } from '@sentryops/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionCanary } from '../src/provisioning.ts';
import { runCanary } from '../src/workers/canary.ts';
import { runEscalation, runSender } from '../src/workers/notifications.ts';
import { runDispatcher } from '../src/workers/outbox.ts';
import { browserSubscription, fakeProviders } from './fake-providers.ts';
import {
  asOwner,
  asPhone,
  call,
  createGuard,
  enrollPhoneWithKey,
  errorCode,
  seedOrganization,
  signIn,
  signRequest,
  startTestApp,
  type EnrolledPhone,
  type TestApp,
} from './support.ts';

const H = 3_600_000;
const BOOT = 'sos-boot';
const AT_SITE = { lat: 31.4702, lon: 74.4001, accuracyM: 8 };
const PHONES = {
  supervisor: '+923331110001',
  admin: '+923331110002',
  owner: '+923331110003',
  contact: '+923331110009',
};

let t: TestApp;
let sweepPool: Pool;
const providers = fakeProviders();
let org: Awaited<ReturnType<typeof seedOrganization>>;
let owner: string;
let admin: string;
let supervisor: string;
let dispatcher: string;
let siteId: string;
let seq = 0;
let mono = 5_000_000;
const endpoints: Record<string, string> = {};

type Phone = EnrolledPhone & { key: KeyObject };

const workerDeps = () => ({ ...t.deps, sweep: createKysely(sweepPool) });
const dispatch = () => runDispatcher(workerDeps());
const sendAll = () => runSender(workerDeps());
const escalate = () => runEscalation(workerDeps());

function sosBody(fix: Record<string, unknown> | null = null, clientEventId: string = randomUUID()) {
  mono += 100;
  return {
    clientEventId,
    recordedAt: t.clock.now().toISOString(),
    monoMs: mono,
    bootId: BOOT,
    fix,
    sentMonoMs: mono + 50,
  };
}

async function press(phone: Phone, body: ReturnType<typeof sosBody> = sosBody()) {
  const res = await asPhone(t.app, phone, { method: 'POST', url: '/api/v1/sos', body });
  return res;
}

async function pressOk(phone: Phone, body?: ReturnType<typeof sosBody>): Promise<string> {
  const res = await press(phone, body);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json<{ status: string }>().status).toBe('RECEIVED');
  return res.json<{ sosEventId: string }>().sosEventId;
}

async function status(phone: Phone, sosEventId: string) {
  const res = await asPhone(t.app, phone, { method: 'GET', url: `/api/v1/sos/${sosEventId}/status` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{
    phase: string;
    alertSentTo: number;
    shownInControlRoom: boolean;
    reachedPhones: number;
    acknowledgedBy: string | null;
    cancelRequestedAt: string | null;
    isDrill: boolean;
  }>();
}

async function alertOf(sosEventId: string) {
  const { rows } = await asOwner(t.db, (c) =>
    c.query<{
      id: string;
      status: string;
      escalation_level: number;
      trigger_count: number;
      is_drill: boolean;
    }>('select id, status, escalation_level, trigger_count, is_drill from alerts where sos_event_id = $1', [
      sosEventId,
    ]),
  );
  const alert = rows[0];
  if (!alert) throw new Error('no alert for the SOS');
  return alert;
}

async function deliveries(alertId: string) {
  const { rows } = await asOwner(t.db, (c) =>
    c.query<{
      channel: string;
      escalation_level: number;
      recipient_phone: string | null;
      title: string;
      status: string;
      email: string | null;
    }>(
      `select d.channel, d.escalation_level, d.recipient_phone, d.title, d.status, u.email
         from notification_deliveries d
         left join organization_members m on m.id = d.recipient_member_id
         left join users u on u.id = m.user_id
        where d.alert_id = $1 order by d.created_at, d.id`,
      [alertId],
    ),
  );
  return rows;
}

async function guardWithPhone(
  onShift: boolean,
  organizationId = org.id,
  cookie = admin,
): Promise<{ phone: Phone; shiftId: string | null }> {
  const number = `+9230033${String(10_000 + seq++).padStart(5, '0')}`;
  const guardId = await createGuard(t.app, cookie, organizationId, {
    employeeNumber: `S-${number.slice(-5)}`,
    displayName: 'Ahmed Khan',
    phone: number,
  });
  const phone = await enrollPhoneWithKey(t.app, cookie, organizationId, guardId, number);
  if (!onShift) return { phone, shiftId: null };
  const startsAt = new Date(t.clock.now().getTime() + 5 * 60_000);
  const created = await call(t.app, {
    method: 'POST',
    url: '/api/v1/shifts',
    cookie,
    org: organizationId,
    body: {
      guardId,
      siteId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 8 * H).toISOString(),
    },
  });
  const shiftId = created.json<{ id: string }>().id;
  mono += 100;
  const started = await asPhone(t.app, phone, {
    method: 'POST',
    url: '/api/v1/sync/batch',
    body: {
      batchId: randomUUID(),
      sentAt: t.clock.now().toISOString(),
      sentMonoMs: mono + 10,
      bootId: BOOT,
      items: [
        {
          clientEventId: randomUUID(),
          type: 'SHIFT_START',
          recordedAt: t.clock.now().toISOString(),
          monoMs: mono,
          bootId: BOOT,
          shiftId,
          fix: { ...AT_SITE, fixAgeS: 2 },
          permission: { location: 'ALWAYS', precise: true },
        },
      ],
    },
  });
  expect(started.json<{ results: { status: string }[] }>().results[0]?.status).toBe('ACCEPTED');
  return { phone, shiftId };
}

const memberId = (email: string) => org.members[email]?.memberId ?? '';

beforeAll(async () => {
  t = await startTestApp({
    notify: providers,
    config: { SMS_ALLOWED_NUMBERS: Object.values(PHONES) },
  });
  sweepPool = createPool(t.db.urls.system_worker, { max: 2 });
  org = await seedOrganization(t.db, 'SOS Co', [
    { email: 'owner@sos.test', role: 'OWNER' },
    { email: 'admin@sos.test', role: 'ADMIN' },
    { email: 'sup@sos.test', role: 'SUPERVISOR' },
    { email: 'disp@sos.test', role: 'DISPATCHER' },
  ]);
  owner = await signIn(t.app, 'owner@sos.test');
  admin = await signIn(t.app, 'admin@sos.test');
  supervisor = await signIn(t.app, 'sup@sos.test');
  dispatcher = await signIn(t.app, 'disp@sos.test');
  const site = await call(t.app, {
    method: 'POST',
    url: '/api/v1/sites',
    cookie: admin,
    org: org.id,
    body: {
      name: 'ABC Warehouse',
      boundary: { kind: 'CIRCLE', center: { lat: 31.47, lng: 74.4 }, radiusM: 300 },
    },
  });
  siteId = site.json<{ id: string }>().id;
  // SOS text numbers, entered by the owner (owner decision 2026-11-02), and one browser each.
  for (const [email, phone] of [
    ['sup@sos.test', PHONES.supervisor],
    ['admin@sos.test', PHONES.admin],
    ['owner@sos.test', PHONES.owner],
  ] as const) {
    const res = await call(t.app, {
      method: 'PUT',
      url: `/api/v1/members/${memberId(email)}/alert-phone`,
      cookie: owner,
      org: org.id,
      body: { phone },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  for (const [email, cookie] of [
    ['owner@sos.test', owner],
    ['admin@sos.test', admin],
    ['sup@sos.test', supervisor],
    ['disp@sos.test', dispatcher],
  ] as const) {
    const sub = browserSubscription();
    const res = await call(t.app, {
      method: 'POST',
      url: '/api/v1/push-subscriptions',
      cookie,
      org: org.id,
      body: sub,
    });
    expect(res.statusCode, res.body).toBe(201);
    endpoints[email] = sub.endpoint;
  }
  await asOwner(t.db, (c) =>
    c.query(`update organization_settings set overrides = $1 where organization_id = $2`, [
      JSON.stringify({ 'sos.emergency_contacts': [PHONES.contact] }),
      org.id,
    ]),
  );
});

afterAll(async () => {
  await sweepPool?.end();
  await t?.close();
});

describe('honest states (PROD §11.3, INV-10)', () => {
  it('ADV-S01 RECEIVED, ALERT_SENT, NOTIFIED and ACKNOWLEDGED each appear only after their server fact', async () => {
    const { phone } = await guardWithPhone(true);
    const id = await pressOk(phone, sosBody({ ...AT_SITE, fixAgeS: 3 }));
    expect((await status(phone, id)).phase).toBe('RECEIVED');

    // A provider accepting the messages is ALERT_SENT, never more (SEC §20 #33).
    await sendAll();
    const sent = await status(phone, id);
    expect(sent).toMatchObject({ phase: 'ALERT_SENT', shownInControlRoom: false, reachedPhones: 0 });
    expect(sent.alertSentTo).toBe(3);

    // A dashboard showing the alarm is NOTIFIED.
    const alert = await alertOf(id);
    const seen = await call(t.app, {
      method: 'POST',
      url: `/api/v1/alerts/${alert.id}/seen`,
      cookie: dispatcher,
      org: org.id,
      body: { client: 'DESKTOP' },
    });
    expect(seen.json<{ recorded: boolean }>().recorded).toBe(true);
    expect(await status(phone, id)).toMatchObject({ phase: 'NOTIFIED', shownInControlRoom: true });

    // Only a person acknowledges, and the guard learns who.
    const ack = await call(t.app, {
      method: 'POST',
      url: `/api/v1/sos/${id}/acknowledge`,
      cookie: dispatcher,
      org: org.id,
      body: {},
    });
    expect(ack.statusCode, ack.body).toBe(200);
    expect(await status(phone, id)).toMatchObject({ phase: 'ACKNOWLEDGED', acknowledgedBy: 'disp' });
    const resolved = await call(t.app, {
      method: 'POST',
      url: `/api/v1/sos/${id}/resolve`,
      cookie: supervisor,
      org: org.id,
      body: { resolution: 'GENUINE', note: 'Intruder left; police informed' },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await status(phone, id)).phase).toBe('RESOLVED');
  });

  it("ADV-S01 a push reaching a person's phone makes it NOTIFIED; another person's delivery doesn't count", async () => {
    const { phone } = await guardWithPhone(true);
    const id = await pressOk(phone);
    await sendAll();
    const alert = await alertOf(id);
    const payload = providers.webPush
      .payloadsFor(endpoints['sup@sos.test'] ?? '')
      .find((p) => p.alertId === alert.id);
    expect(payload?.title).toMatch(/^SOS — Ahmed K\. — ABC Warehouse$/);
    // The dispatcher can't report the supervisor's delivery.
    const wrong = await call(t.app, {
      method: 'POST',
      url: `/api/v1/alerts/${alert.id}/delivered`,
      cookie: dispatcher,
      org: org.id,
      body: { deliveryId: payload?.deliveryId },
    });
    expect(wrong.statusCode).toBe(404);
    expect((await status(phone, id)).phase).toBe('ALERT_SENT');
    const right = await call(t.app, {
      method: 'POST',
      url: `/api/v1/alerts/${alert.id}/delivered`,
      cookie: supervisor,
      org: org.id,
      body: { deliveryId: payload?.deliveryId },
    });
    expect(right.statusCode, right.body).toBe(200);
    expect(await status(phone, id)).toMatchObject({
      phase: 'NOTIFIED',
      reachedPhones: 1,
      shownInControlRoom: false,
    });
  });

  it('ADV-S02 an SOS sent again after a lost response is stored once and answered the same way', async () => {
    const { phone } = await guardWithPhone(true);
    const body = sosBody();
    const first = await pressOk(phone, body);
    const again = await pressOk(phone, body);
    expect(again).toBe(first);
    const { rows } = await asOwner(t.db, (c) =>
      c.query('select trigger_count from sos_events where id = $1', [first]),
    );
    expect(rows).toEqual([{ trigger_count: 1 }]);
  });
});

describe('presses (PROD §11.9)', () => {
  it('ADV-S03 pressing again while one is open re-triggers it: one open SOS, the counter goes up', async () => {
    const { phone } = await guardWithPhone(true);
    const first = await pressOk(phone);
    const second = await pressOk(phone, sosBody({ ...AT_SITE, lat: 31.4705, fixAgeS: 1 }));
    expect(second).toBe(first);
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ n: string }>(
        `select count(*) as n from sos_events where guard_id = (select guard_id from sos_events where id = $1)`,
        [first],
      ),
    );
    expect(rows[0]?.n).toBe('1');
    expect(await alertOf(first)).toMatchObject({ trigger_count: 2, status: 'OPEN' });
  });

  it('pressed again after an acknowledgement, the SOS is unacknowledged and the ladder restarts (owner decision)', async () => {
    const { phone } = await guardWithPhone(true);
    const id = await pressOk(phone);
    const alert = await alertOf(id);
    const before = (await deliveries(alert.id)).length;
    await call(t.app, {
      method: 'POST',
      url: `/api/v1/sos/${id}/acknowledge`,
      cookie: supervisor,
      org: org.id,
      body: {},
    });
    expect((await status(phone, id)).phase).toBe('ACKNOWLEDGED');
    t.clock.advance(30_000);
    await pressOk(phone);
    expect(await alertOf(id)).toMatchObject({ status: 'OPEN', escalation_level: 0 });
    expect((await status(phone, id)).phase).not.toBe('ACKNOWLEDGED');
    // The first step went out again, as a new episode.
    const after = await deliveries(alert.id);
    expect(after.length).toBeGreaterThan(before);
    expect(after.slice(before).every((d) => d.escalation_level === 0)).toBe(true);
    t.clock.advance(60_000);
    expect((await escalate()).escalated).toBeGreaterThanOrEqual(1);
    expect((await alertOf(id)).escalation_level).toBe(1);
  });
});

describe('nothing blocks an SOS (INV-15)', () => {
  it('ADV-S04 accepted while the phone is rate-limited, below the minimum version, or its organization is suspended', async () => {
    const { phone } = await guardWithPhone(true);
    // Rate-limited: the phone's ordinary requests are refused...
    for (let i = 0; i < 600; i++) t.deps.rateLimiter.hit('default', 'user', `device:${phone.deviceId}`);
    const limited = await asPhone(t.app, phone, { method: 'GET', url: '/api/v1/mobile/config' });
    expect(limited.statusCode).toBe(429);
    // ...its SOS is not.
    const id = await pressOk(phone);

    const config = t.deps.config as { MOBILE_MIN_VERSION: string };
    const minimum = config.MOBILE_MIN_VERSION;
    config.MOBILE_MIN_VERSION = '9.0.0';
    try {
      const old = await t.app.inject({
        method: 'POST',
        url: '/api/v1/sos',
        headers: {
          authorization: `Bearer ${phone.accessToken}`,
          'x-device-id': phone.deviceId,
          'x-app-version': '0.0.1',
          'content-type': 'application/json',
        },
        payload: sosBody(),
      });
      expect(old.statusCode).toBe(200);
    } finally {
      config.MOBILE_MIN_VERSION = minimum;
    }

    const other = await guardWithPhone(false);
    await asOwner(t.db, (c) =>
      c.query(`update organizations set status = 'SUSPENDED' where id = $1`, [org.id]),
    );
    try {
      const suspended = await asPhone(t.app, other.phone, { method: 'GET', url: '/api/v1/me/shifts' });
      expect(errorCode(suspended)).toBe('ORG_SUSPENDED');
      const res = await press(other.phone);
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await asOwner(t.db, (c) =>
        c.query(`update organizations set status = 'ACTIVE' where id = $1`, [org.id]),
      );
    }
    expect((await alertOf(id)).status).toBe('OPEN');
  });

  it('ADV-S05 an SOS with no active shift is accepted, and only SOS tracking stores its position', async () => {
    const { phone } = await guardWithPhone(false);
    const id = await pressOk(phone);
    const { rows } = await asOwner(t.db, (c) =>
      c.query('select shift_id, site_id from sos_events where id = $1', [id]),
    );
    expect(rows).toEqual([{ shift_id: null, site_id: null }]);
    const point = () => {
      mono += 10;
      return {
        clientEventId: randomUUID(),
        recordedAt: t.clock.now().toISOString(),
        monoMs: mono,
        bootId: BOOT,
        fix: { ...AT_SITE, fixAgeS: 1 },
      };
    };
    const tracked = await asPhone(t.app, phone, {
      method: 'POST',
      url: `/api/v1/sos/${id}/locations`,
      body: { bootId: BOOT, sentMonoMs: mono + 5, points: [point(), point()] },
    });
    expect(tracked.json<{ results: { status: string }[] }>().results.map((r) => r.status)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
    ]);
    const stored = await asOwner(t.db, (c) =>
      c.query('select shift_id, source from location_points where sos_event_id = $1', [id]),
    );
    expect(stored.rows).toEqual([
      { shift_id: null, source: 'SOS' },
      { shift_id: null, source: 'SOS' },
    ]);
    // Once resolved, a point captured afterwards is refused and not stored (INV-08).
    await call(t.app, {
      method: 'POST',
      url: `/api/v1/sos/${id}/resolve`,
      cookie: supervisor,
      org: org.id,
      body: { resolution: 'FALSE_ALARM', note: 'Pressed by mistake' },
    });
    t.clock.advance(5 * 60_000);
    const late = await asPhone(t.app, phone, {
      method: 'POST',
      url: `/api/v1/sos/${id}/locations`,
      body: { bootId: BOOT, sentMonoMs: mono + 5, points: [point()] },
    });
    expect(late.json<{ results: { status: string; code?: string }[] }>().results[0]).toMatchObject({
      status: 'REJECTED',
      code: 'OUTSIDE_SHIFT_WINDOW',
    });
    expect(
      (await asOwner(t.db, (c) => c.query('select 1 from location_points where sos_event_id = $1', [id])))
        .rowCount,
    ).toBe(2);
  });
});

describe('escalation (PROD §11.4, ARCH §13.3)', () => {
  it('ADV-S06 unacknowledged, the ladder steps at 0, 60 and 180 s and repeats every 120 s', async () => {
    const { phone } = await guardWithPhone(true);
    const id = await pressOk(phone);
    const alert = await alertOf(id);
    const atLevel = async (level: number) =>
      (await deliveries(alert.id)).filter((d) => d.escalation_level === level);

    // 0 s: web push to supervisors, dispatchers and administrators; SMS to the duty officers.
    const step0 = await atLevel(0);
    expect(
      step0
        .filter((d) => d.channel === 'WEB_PUSH')
        .map((d) => d.email)
        .sort(),
    ).toEqual(['admin@sos.test', 'disp@sos.test', 'sup@sos.test']);
    expect(step0.filter((d) => d.channel === 'SMS').map((d) => d.recipient_phone)).toEqual([
      PHONES.supervisor,
    ]);

    // Other tests' SOS alerts may escalate too: this one's level is what counts.
    const level = async () => (await alertOf(id)).escalation_level;
    t.clock.advance(59_000);
    await escalate();
    expect(await level()).toBe(0);
    t.clock.advance(1_000);
    await escalate();
    expect(await level()).toBe(1);
    expect((await atLevel(1)).filter((d) => d.channel === 'SMS').map((d) => d.recipient_phone)).toEqual([
      PHONES.admin,
    ]);

    t.clock.advance(119_000);
    await escalate();
    expect(await level()).toBe(1);
    t.clock.advance(1_000);
    await escalate();
    expect(await level()).toBe(2);
    const step2 = await atLevel(2);
    expect(
      step2
        .filter((d) => d.channel === 'SMS')
        .map((d) => d.recipient_phone)
        .sort(),
    ).toEqual([PHONES.owner, PHONES.contact].sort());
    expect(step2.filter((d) => d.channel === 'WEB_PUSH').map((d) => d.email)).toEqual(['owner@sos.test']);

    // Every 120 s after: everyone reached so far, again.
    for (const step of [3, 4]) {
      t.clock.advance(119_000);
      await escalate();
      expect(await level()).toBe(step - 1);
      t.clock.advance(1_000);
      await escalate();
      expect(await level()).toBe(step);
      const repeat = await atLevel(step);
      expect(
        repeat
          .filter((d) => d.channel === 'SMS')
          .map((d) => d.recipient_phone)
          .sort(),
      ).toEqual([PHONES.admin, PHONES.contact, PHONES.owner, PHONES.supervisor].sort());
    }
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ level: number }>(
        `select (payload->>'level')::int as level from alert_events where alert_id = $1 and type = 'ESCALATED' order by created_at`,
        [alert.id],
      ),
    );
    expect(rows.map((r) => r.level)).toEqual([1, 2, 3, 4]);

    // Acknowledgement stops it.
    await call(t.app, {
      method: 'POST',
      url: `/api/v1/sos/${id}/acknowledge`,
      cookie: supervisor,
      org: org.id,
      body: {},
    });
    t.clock.advance(10 * 60_000);
    await escalate();
    expect((await alertOf(id)).escalation_level).toBe(4);
  });

  it('ADV-S07 the guard\'s "I\'m safe" leaves the SOS open and escalation running', async () => {
    const { phone } = await guardWithPhone(true);
    const id = await pressOk(phone);
    const cancel = await asPhone(t.app, phone, {
      method: 'POST',
      url: `/api/v1/sos/${id}/cancel-request`,
      body: { clientEventId: randomUUID(), recordedAt: t.clock.now().toISOString() },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json<{ phase: string; cancelRequestedAt: string | null }>()).toMatchObject({
      phase: 'RECEIVED',
      cancelRequestedAt: t.clock.now().toISOString(),
    });
    t.clock.advance(60_000);
    await escalate();
    expect(await alertOf(id)).toMatchObject({ status: 'OPEN', escalation_level: 1 });
  });
});

describe('a provider outage (ADV-S08)', () => {
  it('ADV-S08 push provider down: the dashboard alarm still goes out, a display receipt still notifies, and the operator alarm fires', async () => {
    providers.webPush.failWith = 'HTTP_503';
    providers.sms.failWith = 'PROVIDER_DOWN';
    try {
      const { phone } = await guardWithPhone(true);
      const id = await pressOk(phone);
      const alert = await alertOf(id);
      // The dashboards' alarm comes through the realtime stream, not a provider.
      await dispatch();
      const { rows } = await asOwner(t.db, (c) =>
        c.query<{ type: string }>(
          `select type from realtime_events where organization_id = $1 and (payload->>'sosEventId' = $2 or payload->>'alertId' = $3)`,
          [org.id, id, alert.id],
        ),
      );
      expect(rows.map((r) => r.type)).toEqual(expect.arrayContaining(['sos.activated', 'alert.opened']));
      const failedBefore = t.deps.metrics.get('notification_failed_web_push');
      const result = await sendAll();
      // The worker logs each failure as "notification provider failure": the operator's alarm.
      expect(result.failures.map((f) => f.channel)).toEqual(expect.arrayContaining(['WEB_PUSH', 'SMS']));
      expect(t.deps.metrics.get('notification_failed_web_push')).toBeGreaterThan(failedBefore);
      expect((await status(phone, id)).phase).toBe('RECEIVED');
      await call(t.app, {
        method: 'POST',
        url: `/api/v1/alerts/${alert.id}/seen`,
        cookie: supervisor,
        org: org.id,
        body: { client: 'PHONE' },
      });
      expect(await status(phone, id)).toMatchObject({ phase: 'NOTIFIED', shownInControlRoom: true });
    } finally {
      providers.webPush.failWith = null;
      providers.sms.failWith = null;
    }
  });
});

describe('drills (PROD §11.10)', () => {
  it("ADV-S10 a drill's SOS is marked DRILL and reaches only the members taking part; anyone else's SOS is real", async () => {
    const inDrill = await guardWithPhone(true);
    const outside = await guardWithPhone(true);
    const started = await call(t.app, {
      method: 'POST',
      url: '/api/v1/sos-drills',
      cookie: admin,
      org: org.id,
      body: { guardIds: [inDrill.phone.guardId], memberIds: [memberId('sup@sos.test')], durationMinutes: 30 },
    });
    expect(started.statusCode, started.body).toBe(201);
    const drillId = started.json<{ drill: { id: string; members: { name: string }[] } }>().drill.id;

    const drillPress = await press(inDrill.phone);
    expect(drillPress.json<{ isDrill: boolean }>().isDrill).toBe(true);
    const drillAlert = await alertOf(drillPress.json<{ sosEventId: string }>().sosEventId);
    expect(drillAlert.is_drill).toBe(true);
    // The alert names its drill, so a dashboard can tell whether it is taking part, even later.
    const seen = await call(t.app, {
      method: 'GET',
      url: `/api/v1/alerts/${drillAlert.id}`,
      cookie: supervisor,
      org: org.id,
    });
    expect(seen.json<{ alert: { isDrill: boolean; drillId: string | null } }>().alert).toMatchObject({
      isDrill: true,
      drillId,
    });
    // Escalate past the step that texts the owner and the emergency contacts.
    t.clock.advance(180_000);
    await escalate();
    await escalate();
    const reached = await deliveries(drillAlert.id);
    expect(new Set(reached.map((d) => d.email))).toEqual(new Set(['admin@sos.test', 'sup@sos.test']));
    expect(reached.every((d) => d.title.startsWith('[DRILL] '))).toBe(true);
    expect(reached.some((d) => d.recipient_phone === PHONES.contact)).toBe(false);

    const realPress = await press(outside.phone);
    expect(realPress.json<{ isDrill: boolean }>().isDrill).toBe(false);
    const real = await deliveries((await alertOf(realPress.json<{ sosEventId: string }>().sosEventId)).id);
    expect(real.map((d) => d.email)).toContain('disp@sos.test');

    const ended = await call(t.app, {
      method: 'POST',
      url: `/api/v1/sos-drills/${drillId}/end`,
      cookie: admin,
      org: org.id,
    });
    expect(ended.json<{ drill: { active: boolean } }>().drill.active).toBe(false);
    // After it ends the drill can still be read, with the members it reaches.
    const after = await call(t.app, {
      method: 'GET',
      url: `/api/v1/sos-drills/${drillId}`,
      cookie: dispatcher,
      org: org.id,
    });
    expect(after.statusCode, after.body).toBe(200);
    const drill = after.json<{ drill: { active: boolean; members: { name: string }[] } }>().drill;
    expect(drill.active).toBe(false);
    expect(drill.members).toHaveLength(2);
  });

  it("ADV-S10 another organization's guard or member is not found when starting a drill", async () => {
    const other = await seedOrganization(t.db, 'Other drill Co', [
      { email: 'x@other-drill.test', role: 'ADMIN' },
    ]);
    const foreignMember = other.members['x@other-drill.test']?.memberId ?? '';
    const { phone } = await guardWithPhone(false);
    const res = await call(t.app, {
      method: 'POST',
      url: '/api/v1/sos-drills',
      cookie: admin,
      org: org.id,
      body: { guardIds: [phone.guardId], memberIds: [foreignMember], durationMinutes: 10 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('ADV-S10 every SOS in a demo organization is a drill that reaches only its own members', async () => {
    const demo = await seedOrganization(t.db, 'Demo Co', [
      { email: 'reviewer-admin@demo.test', role: 'ADMIN' },
    ]);
    await asOwner(t.db, (c) => c.query(`update organizations set kind = 'DEMO' where id = $1`, [demo.id]));
    const demoAdmin = await signIn(t.app, 'reviewer-admin@demo.test');
    const sub = browserSubscription();
    await call(t.app, {
      method: 'POST',
      url: '/api/v1/push-subscriptions',
      cookie: demoAdmin,
      org: demo.id,
      body: sub,
    });
    const number = `+9230033${String(90_000 + seq++).padStart(5, '0')}`;
    const guardId = await createGuard(t.app, demoAdmin, demo.id, {
      employeeNumber: 'D-1',
      displayName: 'Demo guard',
      phone: number,
    });
    const phone = await enrollPhoneWithKey(t.app, demoAdmin, demo.id, guardId, number);
    const res = await press(phone);
    expect(res.json<{ isDrill: boolean }>().isDrill).toBe(true);
    const id = res.json<{ sosEventId: string }>().sosEventId;
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ title: string; organization_id: string }>(
        `select title, organization_id from notification_deliveries where sos_event_id = $1`,
        [id],
      ),
    );
    expect(rows.length).toBe(1);
    expect(rows.every((r) => r.organization_id === demo.id && r.title.startsWith('[DRILL] '))).toBe(true);
  });
});

describe('the device key (D-30, INV-15)', () => {
  const signed = (phone: Phone, body: string, timestampMs = t.clock.now().getTime(), bearer = false) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/sos',
      headers: {
        'content-type': 'application/json',
        'x-device-id': phone.deviceId,
        'x-device-signature': signRequest(phone.key, 'POST', '/api/v1/sos', body, timestampMs),
        ...(bearer ? { authorization: `Bearer ${phone.accessToken}` } : {}),
      },
      payload: body,
    });

  it('ADV-S11 after the session expired, an SOS signed with the device key is accepted; a bad or old signature is not', async () => {
    const { phone } = await guardWithPhone(true);
    t.clock.advance(16 * 60_000); // the 15-minute access token has expired
    const unsigned = await press(phone);
    expect(unsigned.statusCode).toBe(401);
    const body = JSON.stringify(sosBody());
    const res = await signed(phone, body, t.clock.now().getTime(), true);
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json<{ sosEventId: string }>().sosEventId;
    const { rows } = await asOwner(t.db, (c) =>
      c.query('select auth from sos_presses where sos_event_id = $1', [id]),
    );
    expect(rows).toEqual([{ auth: 'DEVICE_SIGNATURE' }]);
    // Altered body, wrong key, stale timestamp: refused.
    const other = await guardWithPhone(false);
    const forged = await t.app.inject({
      method: 'POST',
      url: '/api/v1/sos',
      headers: {
        'content-type': 'application/json',
        'x-device-id': phone.deviceId,
        'x-device-signature': signRequest(
          other.phone.key,
          'POST',
          '/api/v1/sos',
          body,
          t.clock.now().getTime(),
        ),
      },
      payload: body,
    });
    expect(forged.statusCode).toBe(401);
    const altered = await t.app.inject({
      method: 'POST',
      url: '/api/v1/sos',
      headers: {
        'content-type': 'application/json',
        'x-device-id': phone.deviceId,
        'x-device-signature': signRequest(phone.key, 'POST', '/api/v1/sos', body, t.clock.now().getTime()),
      },
      payload: body.replace(BOOT, 'other-boot'),
    });
    expect(altered.statusCode).toBe(401);
    expect(
      (await signed(phone, JSON.stringify(sosBody()), t.clock.now().getTime() - 6 * 60_000)).statusCode,
    ).toBe(401);
    // The phone reads its SOS state the same way.
    const read = await t.app.inject({
      method: 'GET',
      url: `/api/v1/sos/${id}/status`,
      headers: {
        'x-device-id': phone.deviceId,
        'x-device-signature': signRequest(
          phone.key,
          'GET',
          `/api/v1/sos/${id}/status`,
          '',
          t.clock.now().getTime(),
        ),
      },
    });
    expect(read.statusCode, read.body).toBe(200);
  });

  it('ADV-S11 a phone REPLACED by a new one may still send a signed SOS for 72 hours, then not', async () => {
    const { phone } = await guardWithPhone(false);
    const number =
      (
        await asOwner(t.db, (c) =>
          c.query<{ phone: string }>('select phone from guards where id = $1', [phone.guardId]),
        )
      ).rows[0]?.phone ?? '';
    await enrollPhoneWithKey(t.app, admin, org.id, phone.guardId, number);
    const within = await signed(phone, JSON.stringify(sosBody()));
    expect(within.statusCode, within.body).toBe(200);
    t.clock.advance(73 * H);
    const after = await signed(phone, JSON.stringify(sosBody()));
    expect(after.statusCode).toBe(403);
    expect(errorCode(after)).toBe('DEVICE_REVOKED');
    // Dashboard sessions have expired over three days too.
    owner = await signIn(t.app, 'owner@sos.test');
    admin = await signIn(t.app, 'admin@sos.test');
    supervisor = await signIn(t.app, 'sup@sos.test');
    dispatcher = await signIn(t.app, 'disp@sos.test');
  });
});

describe('ownership (INV-02)', () => {
  it("ADV-A03 another guard's SOS is not found", async () => {
    const a = await guardWithPhone(false);
    const b = await guardWithPhone(false);
    const id = await pressOk(a.phone);
    const read = await asPhone(t.app, b.phone, { method: 'GET', url: `/api/v1/sos/${id}/status` });
    expect(read.statusCode).toBe(404);
    const cancel = await asPhone(t.app, b.phone, {
      method: 'POST',
      url: `/api/v1/sos/${id}/cancel-request`,
      body: { clientEventId: randomUUID(), recordedAt: t.clock.now().toISOString() },
    });
    expect(cancel.statusCode).toBe(404);
    const locations = await asPhone(t.app, b.phone, {
      method: 'POST',
      url: `/api/v1/sos/${id}/locations`,
      body: {
        bootId: BOOT,
        sentMonoMs: 10,
        points: [
          {
            clientEventId: randomUUID(),
            recordedAt: t.clock.now().toISOString(),
            monoMs: 5,
            bootId: BOOT,
            fix: AT_SITE,
          },
        ],
      },
    });
    expect(locations.statusCode).toBe(404);
  });

  it("the SOS page is audited before it shows the guard's position (INV-14)", async () => {
    const { phone } = await guardWithPhone(true);
    const id = await pressOk(phone, sosBody({ ...AT_SITE, fixAgeS: 1 }));
    const view = await call(t.app, {
      method: 'GET',
      url: `/api/v1/sos/${id}`,
      cookie: dispatcher,
      org: org.id,
    });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json<{ sos: { location: { lat: number } | null } }>().sos.location?.lat).toBeCloseTo(
      AT_SITE.lat,
      4,
    );
    const { rows } = await asOwner(t.db, (c) =>
      c.query(`select 1 from audit_logs where action = 'SOS_VIEWED' and resource_id = $1`, [id]),
    );
    expect(rows).toHaveLength(1);
  });
});

describe('the synthetic canary (ARCH §18.4)', () => {
  it('sends a signed SOS through the public API, follows it to a provider-accepted push, and resolves it', async () => {
    const canary = await provisionCanary(t.deps, { ownerEmail: 'canary@ops.test' });
    const canaryOwner = await signIn(t.app, 'canary@ops.test');
    const sub = browserSubscription('DESKTOP');
    await call(t.app, {
      method: 'POST',
      url: '/api/v1/push-subscriptions',
      cookie: canaryOwner,
      org: canary.organizationId,
      body: sub,
    });
    const address = await t.app.listen({ host: '127.0.0.1', port: 0 });
    const result = await runCanary(
      workerDeps(),
      { baseUrl: address, deviceId: canary.deviceId, privateKey: canary.privateKey },
      {
        between: async () => {
          await dispatch();
          await sendAll();
        },
        pollMs: 10,
        timeoutMs: 5_000,
      },
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.pushMs).not.toBeNull();
    const { rows } = await asOwner(t.db, (c) =>
      c.query('select status, is_drill, resolution from sos_events where organization_id = $1', [
        canary.organizationId,
      ]),
    );
    expect(rows).toEqual([{ status: 'RESOLVED', is_drill: true, resolution: 'DRILL' }]);
  });

  it('a public address it cannot reach is a failed SEND naming the network error, for the operator alarm', async () => {
    const canary = await provisionCanary(t.deps, { ownerEmail: 'canary-down@ops.test' });
    const unreachable = () =>
      Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    const result = await runCanary(
      workerDeps(),
      { baseUrl: 'https://canary.invalid', deviceId: canary.deviceId, privateKey: canary.privateKey },
      { fetcher: unreachable },
    );
    expect(result).toEqual({ ok: false, step: 'SEND', detail: 'TypeError: ECONNREFUSED' });
  });
});
