import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { lintSchema } from '../src/schema-lint.ts';
import { createTestDatabase, FIXTURE_REGISTRY, type TestDatabase } from '../test-support/index.ts';

async function lint(url: string, registry = FIXTURE_REGISTRY): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await lintSchema(client, registry);
  } finally {
    await client.end();
  }
}

describe('schema linter (ADV-X01)', () => {
  let clean: TestDatabase;
  let broken: TestDatabase;

  beforeAll(async () => {
    clean = await createTestDatabase(inject('adminUrl'), { fixtures: true });
    broken = await createTestDatabase(inject('adminUrl'), { fixtures: true });
    // Break the second database in every way the linter must catch.
    const m = new pg.Client({ connectionString: broken.urls.migrator });
    await m.connect();
    try {
      await m.query('create table stray (id uuid primary key)');
      await m.query('alter table fixture_site_notes disable row level security');
      await m.query('alter table fixture_sites force row level security');
      await m.query('grant update on fixture_events to app_runtime');
      await m.query(`create table bad_child (
        id uuid primary key,
        organization_id uuid not null references organizations (id),
        site_id uuid not null references fixture_sites (id),
        unique (organization_id, id))`);
      // Nullable organization_id and no UNIQUE (organization_id, id).
      await m.query('create table loose_child (id uuid primary key, organization_id uuid)');
      // Roles are shared by every test database, so only grants are broken here, never role flags.
      await m.query('grant delete on fixture_events to system_worker');
    } finally {
      await m.end();
    }
  });

  afterAll(async () => {
    await clean?.drop();
    await broken?.drop();
  });

  it('ADV-X01 the migrated schema plus the fixture tables follow every tenancy rule', async () => {
    expect(await lint(clean.urls.admin)).toEqual([]);
  });

  it('ADV-X01 the linter catches each kind of violation', async () => {
    const problems = await lint(broken.urls.admin, {
      ...FIXTURE_REGISTRY,
      bad_child: { kind: 'tenant' },
      loose_child: { kind: 'tenant' },
      ghost: { kind: 'tenant' },
    });
    // One pattern per rule in SEC's ADV-X01 definition, so a rule that stops working fails here.
    const expected = [
      /public\.stray: not classified/,
      /fixture_site_notes: row-level security is not enabled/,
      /fixture_sites: RLS is forced/,
      /bad_child: no RLS policy applies to app_runtime/,
      /loose_child: organization_id must be NOT NULL/,
      /loose_child: missing UNIQUE \(organization_id, id\)/,
      /bad_child: foreign key .* to fixture_sites must include organization_id/,
      /fixture_events: app_runtime has UPDATE on an append-only table/,
      /fixture_events: system_worker has DELETE on an append-only table/,
      /registry lists ghost, but the table does not exist/,
    ];
    for (const pattern of expected)
      expect(
        problems.some((p) => pattern.test(p)),
        String(pattern),
      ).toBe(true);
  });
});
