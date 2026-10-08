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
      // Phase 2 tables.
      const guard = randomUUID();
      const device = randomUUID();
      const siteRow = randomUUID();
      await m.query(
        `insert into guards (id, organization_id, employee_number, display_name, phone)
         values ($1, $2, 'G-1', 'Guard', $3)`,
        [guard, org, `+9230012345${org === ORG_A ? '01' : '02'}`],
      );
      await m.query(
        `insert into guard_devices (id, organization_id, guard_id, installation_id, public_key, key_algorithm, platform)
         values ($1, $2, $3, $4, gen_random_bytes(91), 'ECDSA_P256_SHA256', 'ANDROID')`,
        [device, org, guard, randomUUID()],
      );
      await m.query(
        `insert into mobile_sessions (id, organization_id, guard_id, device_id, family_id, access_token_hash,
           access_expires_at, refresh_token_hash, expires_at, issued_at)
         values ($1, $2, $3, $4, $5, gen_random_bytes(32), now(), gen_random_bytes(32), now(), now())`,
        [randomUUID(), org, guard, device, randomUUID()],
      );
      await m.query(
        `insert into tracking_consents (id, organization_id, guard_id, device_id, disclosure_version, locale, accepted_at)
         values ($1, $2, $3, $4, '1', 'en', now())`,
        [randomUUID(), org, guard, device],
      );
      await m.query(
        `insert into sites (id, organization_id, name, timezone, boundary_kind, latitude, longitude, geofence_radius_meters)
         values ($1, $2, 'Gate', 'Asia/Karachi', 'CIRCLE', 31.5, 74.3, 100)`,
        [siteRow, org],
      );
      await m.query(
        `insert into checkpoints (id, organization_id, site_id, name, qr_token_hash)
         values ($1, $2, $3, 'North gate', gen_random_bytes(32))`,
        [randomUUID(), org, siteRow],
      );
      // Phase 3 tables.
      const shift = randomUUID();
      await m.query(
        `insert into shifts (id, organization_id, guard_id, site_id, starts_at, ends_at, start_deadline_at)
         values ($1, $2, $3, $4, now(), now() + interval '8 hours', now() + interval '2 hours')`,
        [shift, org, guard, siteRow],
      );
      await m.query(
        `insert into shift_events (id, organization_id, shift_id, type, actor_type, occurred_at)
         values ($1, $2, $3, 'CREATED', 'SYSTEM', now())`,
        [randomUUID(), org, shift],
      );
      // Phase 4 tables.
      await m.query(
        `insert into location_points (id, organization_id, guard_id, shift_id, device_id, client_event_id, latitude,
           longitude, accuracy_m, recorded_at, captured_at, received_at, clock_status, source)
         values ($1, $2, $3, $4, $5, $6, 31.5, 74.3, 10, now(), now(), now(), 'VERIFIED_MONOTONIC', 'TRACKING')`,
        [randomUUID(), org, guard, shift, device, randomUUID()],
      );
      await m.query(
        `insert into device_status_events (id, organization_id, guard_id, device_id, client_event_id, recorded_at,
           received_at, location_permission, precise_location, location_services_enabled, tracking_service_state)
         values ($1, $2, $3, $4, $5, now(), now(), 'ALWAYS', true, true, 'RUNNING')`,
        [randomUUID(), org, guard, device, randomUUID()],
      );
      await m.query(
        `insert into shift_live_state (id, organization_id, guard_id, site_id) values ($1, $2, $3, $4)`,
        [shift, org, guard, siteRow],
      );
      await m.query(
        `insert into quarantined_items (id, organization_id, device_id, batch_id, client_event_id, item, error_code)
         values ($1, $2, $3, $4, 'x', '{}', 'INTERNAL_ERROR')`,
        [randomUUID(), org, device, randomUUID()],
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
