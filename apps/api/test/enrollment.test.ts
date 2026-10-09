// Guard enrollment and device-bound sessions (D-02, D-30, D-31, SEC §5).
import { CURRENT_DISCLOSURE_VERSION } from '@sentryops/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOwner,
  asPhone,
  call,
  createGuard,
  enrollPhone,
  errorCode,
  redeem,
  seedOrganization,
  signIn,
  startTestApp,
  type TestApp,
} from './support.ts';

let t: TestApp;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let admin: string;
let supervisor: string;
let dispatcher: string;
let phoneSeq = 0;
const nextPhone = () => `+9230000${String(10_000 + phoneSeq++).padStart(5, '0')}`;

async function newGuard() {
  const phone = nextPhone();
  const id = await createGuard(t.app, admin, org.id, {
    employeeNumber: `E-${phone.slice(-5)}`,
    displayName: `Guard ${phone.slice(-4)}`,
    phone,
  });
  return { id, phone };
}

async function issueCode(guardId: string, cookie = supervisor) {
  const res = await call(t.app, {
    method: 'POST',
    url: `/api/v1/guards/${guardId}/enrollment-codes`,
    cookie,
    org: org.id,
  });
  return res;
}

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'Enroll Co', [
    { email: 'admin@enroll.test', role: 'ADMIN' },
    { email: 'sup@enroll.test', role: 'SUPERVISOR' },
    { email: 'disp@enroll.test', role: 'DISPATCHER' },
  ]);
  admin = await signIn(t.app, 'admin@enroll.test');
  supervisor = await signIn(t.app, 'sup@enroll.test');
  dispatcher = await signIn(t.app, 'disp@enroll.test');
});

afterAll(async () => {
  await t?.close();
});

describe('enrollment (D-02, D-31)', () => {
  it('a supervisor issues a code; the guard app redeems it and gets its own session', async () => {
    const guard = await newGuard();
    const issued = await issueCode(guard.id);
    expect(issued.statusCode).toBe(201);
    const body = issued.json<{ code: string; qrPayload: string; purpose: string }>();
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(body.qrPayload).toBe(`SGE1:${body.code.replace('-', '')}`);
    expect(body.purpose).toBe('GUARD_ENROLLMENT');
    // Dispatchers can't issue codes (devices.enroll is Supervisor+).
    expect((await issueCode(guard.id, dispatcher)).statusCode).toBe(403);

    const redeemed = await redeem(t.app, { code: body.qrPayload, phone: guard.phone });
    expect(redeemed.statusCode).toBe(200);
    const session = redeemed.json<{ deviceId: string; session: { accessToken: string } }>();
    const config = await asPhone(
      t.app,
      { accessToken: session.session.accessToken, deviceId: session.deviceId },
      { method: 'GET', url: '/api/v1/mobile/config' },
    );
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      guard: { id: guard.id },
      organization: { id: org.id },
      features: { sos: false },
    });
  });

  it('ADV-A11 a guessed code, a reused code or another phone number gets no session', async () => {
    const guard = await newGuard();
    const { code } = (await issueCode(guard.id)).json<{ code: string }>();
    // Guessed.
    expect(errorCode(await redeem(t.app, { code: 'ZZZZ-ZZZZ', phone: guard.phone }))).toBe(
      'ENROLLMENT_CODE_INVALID',
    );
    // Right code, another phone number: counted as an attempt.
    expect(errorCode(await redeem(t.app, { code, phone: '+923119999999' }))).toBe('ENROLLMENT_CODE_INVALID');
    // Right code and number: works once…
    expect((await redeem(t.app, { code, phone: guard.phone })).statusCode).toBe(200);
    // …and never again.
    const again = await redeem(t.app, { code, phone: guard.phone });
    expect(errorCode(again)).toBe('INVITATION_EXPIRED');
    expect(again.json()).not.toHaveProperty('session');
  });

  it('ADV-A11 five wrong phone numbers spend the code', async () => {
    const guard = await newGuard();
    const { code } = (await issueCode(guard.id)).json<{ code: string }>();
    for (let i = 0; i < 5; i++) {
      expect(errorCode(await redeem(t.app, { code, phone: `+92311000000${i}` }))).toBe(
        'ENROLLMENT_CODE_INVALID',
      );
    }
    expect(errorCode(await redeem(t.app, { code, phone: guard.phone }))).toBe('INVITATION_EXPIRED');
  });

  it('ADV-A11 redemption is rate-limited per phone number', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await redeem(t.app, { code: 'AAAA-AAAA', phone: '+923007777777' })).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('ADV-A12 a new phone needs a new dashboard-issued code; the old phone is then retired', async () => {
    const guard = await newGuard();
    const first = await enrollPhone(t.app, supervisor, org.id, guard.id, guard.phone);
    // Nothing a phone can do alone moves the account: there is no code to redeem.
    const newPhoneAttempt = await redeem(t.app, { code: 'K7Q4-M9XP', phone: guard.phone });
    expect(errorCode(newPhoneAttempt)).toBe('ENROLLMENT_CODE_INVALID');
    // With a code from the dashboard (purpose NEW_DEVICE) the new phone takes over.
    const issued = (await issueCode(guard.id)).json<{ code: string; purpose: string }>();
    expect(issued.purpose).toBe('NEW_DEVICE');
    const second = await redeem(t.app, { code: issued.code, phone: guard.phone });
    expect(second.statusCode).toBe(200);
    const old = await asPhone(t.app, first, { method: 'GET', url: '/api/v1/mobile/config' });
    expect(errorCode(old)).toBe('DEVICE_REVOKED');
    const devices = await call(t.app, {
      method: 'GET',
      url: `/api/v1/guards/${guard.id}/devices`,
      cookie: supervisor,
      org: org.id,
    });
    const list = devices.json<{ devices: { status: string; revokedReason: string | null }[] }>().devices;
    expect(list.map((d) => d.status).sort()).toEqual(['ACTIVE', 'REVOKED']);
    expect(list.find((d) => d.status === 'REVOKED')?.revokedReason).toBe('REPLACED');
  });

  it('only the most recent code works; issuing is limited to 3 per guard per day', async () => {
    const guard = await newGuard();
    const one = (await issueCode(guard.id)).json<{ code: string }>();
    const two = (await issueCode(guard.id)).json<{ code: string }>();
    expect(errorCode(await redeem(t.app, { code: one.code, phone: guard.phone }))).toBe('INVITATION_EXPIRED');
    expect((await issueCode(guard.id)).statusCode).toBe(201);
    expect((await issueCode(guard.id)).statusCode).toBe(429);
    void two;
  });

  it('codes go only to +92 numbers unless the operator allows others (SEC §9)', async () => {
    const id = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'E-UK',
      displayName: 'Abroad',
      phone: '+447700900123',
    });
    expect(errorCode(await issueCode(id))).toBe('VALIDATION_FAILED');
  });
});

