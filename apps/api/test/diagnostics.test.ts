// Crash reports from the guard app (ARCH §18.6, owner decision 2026-11-02, SEC §11, §15): accepted
// into the service log only, with the organization and device from the session, and refused whole
// when any field could carry free text.
import { Writable } from 'node:stream';

import { MAX_APP_ERROR_FRAMES, MAX_APP_ERROR_REPORTS } from '@sentryops/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loggerOptions } from '../src/logger.ts';
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
  type TestApp,
} from './support.ts';

const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _encoding, done) {
    lines.push(...chunk.toString().split('\n').filter(Boolean));
    done();
  },
});

const URL = '/api/v1/diagnostics/app-errors';

const report = (overrides: Record<string, unknown> = {}) => ({
  kind: 'UNHANDLED_ERROR',
  fatal: false,
  occurredAt: '2026-11-08T10:00:00.000Z',
  errorName: 'TypeError',
  frames: [{ fn: 'syncOnce', file: 'index.android.bundle', line: 1, column: 48213 }],
  appVersion: '0.1.0',
  platform: 'ANDROID',
  osVersion: '14',
  ...overrides,
});

describe('POST /diagnostics/app-errors', () => {
  let t: TestApp;
  let org: Awaited<ReturnType<typeof seedOrganization>>;
  let admin: string;
  let phone: Awaited<ReturnType<typeof enrollPhone>>;

  beforeAll(async () => {
    t = await startTestApp({ logger: { ...loggerOptions('info'), stream: sink } });
    org = await seedOrganization(t.db, 'Crash Co', [{ email: 'admin@crash.test', role: 'ADMIN' }]);
    admin = await signIn(t.app, 'admin@crash.test');
    const number = '+923000077001';
    const guardId = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'C-1',
      displayName: 'Crash guard',
      phone: number,
    });
    phone = await enrollPhone(t.app, admin, org.id, guardId, number);
  });

  afterAll(async () => {
    await t?.close();
  });

  const entries = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const appErrors = () => entries().filter((e) => e.msg === 'app_error');

  it("is written to the service log, keyed to the session's own organization and device, and stored nowhere else", async () => {
    const countRows = () =>
      asOwner(t.db, async (c) => {
        const count = async (table: string) =>
          (await c.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n;
        return [await count('audit_logs'), await count('device_status_events')];
      });
    const before = await countRows();
    lines.length = 0;
    const res = await asPhone(t.app, phone, {
      method: 'POST',
      url: URL,
      body: {
        reports: [
          report(),
          report({ kind: 'UNEXPECTED_CLOSE', fatal: true, errorName: 'UnexpectedClose', frames: [] }),
        ],
      },
    });
    expect(res.statusCode).toBe(204);

    const logged = appErrors();
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      org_id: org.id,
      device_id: phone.deviceId,
      app_error: { kind: 'UNHANDLED_ERROR', errorName: 'TypeError', appVersion: '0.1.0' },
    });
    expect(logged[1]).toMatchObject({ app_error: { kind: 'UNEXPECTED_CLOSE', fatal: true } });
    // Like every line written while serving a request (SEC §15).
    expect(typeof logged[0]?.request_id).toBe('string');
    expect(await countRows()).toEqual(before);
    expect(t.deps.metrics.get('app_errors_unhandled_error')).toBe(1);
    expect(t.deps.metrics.get('app_errors_unexpected_close')).toBe(1);
  });

  it('the request cannot name an organization or device: the session decides, and extra fields are refused', async () => {
    lines.length = 0;
    const res = await asPhone(t.app, phone, {
      method: 'POST',
      url: URL,
      body: { reports: [report()], organizationId: '00000000-0000-4000-8000-000000000001' },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
    const inReport = await asPhone(t.app, phone, {
      method: 'POST',
      url: URL,
      body: { reports: [report({ deviceId: '00000000-0000-4000-8000-000000000002' })] },
    });
    expect(inReport.statusCode).toBe(400);
    expect(appErrors()).toHaveLength(0);
  });

  it('refuses the whole request when any field could carry free text, a path, a number or a location', async () => {
    const refused = [
      ['message text as the name', report({ errorName: 'Error: back gate 3 was open' })],
      ['a phone number as the name', report({ errorName: '+923001234567' })],
      ['a message field', report({ message: 'Cannot read property of undefined' })],
      ['coordinates', report({ fix: { lat: 24.86, lon: 67.0 } })],
      [
        'a sentence as a function name',
        report({ frames: [{ fn: 'a guard saw an intruder', file: 'a.js', line: 1, column: 1 }] }),
      ],
      [
        'a directory in the file',
        report({ frames: [{ fn: 'f', file: '/data/user/0/app/files/a.js', line: 1, column: 1 }] }),
      ],
      [
        'a URL in the file',
        report({ frames: [{ fn: 'f', file: 'http://10.0.2.2:8081/index.bundle?x=1', line: 1, column: 1 }] }),
      ],
      ['a newline in a field', report({ appVersion: '0.1.0\n{"msg":"forged"}' })],
      [
        'too many frames',
        report({
          frames: Array.from({ length: MAX_APP_ERROR_FRAMES + 1 }, () => ({
            fn: 'f',
            file: 'a.js',
            line: 1,
            column: 1,
          })),
        }),
      ],
      ['an unknown kind', report({ kind: 'CRASH_WITH_DETAILS' })],
      ['a fractional line number', report({ frames: [{ fn: 'f', file: 'a.js', line: 1.5, column: 1 }] })],
    ] as const;
    lines.length = 0;
    for (const [label, bad] of refused) {
      const res = await asPhone(t.app, phone, { method: 'POST', url: URL, body: { reports: [bad] } });
      expect(res.statusCode, label).toBe(400);
    }
    // One bad report sinks the batch: nothing from it reaches the log.
    const mixed = await asPhone(t.app, phone, {
      method: 'POST',
      url: URL,
      body: { reports: [report(), report({ errorName: 'bad name with spaces' })] },
    });
    expect(mixed.statusCode).toBe(400);
    for (const size of [0, MAX_APP_ERROR_REPORTS + 1]) {
      const res = await asPhone(t.app, phone, {
        method: 'POST',
        url: URL,
        body: { reports: Array.from({ length: size }, () => report()) },
      });
      expect(res.statusCode, `${size} reports`).toBe(400);
    }
    expect(appErrors()).toHaveLength(0);
  });

  it('only a signed-in guard phone may report: a dashboard member and a stranger cannot', async () => {
    const member = await call(t.app, {
      method: 'POST',
      url: URL,
      cookie: admin,
      org: org.id,
      body: { reports: [report()] },
    });
    expect(member.statusCode).toBe(403);
    const stranger = await t.app.inject({
      method: 'POST',
      url: URL,
      headers: { 'content-type': 'application/json', 'x-device-id': phone.deviceId },
      payload: { reports: [report()] },
    });
    expect(stranger.statusCode).toBe(401);
  });
});
