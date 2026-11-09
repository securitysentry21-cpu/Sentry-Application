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
let retention: pg.Pool;

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
      const member = randomUUID();
      await m.query(`insert into users (id, email, name) values ($1, $2, 'Member')`, [
        user,
        `${user}@example.test`,
      ]);
      await m.query(
        `insert into organization_members (id, organization_id, user_id, role, status)
         values ($1, $2, $3, 'OWNER', 'ACTIVE')`,
        [member, org, user],
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
      const checkpoint = randomUUID();
      await m.query(
        `insert into checkpoints (id, organization_id, site_id, name, qr_token_hash)
         values ($1, $2, $3, 'North gate', gen_random_bytes(32))`,
        [checkpoint, org, siteRow],
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
      // Phase 5 tables.
      const alert = randomUUID();
      await m.query(
        `insert into alerts (id, organization_id, type, severity, dedupe_key, summary, guard_id, site_id, shift_id,
           opened_at, last_triggered_at)
         values ($1, $2, 'DEVICE_OFFLINE', 'MEDIUM', $3, 'Device offline', $4, $5, $6, now(), now())`,
        [alert, org, `offline:${shift}`, guard, siteRow, shift],
      );
      await m.query(
        `insert into alert_events (id, organization_id, alert_id, type, actor_type) values ($1, $2, $3, 'OPENED', 'SYSTEM')`,
        [randomUUID(), org, alert],
      );
      // Phase 6 tables.
      await m.query(
        `insert into outbox (id, organization_id, topic, payload) values ($1, $2, 'alert.opened', $3)`,
        [randomUUID(), org, JSON.stringify({ alertId: alert })],
      );
      await m.query(
        `insert into realtime_events (id, organization_id, seq, type, payload) values ($1, $2, 1, 'alert.opened', $3)`,
        [randomUUID(), org, JSON.stringify({ alertId: alert })],
      );
      await m.query(
        `insert into stream_connections (id, organization_id, user_id, client, instance_id, connected_at, last_seen_at)
         values ($1, $2, $3, 'DESKTOP', 'test', now(), now())`,
        [randomUUID(), org, user],
      );
      // Phase 7 tables.
      const route = randomUUID();
      const run = randomUUID();
      await m.query(
        `insert into patrol_routes (id, organization_id, site_id, name, interval_minutes, completion_window_minutes)
         values ($1, $2, $3, 'Night round', 60, 20)`,
        [route, org, siteRow],
      );
      await m.query(
        `insert into patrol_route_checkpoints (id, organization_id, site_id, patrol_route_id, checkpoint_id, sequence)
         values ($1, $2, $3, $4, $5, 1)`,
        [randomUUID(), org, siteRow, route, checkpoint],
      );
      await m.query(
        `insert into patrol_runs (id, organization_id, shift_id, guard_id, site_id, patrol_route_id, sequence_no,
           due_at, window_ends_at, required_count)
         values ($1, $2, $3, $4, $5, $6, 1, now(), now() + interval '20 minutes', 1)`,
        [run, org, shift, guard, siteRow, route],
      );
      await m.query(
        `insert into checkpoint_retired_labels (id, organization_id, checkpoint_id, qr_token_hash, qr_token_version,
           retired_at)
         values ($1, $2, $3, gen_random_bytes(32), 1, now())`,
        [randomUUID(), org, checkpoint],
      );
      await m.query(
        `insert into checkpoint_visits (id, organization_id, guard_id, shift_id, checkpoint_id, patrol_route_id,
           patrol_run_id, device_id, client_event_id, scanned_at_recorded, scanned_at, received_at, clock_status,
           verification_status, counted)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), now(), 'VERIFIED_MONOTONIC',
           'LOCATION_UNCONFIRMED', true)`,
        [randomUUID(), org, guard, shift, checkpoint, route, run, device, randomUUID()],
      );
      // Phase 8 tables.
      const drill = randomUUID();
      const sos = randomUUID();
      const incident = randomUUID();
      const subscription = randomUUID();
      await m.query(
        `insert into sos_drills (id, organization_id, started_by_user_id, started_at, ends_at)
         values ($1, $2, $3, now(), now() + interval '1 hour')`,
        [drill, org, user],
      );
      await m.query(
        `insert into sos_drill_guards (id, organization_id, drill_id, guard_id) values ($1, $2, $3, $4)`,
        [randomUUID(), org, drill, guard],
      );
      await m.query(
        `insert into sos_drill_members (id, organization_id, drill_id, member_id) values ($1, $2, $3, $4)`,
        [randomUUID(), org, drill, member],
      );
      await m.query(
        `insert into sos_events (id, organization_id, guard_id, shift_id, site_id, device_id, client_event_id,
           activated_at_recorded, activated_at, received_at, clock_status, last_triggered_at, is_drill, drill_id)
         values ($1, $2, $3, $4, $5, $6, $7, now(), now(), now(), 'VERIFIED_MONOTONIC', now(), true, $8)`,
        [sos, org, guard, shift, siteRow, device, randomUUID(), drill],
      );
      await m.query(
        `insert into sos_presses (id, organization_id, sos_event_id, guard_id, device_id, client_event_id,
           pressed_at_recorded, pressed_at, received_at, auth)
         values ($1, $2, $3, $4, $5, $6, now(), now(), now(), 'SESSION')`,
        [randomUUID(), org, sos, guard, device, randomUUID()],
      );
      await m.query(`insert into incident_counters (id, organization_id, next_value) values ($1, $2, 2)`, [
        randomUUID(),
        org,
      ]);
      await m.query(
        `insert into incidents (id, organization_id, reference_number, guard_id, shift_id, site_id, type, severity,
           title, occurred_at, reported_at, received_at)
         values ($1, $2, 1, $3, $4, $5, 'FIRE', 'HIGH', 'Fire', now(), now(), now())`,
        [incident, org, guard, shift, siteRow],
      );
      await m.query(
        `insert into incident_events (id, organization_id, incident_id, type, actor_type, actor_guard_id)
         values ($1, $2, $3, 'CREATED', 'GUARD', $4)`,
        [randomUUID(), org, incident, guard],
      );
      await m.query(
        `insert into incident_attachments (id, organization_id, incident_id, client_event_id, capture_source,
           declared_type, declared_size, original_key, view_key, upload_expires_at)
         values ($1, $2, $3, $4, 'IN_APP_CAMERA', 'image/jpeg', 1000, 'o', 'v', now())`,
        [randomUUID(), org, incident, randomUUID()],
      );
      await m.query(
        `insert into web_push_subscriptions (id, organization_id, member_id, user_id, endpoint, p256dh, auth, client)
         values ($1, $2, $3, $4, $5, repeat('B', 87), repeat('A', 22), 'PHONE')`,
        [subscription, org, member, user, `https://fcm.googleapis.com/fcm/send/${subscription}`],
      );
      await m.query(
        `insert into notification_deliveries (id, organization_id, topic, alert_id, channel, recipient_member_id,
           subscription_id, dedupe_key, max_attempts, next_attempt_at, title, body)
         values ($1, $2, 'ALERT', $3, 'WEB_PUSH', $4, $5, $6, 3, now(), 'SOS', 'SOS — Guard — Gate')`,
        [randomUUID(), org, alert, member, subscription, `${alert}:${member}:WEB_PUSH:0`],
      );
      // Phase 9.
      await m.query(
        `insert into export_jobs (id, organization_id, requested_by, kind, params, title, contains_location, created_at)
         values ($1, $2, $3, 'ATTENDANCE', '{}', 'Attendance', false, now())`,
        [randomUUID(), org, user],
      );
    }
  });
  runtime = new pg.Pool({ connectionString: db.urls.app_runtime, max: 2 });
  retention = new pg.Pool({ connectionString: db.urls.retention_worker, max: 2 });
});

