import { RuntimeRoleError } from '@sentryops/db';
import { createTestDatabase, type TestDatabase } from '@sentryops/db/test-support';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { start } from '../src/server.ts';
import { testConfig } from './support.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase(inject('adminUrl'));
});

afterAll(async () => {
  await db?.drop();
});

describe('API startup (D-33)', () => {
  it('ADV-X07 the API refuses to start when DATABASE_URL points at the table owner', async () => {
    await expect(start(testConfig(db.urls.migrator), { logger: false })).rejects.toThrow(RuntimeRoleError);
  });

  it('ADV-X07 the API refuses to start as another runtime role', async () => {
    await expect(start(testConfig(db.urls.retention_worker), { logger: false })).rejects.toThrow(
      /expected one of app_runtime/,
    );
  });

  it('ADV-X07 the API starts as app_runtime and serves requests', async () => {
    const app = await start(testConfig(db.urls.app_runtime), { logger: false });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/ready' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
