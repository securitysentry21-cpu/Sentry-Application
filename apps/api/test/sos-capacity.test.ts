// Fable pass 2, review L-27: the SOS routes keep their own few database connections, so a storm of
// sync batches that takes every connection of the API's pool cannot hold an SOS back (INV-15); and a
// request that finds no connection answers 503 NOT_READY, not 500 (docs/testing/load-baseline.md,
// note 4): ordinary requests with a Retry-After, an SOS without one (the phone's SOS lane retries on
// its own short backoff).
import { randomUUID } from 'node:crypto';

import type { PoolClient } from '@sentryops/db';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  asPhone,
  call,
  createGuard,
  enrollPhoneWithKey,
  errorCode,
  seedOrganization,
  signIn,
  startTestApp,
  type TestApp,
} from './support.ts';

let t: TestApp;

beforeAll(async () => {
  // A main pool of 2 and an SOS pool of 1, each waiting at most 300 ms for a connection.
  t = await startTestApp({ poolMax: 2, sosPoolMax: 1, poolTimeoutMs: 300 });
});

afterAll(async () => {
  await t?.close();
});

let mono = 1_000_000;
function sosBody() {
  mono += 100;
  return {
    clientEventId: randomUUID(),
    recordedAt: t.clock.now().toISOString(),
    monoMs: mono,
    bootId: 'capacity-boot',
    fix: null,
    sentMonoMs: mono + 50,
  };
}

it('INV-15 an SOS is received while every other connection is taken; other requests answer 503 NOT_READY with Retry-After (review L-27)', async () => {
  const org = await seedOrganization(t.db, 'Busy Co', [{ email: 'admin@busy.test', role: 'ADMIN' }]);
  const admin = await signIn(t.app, 'admin@busy.test');
  const guardId = await createGuard(t.app, admin, org.id, {
    employeeNumber: 'B-1',
    displayName: 'Bilal Ahmed',
    phone: '+923001112233',
  });
  const phone = await enrollPhoneWithKey(t.app, admin, org.id, guardId, '+923001112233');

  // The storm: every connection of the API's pool is held.
  const held: PoolClient[] = await Promise.all([t.deps.pool.connect(), t.deps.pool.connect()]);
  try {
    const me = await call(t.app, { method: 'GET', url: '/api/v1/me', cookie: admin });
    expect(me.statusCode, me.body).toBe(503);
    expect(errorCode(me)).toBe('NOT_READY');
    expect(me.headers['retry-after']).toBe('5');

    const sos = await asPhone(t.app, phone, { method: 'POST', url: '/api/v1/sos', body: sosBody() });
    expect(sos.statusCode, sos.body).toBe(200);
    expect(sos.json<{ status: string }>().status).toBe('RECEIVED');
    const sosEventId = sos.json<{ sosEventId: string }>().sosEventId;
    const status = await asPhone(t.app, phone, { method: 'GET', url: `/api/v1/sos/${sosEventId}/status` });
    expect(status.statusCode, status.body).toBe(200);

    // With the SOS connections taken too, an SOS answers 503 and no Retry-After that would hold the
    // phone's next attempt back.
    const sosHeld = await t.deps.sos?.pool.connect();
    expect(sosHeld).toBeDefined();
    try {
      const second = await asPhone(t.app, phone, { method: 'POST', url: '/api/v1/sos', body: sosBody() });
      expect(second.statusCode, second.body).toBe(503);
      expect(errorCode(second)).toBe('NOT_READY');
      expect(second.headers['retry-after']).toBeUndefined();
    } finally {
      sosHeld?.release();
    }
  } finally {
    for (const client of held) client.release();
  }

  // Connections free again: everything answers.
  const after = await call(t.app, { method: 'GET', url: '/api/v1/me', cookie: admin });
  expect(after.statusCode, after.body).toBe(200);
});
