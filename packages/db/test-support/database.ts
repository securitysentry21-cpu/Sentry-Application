// A fresh database per test file: created by the administrator, owned by migrator, migrated, and
// optionally loaded with the RLS fixture tables. NEGATIVE_CONTROL deliberately breaks one
// mechanism so scripts/negative-controls.ts can prove the matching test turns red (ADV-X02).
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';

import { migrate } from '../src/migrate.ts';
import type { TableRegistry } from '../src/registry.ts';
import { TABLES } from '../src/registry.ts';
import { createDatabase, dropDatabase, MIGRATOR, roleUrl, RUNTIME_ROLES, type DbRole } from '../src/roles.ts';

export const FIXTURE_REGISTRY: TableRegistry = {
  ...TABLES,
  fixture_sites: { kind: 'tenant' },
  fixture_site_notes: { kind: 'tenant' },
  fixture_events: { kind: 'tenant-append-only' },
};

export type TestDatabase = {
  readonly name: string;
  readonly urls: Readonly<Record<DbRole | 'admin', string>>;
  drop: () => Promise<void>;
};

export async function createTestDatabase(
  adminUrl: string,
  options: { fixtures?: boolean } = {},
): Promise<TestDatabase> {
  const name = `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await createDatabase(admin, name);
  } finally {
    await admin.end();
  }

  const adminDbUrl = new URL(adminUrl);
  adminDbUrl.pathname = `/${name}`;
  const urls = {
    admin: adminDbUrl.toString(),
    migrator: roleUrl(adminUrl, name, MIGRATOR),
    ...Object.fromEntries(RUNTIME_ROLES.map((role) => [role, roleUrl(adminUrl, name, role)])),
  } as Record<DbRole | 'admin', string>;

  const migrator = new pg.Client({ connectionString: urls.migrator });
  await migrator.connect();
  try {
    await migrate(migrator);
    if (options.fixtures) {
      await migrator.query(await readFile(new URL('./fixtures.sql', import.meta.url), 'utf8'));
      await applyNegativeControl(migrator);
    }
  } finally {
    await migrator.end();
  }

  return {
    name,
    urls,
    drop: async () => {
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      try {
        await dropDatabase(a, name);
      } finally {
        await a.end();
      }
    },
  };
}

async function applyNegativeControl(migrator: pg.Client): Promise<void> {
  switch (process.env.NEGATIVE_CONTROL) {
    case 'rls-disabled':
      await migrator.query('alter table fixture_sites disable row level security');
      break;
    case 'append-only-update-granted':
      await migrator.query('grant update on fixture_events to app_runtime');
      break;
    default:
      break;
  }
}
