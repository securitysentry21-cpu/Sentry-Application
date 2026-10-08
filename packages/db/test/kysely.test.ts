import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { createKysely, withTenantTransaction, type Database } from '../src/kysely.ts';
import { createTestDatabase, type TestDatabase } from '../test-support/index.ts';

const ORG_A = randomUUID();
const ORG_B = randomUUID();
let db: TestDatabase;
let pool: pg.Pool;
let kysely: Database;

beforeAll(async () => {
  db = await createTestDatabase(inject('adminUrl'));
  const m = new pg.Client({ connectionString: db.urls.migrator });
  await m.connect();
  await m.query(
    `insert into organizations (id, name, timezone, data_region)
     values ($1, 'Org A', 'Asia/Karachi', 'eu-central-1'), ($2, 'Org B', 'Asia/Karachi', 'eu-central-1')`,
    [ORG_A, ORG_B],
  );
  await m.end();
  pool = new pg.Pool({ connectionString: db.urls.app_runtime, max: 2 });
  kysely = createKysely(pool);
});

afterAll(async () => {
  await kysely?.destroy(); // also ends the pool
  await db?.drop();
});

it('ADV-T06 a Kysely tenant transaction sees only its own organization', async () => {
  const rows = await withTenantTransaction(kysely, ORG_A, (trx) =>
    trx.selectFrom('organizations').select(['id', 'name']).execute(),
  );
  expect(rows).toEqual([{ id: ORG_A, name: 'Org A' }]);
});

it('ADV-T06 Kysely queries outside a tenant transaction see nothing', async () => {
  expect(await kysely.selectFrom('organizations').selectAll().execute()).toEqual([]);
});
