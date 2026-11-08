// The server refuses app versions the way ARCH §15.2 and INV-15 say: below the minimum, new work is
// refused (426) but already-captured data and an SOS still go through; a version revoked for
// security is refused everywhere except the config the app reads to learn it is out of date.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compareVersions, versionVerdict } from '../src/app-version.ts';
import {
  call,
  createGuard,
  enrollPhoneWithKey,
  errorCode,
  seedOrganization,
  signIn,
  signRequest,
  startTestApp,
  type TestApp,
} from './support.ts';

let t: TestApp;
let phone: Awaited<ReturnType<typeof enrollPhoneWithKey>>;
let admin: string;
let org: Awaited<ReturnType<typeof seedOrganization>>;

const config = () => t.deps.config as { MOBILE_MIN_VERSION: string; MOBILE_REVOKED_VERSIONS: string[] };

beforeAll(async () => {
  t = await startTestApp({ config: { FEATURE_SOS: true } });
  org = await seedOrganization(t.db, 'Version Co', [{ email: 'admin@version.test', role: 'ADMIN' }]);
  admin = await signIn(t.app, 'admin@version.test');
  const number = '+923000088001';
  const guardId = await createGuard(t.app, admin, org.id, {
    employeeNumber: 'V-1',
    displayName: 'Version guard',
    phone: number,
  });
  phone = await enrollPhoneWithKey(t.app, admin, org.id, guardId, number);
});

afterAll(async () => {
  await t?.close();
});

/** Runs `work` with the server's minimum and revoked list set, and puts them back. */
async function withVersions(
  settings: { min?: string; revoked?: string[] },
  work: () => Promise<void>,
): Promise<void> {
  const c = config();
  const before = { min: c.MOBILE_MIN_VERSION, revoked: c.MOBILE_REVOKED_VERSIONS };
  c.MOBILE_MIN_VERSION = settings.min ?? before.min;
  c.MOBILE_REVOKED_VERSIONS = settings.revoked ?? before.revoked;
  try {
    await work();
  } finally {
    c.MOBILE_MIN_VERSION = before.min;
    c.MOBILE_REVOKED_VERSIONS = before.revoked;
  }
}