afterAll(async () => {
  await runtime?.end();
  await retention?.end();
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

  // Review L-09, ARCH §4.3 "every role against every tenant table": retention_worker deletes, one
  // organization at a time, so with A's context it must see A's rows or none (no grant).
  for (const table of TENANT_TABLES) {
    it(`ADV-T06 as retention_worker with organization A's context, ${table} shows only A's rows or none`, async () => {
      const column = orgColumn(table);
      const rows = await withTenant(retention, ORG_A, async (c) => {
        await c.query('savepoint probe');
        try {
          return (await c.query<{ org: string }>(`select ${column} as org from ${table}`)).rows;
        } catch (error) {
          if (!/permission denied/.test(String(error))) throw error;
          await c.query('rollback to savepoint probe');
          return [];
        }
      });
      expect(rows.filter((r) => r.org !== ORG_A)).toEqual([]);
    });
  }

  it('ADV-T06 every policy retention_worker is under on a tenant table reads the organization in context', async () => {
    const policies = await asMigrator(async (m) => {
      const result = await m.query<{
        name: string;
        table: string;
        qual: string | null;
        check: string | null;
      }>(
        `select policyname as name, tablename as "table", qual, with_check as check from pg_policies
          where schemaname = 'public' and roles::text[] && array['retention_worker', 'public']`,
      );
      return result.rows.filter((p) => TENANT_TABLES.includes(p.table));
    });
    expect(policies.length).toBeGreaterThan(10);
    const scoped = (expression: string | null) =>
      expression === null || expression.includes('current_org_id()');
    const unscoped = policies.filter(
      (p) => !scoped(p.qual) || !scoped(p.check) || (p.qual ?? p.check) === null,
    );
    expect(unscoped.map((p) => `${p.table}.${p.name}`)).toEqual([]);
  });

  it('ADV-T06 system_worker only reads, and only the sweep columns its migrations granted', async () => {
    // Each sweep and why it exists is in its migration; a new grant fails here until it is listed.
    const SWEEPS: Record<string, string[]> = {
      alerts: ['next_escalation_at', 'organization_id', 'status'],
      export_jobs: ['created_at', 'expires_at', 'organization_id', 'started_at', 'status'],
      incident_attachments: ['organization_id', 'status'],
      notification_deliveries: ['next_attempt_at', 'organization_id', 'status'],
      organizations: ['id', 'timezone'],
      outbox: ['organization_id', 'processed_at'],
      patrol_runs: ['organization_id', 'status', 'window_ends_at'],
      shifts: ['ends_at', 'id', 'organization_id', 'start_deadline_at', 'starts_at', 'status'],
      sos_events: ['is_drill', 'organization_id', 'received_at', 'status'],
      stream_connections: ['last_seen_at', 'organization_id'],
    };
    const { readable, writable, policies } = await asMigrator(async (m) => {
      const columns = await m.query<{ table: string; column: string }>(
        `select table_name as "table", column_name as "column" from information_schema.columns
          where table_schema = 'public' and table_name = any($1)
            and has_column_privilege('system_worker', format('public.%I', table_name), column_name, 'SELECT')
          order by 1, 2`,
        [TENANT_TABLES],
      );
      const writes = await m.query<{ table: string }>(
        `select t as "table" from unnest($1::text[]) t
          where has_table_privilege('system_worker', format('public.%I', t), 'INSERT, UPDATE, DELETE, TRUNCATE')
             or has_any_column_privilege('system_worker', format('public.%I', t), 'INSERT, UPDATE')`,
        [TENANT_TABLES],
      );
      const swept = await m.query<{ name: string; table: string; cmd: string }>(
        `select policyname as name, tablename as "table", cmd from pg_policies
          where schemaname = 'public' and roles::text[] && array['system_worker']`,
      );
      return { readable: columns.rows, writable: writes.rows, policies: swept.rows };
    });
    const granted: Record<string, string[]> = {};
    for (const { table, column } of readable) (granted[table] ??= []).push(column);
    expect(granted).toEqual(SWEEPS);
    expect(writable).toEqual([]);
    expect(policies.length).toBeGreaterThan(0);
    expect(policies.filter((p) => p.cmd !== 'SELECT').map((p) => `${p.table}.${p.name}`)).toEqual([]);
  });

  it('INV-04 every table holding a position is a tenant table, so the read test above covers it', async () => {
    const located = await asMigrator(async (m) => {
      const result = await m.query<{ table_name: string }>(
        `select distinct table_name from information_schema.columns
          where table_schema = 'public' and (column_name like '%latitude' or column_name = 'polygon')`,
      );
      return result.rows.map((r) => r.table_name).sort();
    });
    expect(located.length).toBeGreaterThan(0);
    expect(located.filter((table) => !TENANT_TABLES.includes(table))).toEqual([]);
  });

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