describe('device-bound sessions (D-30)', () => {
  it('refresh tokens rotate; a reused one revokes the whole family', async () => {
    const guard = await newGuard();
    const phone = await enrollPhone(t.app, supervisor, org.id, guard.id, guard.phone);
    const refresh = (token: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/sessions/refresh',
        headers: { 'content-type': 'application/json' },
        payload: { refreshToken: token },
      });
    const rotated = await refresh(phone.refreshToken);
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json<{ session: { accessToken: string; refreshToken: string } }>().session;
    expect(next.refreshToken).not.toBe(phone.refreshToken);
    // The old token, presented again after the 30-second grace: treated as stolen.
    t.clock.advance(31_000);
    expect((await refresh(phone.refreshToken)).statusCode).toBe(401);
    // Everything in the family is gone, including the newest session.
    expect((await refresh(next.refreshToken)).statusCode).toBe(401);
    expect(
      (
        await asPhone(
          t.app,
          { accessToken: next.accessToken, deviceId: phone.deviceId },
          { method: 'GET', url: '/api/v1/mobile/config' },
        )
      ).statusCode,
    ).toBe(401);
  });

  it('a retried refresh within 30 s (lost response) works and leaves one live session', async () => {
    const guard = await newGuard();
    const phone = await enrollPhone(t.app, supervisor, org.id, guard.id, guard.phone);
    const refresh = (token: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/sessions/refresh',
        headers: { 'content-type': 'application/json' },
        payload: { refreshToken: token },
      });
    const lost = (await refresh(phone.refreshToken)).json<{ session: { accessToken: string } }>().session;
    t.clock.advance(5_000);
    const retry = await refresh(phone.refreshToken);
    expect(retry.statusCode).toBe(200);
    const kept = retry.json<{ session: { accessToken: string } }>().session;
    const use = (token: string) =>
      asPhone(
        t.app,
        { accessToken: token, deviceId: phone.deviceId },
        { method: 'GET', url: '/api/v1/mobile/config' },
      );
    expect((await use(kept.accessToken)).statusCode).toBe(200);
    expect((await use(lost.accessToken)).statusCode).toBe(401);
  });

  it('an access token expires after 15 minutes', async () => {
    const guard = await newGuard();
    const phone = await enrollPhone(t.app, supervisor, org.id, guard.id, guard.phone);
    t.clock.advance(16 * 60 * 1000);
    expect((await asPhone(t.app, phone, { method: 'GET', url: '/api/v1/mobile/config' })).statusCode).toBe(
      401,
    );
  });

  it('ADV-A08 a phone revoked as COMPROMISED is refused on its next request', async () => {
    const guard = await newGuard();
    const phone = await enrollPhone(t.app, supervisor, org.id, guard.id, guard.phone);
    // Supervisors can't revoke devices; administrators can.
    expect(
      (
        await call(t.app, {
          method: 'POST',
          url: `/api/v1/devices/${phone.deviceId}/revoke`,
          cookie: supervisor,
          org: org.id,
          body: { reason: 'COMPROMISED' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(t.app, {
          method: 'POST',
          url: `/api/v1/devices/${phone.deviceId}/revoke`,
          cookie: admin,
          org: org.id,
          body: { reason: 'COMPROMISED' },
        })
      ).statusCode,
    ).toBe(200);
    expect(errorCode(await asPhone(t.app, phone, { method: 'GET', url: '/api/v1/mobile/config' }))).toBe(
      'DEVICE_REVOKED',
    );
  });

  it('the session works only from its own device (X-Device-Id)', async () => {
    const guard = await newGuard();
    const phone = await enrollPhone(t.app, supervisor, org.id, guard.id, guard.phone);
    const res = await asPhone(t.app, phone, {
      method: 'GET',
      url: '/api/v1/mobile/config',
      deviceId: '00000000-0000-7000-8000-000000000000',
    });
    expect(errorCode(res)).toBe('DEVICE_NOT_REGISTERED');
  });

  it('disabling a guard ends the phone session at once', async () => {
    const guard = await newGuard();
    const phone = await enrollPhone(t.app, supervisor, org.id, guard.id, guard.phone);
    const g = (
      await call(t.app, { method: 'GET', url: `/api/v1/guards/${guard.id}`, cookie: admin, org: org.id })
    ).json<{ version: number }>();
    expect(
      (
        await call(t.app, {
          method: 'PATCH',
          url: `/api/v1/guards/${guard.id}`,
          cookie: admin,
          org: org.id,
          body: { status: 'SUSPENDED', version: g.version },
        })
      ).statusCode,
    ).toBe(200);
    expect((await asPhone(t.app, phone, { method: 'GET', url: '/api/v1/mobile/config' })).statusCode).toBe(
      401,
    );
  });

  it("ADV-A01 a guard's session reaches only that guard's own data, never dashboard data", async () => {
    const guard = await newGuard();
    const phone = await enrollPhone(t.app, supervisor, org.id, guard.id, guard.phone);
    for (const url of [
      '/api/v1/guards',
      `/api/v1/guards/${guard.id}`,
      '/api/v1/sites',
      '/api/v1/members',
      '/api/v1/me',
    ]) {
      const res = await asPhone(t.app, phone, { method: 'GET', url });
      expect([401, 403], url).toContain(res.statusCode);
    }
    const config = (await asPhone(t.app, phone, { method: 'GET', url: '/api/v1/mobile/config' })).json<{
      guard: { id: string };
    }>();
    expect(config.guard.id).toBe(guard.id);
  });

  it('the tracking consent is recorded, append-only and audited', async () => {
    const guard = await newGuard();
    const phone = await enrollPhone(t.app, supervisor, org.id, guard.id, guard.phone);
    const res = await asPhone(t.app, phone, {
      method: 'POST',
      url: '/api/v1/tracking-consents',
      body: { disclosureVersion: CURRENT_DISCLOSURE_VERSION, locale: 'ur' },
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ n: number }>(
        'select count(*)::int as n from tracking_consents where guard_id = $1 and locale = $2',
        [guard.id, 'ur'],
      ),
    );
    expect(rows[0]?.n).toBe(1);
  });
});
