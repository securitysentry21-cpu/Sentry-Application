import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { latestMigrationVersion, loadMigrations, migrate, MigrationError } from '../src/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../test-support/index.ts';

let db: TestDatabase;

async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  db = await createTestDatabase(inject('adminUrl'));
});

afterAll(async () => {
  await db?.drop();
});

describe('migrations (ARCH §19.4)', () => {
  it('applies every migration to an empty database', async () => {
    const versions = (await loadMigrations()).map((m) => m.version);
    const { rows } = await withClient(db.urls.migrator, (c) =>
      c.query<{ version: string }>('select version from schema_migrations order by version'),
    );
    expect(rows.map((r) => r.version)).toEqual(versions);
    expect(await latestMigrationVersion()).toBe(versions.at(-1));
  });

  it('does nothing when no migration is pending', async () => {
    await expect(withClient(db.urls.migrator, (c) => migrate(c))).resolves.toEqual([]);
  });

  it('refuses to run as anyone but the table owner', async () => {
    await expect(withClient(db.urls.app_runtime, (c) => migrate(c))).rejects.toThrow(MigrationError);
  });

  it('refuses when an applied migration has been modified', async () => {
    const first = (await loadMigrations())[0]?.version;
    await withClient(db.urls.admin, (c) =>
      c.query("update schema_migrations set checksum = 'tampered' where version = $1", [first]),
    );
    await expect(withClient(db.urls.migrator, (c) => migrate(c))).rejects.toThrow(/was modified/);
  });
});
