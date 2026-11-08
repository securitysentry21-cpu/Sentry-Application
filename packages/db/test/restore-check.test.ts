import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { latestMigrationVersion } from '../src/migrate.ts';
import { checkRestoredDatabase } from '../src/restore-check.ts';
import type { DbRole } from '../src/roles.ts';
import { createTestDatabase, FIXTURE_REGISTRY, type TestDatabase } from '../test-support/index.ts';

/** Connects as each role; `instead` connects as another role in its place. */
function connectTo(db: TestDatabase, instead: Partial<Record<DbRole, DbRole>> = {}) {
  return async (role: DbRole): Promise<pg.Client> => {
    const client = new pg.Client({ connectionString: db.urls[instead[role] ?? role] });
    await client.connect();
    return client;
  };
}

describe('restore check (ARCH §19.6)', () => {
  let intact: TestDatabase;
  let damaged: TestDatabase;

  beforeAll(async () => {
    intact = await createTestDatabase(inject('adminUrl'), { fixtures: true });
    damaged = await createTestDatabase(inject('adminUrl'), { fixtures: true });
    // A copy that lost its newest migration's record and one table's row-level security.
    const m = new pg.Client({ connectionString: damaged.urls.migrator });
    await m.connect();
    try {
      await m.query(
        'delete from schema_migrations where version = (select max(version) from schema_migrations)',
      );
      await m.query('alter table fixture_site_notes disable row level security');
    } finally {
      await m.end();
    }
  });

  afterAll(async () => {
    await intact?.drop();
    await damaged?.drop();
  });

  it('passes an intact copy: every migration, a clean schema, the runtime roles, every table counted', async () => {
    const result = await checkRestoredDatabase(connectTo(intact), FIXTURE_REGISTRY);
    expect(result.problems).toEqual([]);
    expect(result.latestMigration).toBe(await latestMigrationVersion());
    expect(Object.keys(result.rows).sort()).toEqual(Object.keys(FIXTURE_REGISTRY).sort());
    expect(Object.values(result.rows).every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  });

  it('reports what a damaged copy lost, and repairs nothing', async () => {
    const latest = await latestMigrationVersion();
    const result = await checkRestoredDatabase(connectTo(damaged), FIXTURE_REGISTRY);
    expect(result.problems).toContain(`migration ${latest} is not applied`);
    expect(result.problems.some((p) => p.includes('fixture_site_notes'))).toBe(true);
    // Read-only: a second run finds the same damage.
    expect((await checkRestoredDatabase(connectTo(damaged), FIXTURE_REGISTRY)).problems).toEqual(
      result.problems,
    );
  });

  it('reports a runtime role that could bypass row-level security', async () => {
    // A wrong password list connecting the table owner in app_runtime's place.
    const result = await checkRestoredDatabase(
      connectTo(intact, { app_runtime: 'migrator' }),
      FIXTURE_REGISTRY,
    );
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/^app_runtime: refusing to start: connected as "migrator"/);
  });
});
