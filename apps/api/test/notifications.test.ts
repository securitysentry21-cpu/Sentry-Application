// Notifications (ARCH §13.4, PROD §11.4–§11.5, §13): Web Push encryption and VAPID against their RFCs,
// subscriptions limited to real push services, the test alert, SMS rules (allow-list outside
// production, one per recipient per SOS per minute, the non-SOS monthly cap), members' SOS numbers,
// and pushes to the guard's phone.
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  verify,
} from 'node:crypto';

import { createKysely, createPool, type Pool } from '@sentryops/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProviders } from '../src/notify/providers.ts';
import {
  encryptPayload,
  isPushServiceEndpoint,
  vapidAuthorization,
  vapidKeysFromPem,
} from '../src/notify/webpush.ts';
import { runSender } from '../src/workers/notifications.ts';
import { browserSubscription, fakeProviders } from './fake-providers.ts';
import {
  asOwner,
  asPhone,
  call,
  createGuard,
  enrollPhone,
  errorCode,
  seedOrganization,
  signIn,
  startTestApp,
  testConfig,
  type TestApp,
} from './support.ts';

const b64u = (s: string) => Buffer.from(s, 'base64url');

describe('Web Push (RFC 8291, RFC 8292)', () => {
  it("encrypts exactly as RFC 8291's worked example", () => {
    const body = encryptPayload({
      plaintext: Buffer.from('When I grow up, I want to be a watermelon', 'utf8'),
      uaPublic: b64u(
        'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      ),
      authSecret: b64u('BTBZMqHH6r4Tts7J_aSIgg'),
      asPrivate: b64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      salt: b64u('DGv6ra1nlYgDCS1FRnbzlw'),
    });
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('a browser holding the private key and auth secret can decrypt a fresh message', () => {
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const auth = Buffer.from('0123456789abcdef');
    const body = encryptPayload({
      plaintext: Buffer.from('{"kind":"SOS"}'),
      uaPublic: browser.getPublicKey(),
      authSecret: auth,
    });
    // The receiving side of RFC 8291 §3.
    const salt = body.subarray(0, 16);
    const asPublic = body.subarray(21, 86);
    const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
    const ikm = hmac(
      hmac(auth, browser.computeSecret(asPublic)),
      Buffer.concat([
        Buffer.from('WebPush: info\0', 'latin1'),
        browser.getPublicKey(),
        asPublic,
        Buffer.from([1]),
      ]),
    );
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
    const record = body.subarray(86);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
    expect(plain.subarray(0, -1).toString()).toBe('{"kind":"SOS"}');
    expect(plain.at(-1)).toBe(2);
  });

  it('VAPID: an ES256 token for the push service, valid 12 hours, verifiable with the public key', () => {
    const server = createECDH('prime256v1');
    server.generateKeys();
    const keys = {
      publicKey: server.getPublicKey().toString('base64url'),
      privateKey: server.getPrivateKey().toString('base64url'),
    };
    const header = vapidAuthorization({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys,
      subject: 'https://dashboard.example',
      nowS: 1_000,
    });
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match?.[4]).toBe(keys.publicKey);
    const claims = JSON.parse(b64u(match?.[2] ?? '').toString()) as { aud: string; exp: number; sub: string };
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_000 + 12 * 3600,
      sub: 'https://dashboard.example',
    });
    const pub = server.getPublicKey();
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const ok = verify(
      'sha256',
      Buffer.from(`${match?.[1]}.${match?.[2]}`),
      { key, dsaEncoding: 'ieee-p1363' },
      b64u(match?.[3] ?? ''),
    );
    expect(ok).toBe(true);
  });

  it('the key pair can come as one PEM private key (what infra generates): the same keys, a token that verifies', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const keys = vapidKeysFromPem(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    expect(Buffer.from(keys.publicKey, 'base64url')).toEqual(
      publicKey.export({ format: 'der', type: 'spki' }).subarray(-65),
    );
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
    const header = vapidAuthorization({
      endpoint: 'https://web.push.apple.com/x',
      keys,
      subject: 'https://dashboard.example',
      nowS: 1,
    });
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=/.exec(header);
    const ok = verify(
      'sha256',
      Buffer.from(`${match?.[1]}.${match?.[2]}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      b64u(match?.[3] ?? ''),
    );
    expect(ok).toBe(true);
    // The API gets only the public half: it tells browsers the same key, and has nothing to send with.
    const apiSide = createProviders(
      {
        ...testConfig('postgres://unused'),
        WEB_PUSH_VAPID_PUBLIC_KEY_PEM: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      },
      () => 1,
    );
    expect(apiSide.vapidPublicKey).toBe(keys.publicKey);
    expect(apiSide.webPush).toBeNull();
    // An RSA key, or any other curve, is refused rather than used.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    expect(() => vapidKeysFromPem(rsa)).toThrow();
  });

  it('only real push services are ever called (no address a user chose)', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      expect(isPushServiceEndpoint(ok), ok).toBe(true);
    }
    for (const bad of [
      'http://fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://169.254.169.254/latest/meta-data',
      'https://fcm.googleapis.com.evil.example/x',
      'https://localhost/x',
      'not a url',
    ]) {
      expect(isPushServiceEndpoint(bad), bad).toBe(false);
    }
  });
});

describe('through the API', () => {
  let t: TestApp;
  let sweepPool: Pool;
  const providers = fakeProviders();
  let org: Awaited<ReturnType<typeof seedOrganization>>;
  let owner: string;
  let admin: string;
  let supervisor: string;
  const send = () => runSender({ ...t.deps, sweep: createKysely(sweepPool) });
  const member = (email: string) => org.members[email]?.memberId ?? '';

  beforeAll(async () => {
    t = await startTestApp({ notify: providers, config: { SMS_ALLOWED_NUMBERS: ['+923331110001'] } });
    sweepPool = createPool(t.db.urls.system_worker, { max: 2 });
    org = await seedOrganization(t.db, 'Notify Co', [
      { email: 'owner@notify.test', role: 'OWNER' },
      { email: 'admin@notify.test', role: 'ADMIN' },
      { email: 'sup@notify.test', role: 'SUPERVISOR' },
    ]);
    owner = await signIn(t.app, 'owner@notify.test');
    admin = await signIn(t.app, 'admin@notify.test');
    supervisor = await signIn(t.app, 'sup@notify.test');
  });

  afterAll(async () => {
    await sweepPool?.end();
    await t?.close();
  });

  it("members' SOS numbers: set by an owner or administrator, an owner's only by an owner, recorded masked", async () => {
    const put = (cookie: string, email: string, phone: string | null) =>
      call(t.app, {
        method: 'PUT',
        url: `/api/v1/members/${member(email)}/alert-phone`,
        cookie,
        org: org.id,
        body: { phone },
      });
    expect((await put(admin, 'sup@notify.test', '+923331110001')).statusCode).toBe(200);
    expect(errorCode(await put(admin, 'owner@notify.test', '+923331110002'))).toBe('FORBIDDEN');
    expect((await put(admin, 'admin@notify.test', '+923331110003')).statusCode).toBe(200);
    expect((await put(owner, 'owner@notify.test', '+923331110002')).statusCode).toBe(200);
    expect(errorCode(await put(supervisor, 'sup@notify.test', '+923331119999'))).toBe('FORBIDDEN');
    expect(errorCode(await put(admin, 'sup@notify.test', '0300 1234567'))).toBe('VALIDATION_FAILED');
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ metadata: Record<string, string> }>(
        `select metadata from audit_logs where action = 'MEMBER_PHONE_CHANGED' and resource_id = $1`,
        [member('sup@notify.test')],
      ),
    );
    expect(rows[0]?.metadata).toEqual({ from: null, to: '+9233•••001' });
    expect(JSON.stringify(rows)).not.toContain('3331110001');
  });

  it('subscriptions: only push-service endpoints; a member lists and removes only their own', async () => {
    const bad = await call(t.app, {
      method: 'POST',
      url: '/api/v1/push-subscriptions',
      cookie: supervisor,
      org: org.id,
      body: { ...browserSubscription(), endpoint: 'https://169.254.169.254/latest' },
    });
    expect(errorCode(bad)).toBe('VALIDATION_FAILED');
    const mine = await call(t.app, {
      method: 'POST',
      url: '/api/v1/push-subscriptions',
      cookie: supervisor,
      org: org.id,
      body: browserSubscription(),
    });
    const theirs = await call(t.app, {
      method: 'POST',
      url: '/api/v1/push-subscriptions',
      cookie: admin,
      org: org.id,
      body: browserSubscription(),
    });
    const theirId = theirs.json<{ subscription: { id: string } }>().subscription.id;
    const list = await call(t.app, {
      method: 'GET',
      url: '/api/v1/push-subscriptions',
      cookie: supervisor,
      org: org.id,
    });
    expect(list.json<{ subscriptions: { id: string }[] }>().subscriptions.map((s) => s.id)).toEqual([
      mine.json<{ subscription: { id: string } }>().subscription.id,
    ]);
    const removeTheirs = await call(t.app, {
      method: 'DELETE',
      url: `/api/v1/push-subscriptions/${theirId}`,
      cookie: supervisor,
      org: org.id,
    });
    expect(removeTheirs.statusCode).toBe(404);
    const config = await call(t.app, {
      method: 'GET',
      url: '/api/v1/push/config',
      cookie: supervisor,
      org: org.id,
    });
    expect(config.json<{ vapidPublicKey: string }>().vapidPublicKey).toBe(providers.webPush.publicKey);
  });

  it('"Send me a test SOS alert" reaches the caller\'s own browsers and number, and nobody else', async () => {
    const before = providers.webPush.sent.length;
    const smsBefore = providers.sms.sent.length;
    const res = await call(t.app, {
      method: 'POST',
      url: '/api/v1/notifications/test',
      cookie: supervisor,
      org: org.id,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ webPush: 1, sms: 1 });
    await send();
    expect(providers.webPush.sent.slice(before)).toHaveLength(1);
    const texts = providers.sms.sent.slice(smsBefore);
    expect(texts.map((m) => m.to)).toEqual(['+923331110001']);
    expect(texts[0]?.text).toContain('TEST');
  });

  it('outside production a text goes only to allow-listed numbers; the rest are suppressed, never sent', async () => {
    const res = await call(t.app, {
      method: 'POST',
      url: '/api/v1/notifications/test',
      cookie: admin,
      org: org.id,
    });
    expect(res.json()).toMatchObject({ sms: 1 });
    const before = providers.sms.sent.length;
    await send();
    expect(providers.sms.sent.length).toBe(before);
    const { rows } = await asOwner(t.db, (c) =>
      c.query(
        `select status, error_code from notification_deliveries where channel = 'SMS' and recipient_phone = '+923331110003'`,
      ),
    );
    expect(rows).toEqual([{ status: 'SUPPRESSED', error_code: 'NOT_ALLOW_LISTED' }]);
  });

  it('PROD §11.9 one text per recipient per SOS per minute; the ladder restarting within it is throttled', async () => {
    const number = '+923000099001';
    const guardId = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'N-1',
      displayName: 'Notify guard',
      phone: number,
    });
    const phone = await enrollPhone(t.app, admin, org.id, guardId, number);
    const body = () => ({
      clientEventId: randomUUID(),
      recordedAt: t.clock.now().toISOString(),
      monoMs: 1,
      bootId: 'b',
      fix: null,
    });
    const first = await asPhone(t.app, phone, { method: 'POST', url: '/api/v1/sos', body: body() });
    const id = first.json<{ sosEventId: string }>().sosEventId;
    await call(t.app, {
      method: 'POST',
      url: `/api/v1/sos/${id}/acknowledge`,
      cookie: supervisor,
      org: org.id,
      body: {},
    });
    t.clock.advance(20_000);
    await asPhone(t.app, phone, { method: 'POST', url: '/api/v1/sos', body: body() });
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ status: string; error_code: string | null }>(
        `select status, error_code from notification_deliveries where sos_event_id = $1 and channel = 'SMS' order by created_at`,
        [id],
      ),
    );
    expect(rows).toEqual([
      { status: 'QUEUED', error_code: null },
      { status: 'SUPPRESSED', error_code: 'THROTTLED' },
    ]);

    // The guard's phone hears "acknowledged" by push once it has a token (D-26).
    const token = await asPhone(t.app, phone, {
      method: 'POST',
      url: '/api/v1/me/push-token',
      body: { provider: 'FCM', token: 'f'.repeat(40) },
    });
    expect(token.statusCode).toBe(204);
    await call(t.app, {
      method: 'POST',
      url: `/api/v1/sos/${id}/acknowledge`,
      cookie: supervisor,
      org: org.id,
      body: {},
    });
    await send();
    expect(providers.fcm.sent.at(-1)).toMatchObject({
      token: 'f'.repeat(40),
      title: 'SOS acknowledged',
      data: { sosEventId: id },
    });
  });

  it('non-SOS texts stop at the monthly cap (PROD §13); SOS texts never do', async () => {
    await asOwner(t.db, (c) =>
      c.query(`update organization_settings set overrides = $1 where organization_id = $2`, [
        JSON.stringify({
          'notifications.non_sos_sms_monthly_cap': 0,
          'alerts.routing': {
            CRITICAL: { roles: ['SUPERVISOR'], channels: ['DASHBOARD', 'SMS'], escalate: false },
            HIGH: { roles: ['SUPERVISOR'], channels: ['DASHBOARD', 'SMS'], escalate: false },
            MEDIUM: { roles: [], channels: ['DASHBOARD'], escalate: false },
            LOW: { roles: [], channels: ['DASHBOARD'], escalate: false },
          },
        }),
        org.id,
      ]),
    );
    const created = await call(t.app, {
      method: 'POST',
      url: '/api/v1/incidents',
      cookie: supervisor,
      org: org.id,
      body: { type: 'FIRE', severity: 'HIGH', title: 'Generator fire' },
    });
    const incidentId = created.json<{ incident: { id: string } }>().incident.id;
    const { rows } = await asOwner(t.db, (c) =>
      c.query(
        `select d.status, d.error_code from notification_deliveries d join alerts a on a.id = d.alert_id
          where a.incident_id = $1 and d.channel = 'SMS'`,
        [incidentId],
      ),
    );
    expect(rows).toEqual([{ status: 'SUPPRESSED', error_code: 'MONTHLY_CAP' }]);
  });

  it("ADV-A10 a push token goes on the caller's own phone, never another guard's or organization's", async () => {
    // Review L-08: the fixture list said so; this proves it. Two guards, two organizations.
    const other = await seedOrganization(t.db, 'Other Notify Co', [
      { email: 'admin@other-notify.test', role: 'ADMIN' },
    ]);
    const otherAdmin = await signIn(t.app, 'admin@other-notify.test');
    const mineId = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'PT-1',
      displayName: 'Token one',
      phone: '+923000099011',
    });
    const theirsId = await createGuard(t.app, otherAdmin, other.id, {
      employeeNumber: 'PT-2',
      displayName: 'Token two',
      phone: '+923000099012',
    });
    const mine = await enrollPhone(t.app, admin, org.id, mineId, '+923000099011');
    const theirs = await enrollPhone(t.app, otherAdmin, other.id, theirsId, '+923000099012');

    const registered = await asPhone(t.app, mine, {
      method: 'POST',
      url: '/api/v1/me/push-token',
      body: { provider: 'FCM', token: 'm'.repeat(40) },
    });
    expect(registered.statusCode).toBe(204);
    // A body that names another phone or organization is refused, not applied.
    for (const extra of [
      { deviceId: theirs.deviceId },
      { organizationId: other.id },
      { guardId: theirsId },
    ]) {
      const res = await asPhone(t.app, mine, {
        method: 'POST',
        url: '/api/v1/me/push-token',
        body: { provider: 'FCM', token: 'x'.repeat(40), ...extra },
      });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }

    const admin_ = new pg.Client({ connectionString: t.db.urls.admin });
    await admin_.connect();
    try {
      const rows = await admin_.query<{ id: string; push_token: string | null }>(
        'select id, push_token from guard_devices where id = any($1)',
        [[mine.deviceId, theirs.deviceId]],
      );
      const token = (id: string) => rows.rows.find((r) => r.id === id)?.push_token ?? null;
      expect(token(mine.deviceId)).toBe('m'.repeat(40));
      expect(token(theirs.deviceId)).toBeNull();
    } finally {
      await admin_.end();
    }
  });

  it('a guard hears about a new shift and a cancelled one on the phone, in their language', async () => {
    const number = '+923000099002';
    const guardId = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'N-2',
      displayName: 'Shift guard',
      phone: number,
    });
    const phone = await enrollPhone(t.app, admin, org.id, guardId, number);
    await asPhone(t.app, phone, {
      method: 'POST',
      url: '/api/v1/me/push-token',
      body: { provider: 'FCM', token: 'g'.repeat(40) },
    });
    const site = await call(t.app, {
      method: 'POST',
      url: '/api/v1/sites',
      cookie: admin,
      org: org.id,
      body: {
        name: 'Main gate',
        boundary: { kind: 'CIRCLE', center: { lat: 31.47, lng: 74.4 }, radiusM: 300 },
      },
    });
    const startsAt = new Date(t.clock.now().getTime() + 26 * 3_600_000);
    const shift = await call(t.app, {
      method: 'POST',
      url: '/api/v1/shifts',
      cookie: admin,
      org: org.id,
      body: {
        guardId,
        siteId: site.json<{ id: string }>().id,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 8 * 3_600_000).toISOString(),
      },
    });
    await call(t.app, {
      method: 'POST',
      url: `/api/v1/shifts/${shift.json<{ id: string }>().id}/cancel`,
      cookie: admin,
      org: org.id,
      body: { reason: 'Client closed for the holiday' },
    });
    await send();
    const mine = providers.fcm.sent.filter((s) => s.token === 'g'.repeat(40));
    expect(mine.map((s) => s.title)).toEqual(['New shift', 'Shift cancelled']);
    expect(mine[0]?.body).toMatch(/^Main gate · /);
  });
});
