// RLS proof of concept (Phase 0 exit test): a cross-tenant read is blocked under app_runtime.
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { tenantTables } from '../src/registry.ts';
import { withTenant } from '../src/tenant.ts';
import { createTestDatabase, FIXTURE_REGISTRY, type TestDatabase } from '../test-support/index.ts';

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const SITE_A = randomUUID();
const SITE_B = randomUUID();
// Generated from the table registry (ADV-T06 says every tenant table), never a hand-kept list.
const TENANT_TABLES = tenantTables(FIXTURE_REGISTRY);
const orgColumn = (table: string) =>
  FIXTURE_REGISTRY[table]?.kind === 'tenant-root' ? 'id' : 'organization_id';

let db: TestDatabase;
let runtime: pg.Pool;

async function asMigrator<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: db.urls.migrator });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function countAll(client: pg.ClientBase, table: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return rows[0]?.n ?? -1;
}

beforeAll(async () => {
  db = await createTestDatabase(inject('adminUrl'), { fixtures: true });
  // Seeding as the owner works because RLS is enabled, not forced (D-33).
  await asMigrator(async (m) => {
    await m.query(
      `insert into organizations (id, name, timezone, data_region)
       values ($1, 'Org A', 'Asia/Karachi', 'eu-central-1'), ($2, 'Org B', 'Asia/Karachi', 'eu-central-1')`,
      [ORG_A, ORG_B],
    );
    await m.query(
      `insert into fixture_sites (id, organization_id, name) values ($1, $2, 'A gate'), ($3, $4, 'B gate')`,
      [SITE_A, ORG_A, SITE_B, ORG_B],
    );
    for (const [org, site] of [
      [ORG_A, SITE_A],
      [ORG_B, SITE_B],
    ] as const) {
      await m.query(
        `insert into fixture_site_notes (id, organization_id, site_id, body) values ($1, $2, $3, 'note')`,
        [randomUUID(), org, site],
      );
      await m.query(
        `insert into fixture_events (id, organization_id, site_id, kind) values ($1, $2, $3, 'STARTED')`,
        [randomUUID(), org, site],
      );
      // One row per organization in every Phase 1 tenant table (the per-table test requires it).
      const user = randomUUID();
      await m.query(`insert into users (id, email, name) values ($1, $2, 'Member')`, [
        user,
        `${user}@example.test`,
      ]);
      await m.query(
        `insert into organization_members (id, organization_id, user_id, role, status)
         values ($1, $2, $3, 'OWNER', 'ACTIVE')`,
        [randomUUID(), org, user],
      );
      await m.query(
        `insert into invitations (id, organization_id, purpose, role, email, token_hash, expires_at)
         values ($1, $2, 'MEMBER', 'ADMIN', 'invitee@example.test', gen_random_bytes(32), now() + interval '7 days')`,
        [randomUUID(), org],
      );
      await m.query(
        `insert into organization_settings (id, organization_id, overrides) values ($1, $2, '{}')`,
        [randomUUID(), org],
      );
      await m.query(
        `insert into audit_logs (id, organization_id, actor_type, action, resource_type)
         values ($1, $2, 'SYSTEM', 'SETTINGS_CHANGED', 'organization')`,
        [randomUUID(), org],
      );
    }
  });
  runtime = new pg.Pool({ connectionString: db.urls.app_runtime, max: 2 });
});

afterAll(async () => {
  await runtime?.end();
  await db?.drop();
});

describe('row-level security (ARCH §4.3)', () => {
  for (const table of TENANT_TABLES) {
    it(`ADV-T06 with organization A's context, ${table} returns only organization A's rows`, async () => {
      const column = orgColumn(table);
      // Without rows for both organizations "no B rows" would pass with nothing to hide, so a newly
      // registered table fails here until the seed data covers it.
      const seeded = await asMigrator(async (m) => {
        const result = await m.query<{ org: string }>(`select distinct ${column} as org from ${table}`);
        return result.rows.map((r) => r.org).sort();
      });
      expect(seeded, `${table} needs seed rows for both organizations`).toEqual([ORG_A, ORG_B].sort());

      const rows = await withTenant(runtime, ORG_A, async (c) => {
        const result = await c.query<{ org: string }>(`select ${column} as org from ${table}`);
        return result.rows;
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => r.org !== ORG_A)).toEqual([]);
    });
  }

  it('ADV-T06 with no context, every tenant table returns zero rows on a fresh connection', async () => {
    const client = new pg.Client({ connectionString: db.urls.app_runtime });
    await client.connect();
    try {
      for (const table of TENANT_TABLES) expect(await countAll(client, table), table).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('ADV-T06 with no context, a connection that already served a tenant returns zero rows, not an error', async () => {
    const client = new pg.Client({ connectionString: db.urls.app_runtime });
    await client.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.org_id', $1, true)", [ORG_A]);
      expect(await countAll(client, 'fixture_sites')).toBe(1);
      await client.query('commit');

      // The trap from review M-01: the setting now reads '' rather than NULL.
      const { rows } = await client.query<{ v: string | null }>(
        "select current_setting('app.org_id', true) as v",
      );
      expect(rows[0]?.v).toBe('');
      for (const table of TENANT_TABLES) expect(await countAll(client, table), table).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("ADV-T04 INV-13 the database rejects a child row that points at another organization's parent", async () => {
    // Even the owner, who is not filtered by RLS, cannot create the cross-tenant reference.
    await asMigrator(async (m) => {
      await expect(
        m.query(
          `insert into fixture_site_notes (id, organization_id, site_id, body) values ($1, $2, $3, 'x')`,
          [randomUUID(), ORG_A, SITE_B],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });

  // The database half of INV-01; memberships and the request context arrive in Phase 1.
  it('INV-01 RLS also blocks writes: the runtime role cannot insert a row for another organization', async () => {
    await expect(
      withTenant(runtime, ORG_A, (c) =>
        c.query(`insert into fixture_sites (id, organization_id, name) values ($1, $2, 'not mine')`, [
          randomUUID(),
          ORG_B,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('INV-05 the runtime role cannot update or delete append-only rows', async () => {
    await expect(
      withTenant(runtime, ORG_A, (c) => c.query(`update fixture_events set kind = 'CHANGED'`)),
    ).rejects.toThrow(/permission denied/);
    await expect(withTenant(runtime, ORG_A, (c) => c.query('delete from fixture_events'))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('D-33 the table owner is not filtered, so a data migration sees every row', async () => {
    expect(await asMigrator((m) => countAll(m, 'fixture_sites'))).toBe(2);
  });

  it('rejects a tenant context that is not a UUID', async () => {
    await expect(withTenant(runtime, "' or 1=1 --", () => Promise.resolve())).rejects.toThrow(TypeError);
  });
});