const as = (version: string | null, method: 'GET' | 'POST', url: string, body?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${phone.accessToken}`,
      'x-device-id': phone.deviceId,
      ...(version ? { 'x-app-version': version } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });

const sosBody = () => ({
  clientEventId: randomUUID(),
  recordedAt: t.clock.now().toISOString(),
  monoMs: 1_000,
  bootId: 'boot-v',
  fix: null,
  sentMonoMs: 1_050,
});
const batch = () => ({
  batchId: randomUUID(),
  sentAt: t.clock.now().toISOString(),
  sentMonoMs: 1_000,
  bootId: 'boot-v',
  items: [
    {
      clientEventId: randomUUID(),
      type: 'HEARTBEAT',
      recordedAt: t.clock.now().toISOString(),
      monoMs: 900,
      bootId: 'boot-v',
      shiftId: null,
    },
  ],
});
const reports = () => ({
  reports: [
    {
      kind: 'UNHANDLED_ERROR',
      fatal: false,
      occurredAt: t.clock.now().toISOString(),
      errorName: 'TypeError',
      frames: [],
      appVersion: '0.1.0',
      platform: 'ANDROID',
      osVersion: '14',
    },
  ],
});

describe('comparing versions', () => {
  it('numbers, not text; a missing part is 0; the header must look like a version', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1);
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
    const cfg = { MOBILE_MIN_VERSION: '1.0.0', MOBILE_REVOKED_VERSIONS: ['1.2.3'] };
    expect(versionVerdict('1.2.3', cfg)).toBe('REVOKED');
    expect(versionVerdict('1.2.4', cfg)).toBe('OK');
    expect(versionVerdict('0.9.0', cfg)).toBe('BELOW_MINIMUM');
    expect(versionVerdict(undefined, cfg)).toBe('OK');
    expect(versionVerdict('not a version!', cfg)).toBe('OK');
    expect(versionVerdict(['1.2.3'], cfg)).toBe('OK');
  });
});

describe('below the minimum version (ARCH §15.2)', () => {
  it('new work is refused with 426; the config, queued uploads, crash reports and an SOS still go through (INV-15)', async () => {
    await withVersions({ min: '9.0.0' }, async () => {
      for (const [method, url, body] of [
        ['GET', '/api/v1/me/shifts', undefined],
        ['GET', '/api/v1/me/incidents', undefined],
        ['POST', '/api/v1/me/push-token', { provider: 'FCM', token: 'f'.repeat(40) }],
        ['POST', '/api/v1/tracking-consents', { disclosureVersion: '1', locale: 'en' }],
      ] as const) {
        const res = await as('0.1.0', method, url, body);
        expect(res.statusCode, url).toBe(426);
        expect(errorCode(res), url).toBe('APP_VERSION_UNSUPPORTED');
      }
      expect((await as('0.1.0', 'GET', '/api/v1/mobile/config')).statusCode).toBe(200);
      expect((await as('0.1.0', 'POST', '/api/v1/sync/batch', batch())).statusCode).toBe(200);
      expect((await as('0.1.0', 'POST', '/api/v1/diagnostics/app-errors', reports())).statusCode).toBe(204);
      expect((await as('0.1.0', 'POST', '/api/v1/sos', sosBody())).statusCode).toBe(200);
      // A current app is unaffected.
      expect((await as('9.0.0', 'GET', '/api/v1/me/shifts')).statusCode).toBe(200);
    });
  });

  it('an app that sends no version, or something that is not one, is not told to update; the dashboard never is', async () => {
    await withVersions({ min: '9.0.0', revoked: ['0.1.0'] }, async () => {
      expect((await as(null, 'GET', '/api/v1/me/shifts')).statusCode).toBe(200);
      expect((await as('???', 'GET', '/api/v1/me/shifts')).statusCode).toBe(200);
      const dashboard = await call(t.app, {
        method: 'GET',
        url: '/api/v1/me',
        cookie: admin,
        org: org.id,
        headers: { 'x-app-version': '0.0.1' },
      });
      expect(dashboard.statusCode).toBe(200);
    });
  });
});

describe('a version revoked for security (INV-15, the one exception)', () => {
  it('is refused on every guard route, SOS and uploads included, except the config it reads to learn that', async () => {
    await withVersions({ revoked: ['0.1.0'] }, async () => {
      for (const [method, url, body] of [
        ['GET', '/api/v1/me/shifts', undefined],
        ['POST', '/api/v1/sync/batch', batch()],
        ['POST', '/api/v1/sos', sosBody()],
        ['POST', '/api/v1/diagnostics/app-errors', reports()],
        ['POST', '/api/v1/me/push-token', { provider: 'FCM', token: 'f'.repeat(40) }],
      ] as const) {
        const res = await as('0.1.0', method, url, body);
        expect(res.statusCode, url).toBe(426);
        expect(errorCode(res), url).toBe('APP_VERSION_UNSUPPORTED');
      }
      const config = await as('0.1.0', 'GET', '/api/v1/mobile/config');
      expect(config.statusCode).toBe(200);
      expect(config.json<{ revokedVersions: string[] }>().revokedVersions).toEqual(['0.1.0']);
      // The next build is fine.
      expect((await as('0.1.1', 'GET', '/api/v1/me/shifts')).statusCode).toBe(200);
      expect((await as('0.1.1', 'POST', '/api/v1/sos', sosBody())).statusCode).toBe(200);
    });
  });

  it('an SOS signed with the device key, after the session expired, is refused for a revoked version too', async () => {
    t.clock.advance(16 * 60_000); // the access token has expired: the signature path is used
    const signed = (version: string) => {
      const body = JSON.stringify(sosBody());
      return t.app.inject({
        method: 'POST',
        url: '/api/v1/sos',
        headers: {
          'content-type': 'application/json',
          'x-device-id': phone.deviceId,
          'x-app-version': version,
          'x-device-signature': signRequest(phone.key, 'POST', '/api/v1/sos', body, t.clock.now().getTime()),
        },
        payload: body,
      });
    };
    await withVersions({ revoked: ['0.1.0'] }, async () => {
      const refused = await signed('0.1.0');
      expect(refused.statusCode, refused.body).toBe(426);
      expect(errorCode(refused)).toBe('APP_VERSION_UNSUPPORTED');
      expect((await signed('0.1.1')).statusCode).toBe(200);
    });
    // And below the minimum it is accepted, as before.
    await withVersions({ min: '9.0.0' }, async () => {
      expect((await signed('0.1.0')).statusCode).toBe(200);
    });
  });

  it('every guard route has a version rule: none is left out by accident', () => {
    // The set of routes that keep working below the minimum is small and named.
    const lenient = t.app.routeCatalog
      .filter((r) => r.policy?.appVersion !== undefined || r.policy?.sos === true)
      .map((r) => `${r.method} ${r.url} ${r.policy?.sos ? 'sos' : r.policy?.appVersion}`)
      .sort();
    expect(lenient).toEqual(
      [
        'POST /api/v1/sos sos',
        'GET /api/v1/sos/:id/status sos',
        'POST /api/v1/sos/:id/locations sos',
        'POST /api/v1/sos/:id/cancel-request sos',
        'GET /api/v1/mobile/config config',
        'POST /api/v1/sync/batch upload',
        'POST /api/v1/diagnostics/app-errors upload',
        'POST /api/v1/incidents/:id/attachments upload',
        'POST /api/v1/attachments/:id/complete upload',
      ].sort(),
    );
  });
});
