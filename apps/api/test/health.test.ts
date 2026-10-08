import { errorEnvelopeSchema } from '@sentryops/contracts';
import { createPool, type Pool } from '@sentryops/db';
import { createTestDatabase, type TestDatabase } from '@sentryops/db/test-support';
import { FakeClock } from '@sentryops/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { NOW, testConfig, UNREACHABLE_DATABASE } from './support.ts';

let db: TestDatabase;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  db = await createTestDatabase(inject('adminUrl'));
  pool = createPool(db.urls.app_runtime, { max: 2 });
  app = buildApp(
    { pool, clock: new FakeClock(NOW), config: testConfig(db.urls.app_runtime) },
    { logger: false },
  );
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

describe('health and readiness (ARCH §18.5)', () => {
  it('GET /api/v1/health answers without touching any dependency', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('every response carries X-Request-Id and X-Server-Time from the injected clock', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-server-time']).toBe(NOW);
  });

  it('SEC §10 every response, including errors, carries the security headers and is not cached', async () => {
    for (const url of ['/api/v1/health', '/api/v1/nothing-here']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy'], url).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['strict-transport-security'], url).toBe('max-age=63072000; includeSubDomains');
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
      expect(res.headers['cache-control'], url).toBe('no-store');
    }
  });

  it('echoes a well-formed X-Request-Id and replaces a malformed one', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(ok.headers['x-request-id']).toBe('abc-123');
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'not ok <script>' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /api/v1/ready reports ready when the database answers and the schema is current', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('GET /api/v1/ready returns NOT_READY, without internal details, when the database is unreachable', async () => {
    const deadPool = createPool(UNREACHABLE_DATABASE, { connectionTimeoutMs: 1_000 });
    const broken = buildApp(
      { pool: deadPool, clock: new FakeClock(NOW), config: testConfig(UNREACHABLE_DATABASE) },
      { logger: false },
    );
    try {
      const res = await broken.inject({ method: 'GET', url: '/api/v1/ready' });
      expect(res.statusCode).toBe(503);
      const body = errorEnvelopeSchema.parse(res.json());
      expect(body.error.code).toBe('NOT_READY');
      expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|schema/);
    } finally {
      await broken.close();
      await deadPool.end();
    }
  });

  it('unknown routes get the NOT_FOUND envelope with the request ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nothing-here',
      headers: { 'x-request-id': 'req-1' },
    });
    expect(res.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(res.json())).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'req-1' },
    });
  });
});
