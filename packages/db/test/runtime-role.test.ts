import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { RuntimeRoleError, verifyRuntimeRole } from '../src/runtime-role.ts';
import { createTestDatabase, type TestDatabase } from '../test-support/index.ts';

let db: TestDatabase;

async function check(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await verifyRuntimeRole(client);
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

describe('startup role check (D-33)', () => {
  it('ADV-X07 accepts app_runtime', async () => {
    await expect(check(db.urls.app_runtime)).resolves.toBe('app_runtime');
  });

  it('ADV-X07 refuses the table owner', async () => {
    await expect(check(db.urls.migrator)).rejects.toThrow(RuntimeRoleError);
    await expect(check(db.urls.migrator)).rejects.toThrow(/owns \d+ relation/);
  });

  it('ADV-X07 refuses a superuser', async () => {
    await expect(check(db.urls.admin)).rejects.toThrow(/superuser/);
  });

  it('ADV-X07 refuses a role with BYPASSRLS', async () => {
    const role = `bypass_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const admin = new pg.Client({ connectionString: db.urls.admin });
    await admin.connect();
    try {
      await admin.query(`create role ${role} login bypassrls password 'probe'`);
      await admin.query(`grant connect on database ${db.name} to ${role}`);
      const url = new URL(db.urls.admin);
      url.username = role;
      url.password = 'probe';
      await expect(check(url.toString())).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await admin.query(`revoke connect on database ${db.name} from ${role}`);
      await admin.query(`drop role if exists ${role}`);
      await admin.end();
    }
  });
});
