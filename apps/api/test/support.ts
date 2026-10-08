// Shared test kit: a real app over a fresh test database, signed in through the development
// sign-in, so tests exercise the same request pipeline (CSRF, session, organization, permission)
// as the dashboard does.
import { randomUUID } from 'node:crypto';

import { createPool, type Pool } from '@sentryops/db';
import { createTestDatabase, type TestDatabase } from '@sentryops/db/test-support';
import { FakeClock } from '@sentryops/domain';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';

import { buildApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import type { AppDeps } from '../src/deps.ts';
import { createDeps } from '../src/server.ts';

export const NOW = '2026-10-08T19:57:03.120Z';

export function testConfig(databaseUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    DATABASE_URL: databaseUrl,
    CELL_REGION: 'eu-central-1',
    LOG_LEVEL: 'silent',
    PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    DEV_AUTH: true,
    TRUST_PROXY: false,
    ...overrides,
  };
}

/** A URL nothing listens on: the pool only fails when used. */
export const UNREACHABLE_DATABASE = 'postgres://app_runtime:unused@127.0.0.1:1/none';

export type TestApp = {
  readonly app: FastifyInstance;
  readonly deps: AppDeps;
  readonly db: TestDatabase;
  readonly clock: FakeClock;
  close(): Promise<void>;
};

export async function startTestApp(options: { config?: Partial<Config> } = {}): Promise<TestApp> {
  const db = await createTestDatabase(inject('adminUrl'));
  const pool: Pool = createPool(db.urls.app_runtime, { max: 4 });
  const clock = new FakeClock(NOW);
  const deps = createDeps(testConfig(db.urls.app_runtime, options.config), pool, { clock, oidc: null });
  const app = buildApp(deps, { logger: false });
  await app.ready();
  return {
    app,
    deps,
    db,
    clock,
    close: async () => {
      await app.close();
      await pool.end();
      await db.drop();
    },
  };
}

/** Runs SQL as the table owner, for seeding and for arranging states the API can't produce. */
export async function asOwner<T>(db: TestDatabase, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: db.urls.migrator });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export type SeededMember = { readonly userId: string; readonly memberId: string; readonly email: string };

/** An organization with members, created directly in the database. */
export async function seedOrganization(
  db: TestDatabase,
  name: string,
  members: readonly { email: string; role: string; status?: string }[],
): Promise<{ id: string; members: Record<string, SeededMember> }> {
  const id = randomUUID();
  const seeded: Record<string, SeededMember> = {};
  await asOwner(db, async (c) => {
    await c.query(
      `insert into organizations (id, name, timezone, data_region) values ($1, $2, 'Asia/Karachi', 'eu-central-1')`,
      [id, name],
    );
    await c.query(`insert into organization_settings (id, organization_id) values ($1, $2)`, [
      randomUUID(),
      id,
    ]);
    for (const m of members) {
      const existing = await c.query<{ id: string }>('select id from users where email = $1', [m.email]);
      const userId = existing.rows[0]?.id ?? randomUUID();
      if (!existing.rows[0]) {
        await c.query(`insert into users (id, email, name) values ($1, $2, $3)`, [
          userId,
          m.email,
          m.email.split('@')[0],
        ]);
      }
      const memberId = randomUUID();
      await c.query(
        `insert into organization_members (id, organization_id, user_id, role, status) values ($1, $2, $3, $4, $5)`,
        [memberId, id, userId, m.role, m.status ?? 'ACTIVE'],
      );
      seeded[m.email] = { userId, memberId, email: m.email };
    }
  });
  return { id, members: seeded };
}

/** Signs in through the development sign-in and returns the cookie header to send. */
export async function signIn(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    headers: { 'x-sentry-csrf': '1', 'content-type': 'application/json' },
    payload: { email },
  });
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
  if (!cookie) throw new Error('no session cookie');
  return cookie;
}

/** A request the way the dashboard sends it: cookie, CSRF header and organization header. */
export function call(
  app: FastifyInstance,
  options: {
    method: InjectOptions['method'];
    url: string;
    cookie?: string;
    org?: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
) {
  const headers: Record<string, string> = { 'x-sentry-csrf': '1', ...options.headers };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.org) headers['x-organization-id'] = options.org;
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.body === undefined ? {} : { payload: options.body as Record<string, unknown> }),
  });
}

export const errorCode = (res: { json: () => unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;
