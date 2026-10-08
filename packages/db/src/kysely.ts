// Kysely over the runtime pool (D-10). Repositories use withTenantTransaction(), which sets the
// tenant context inside the same transaction as the queries — the Kysely twin of withTenant().
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import type pg from 'pg';

import type { DB } from './generated/db.ts';

export type { DB };
export type Database = Kysely<DB>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createKysely(pool: pg.Pool): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

export async function withTenantTransaction<T>(
  db: Database,
  organizationId: string,
  work: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  if (!UUID.test(organizationId)) throw new TypeError('organizationId must be a UUID');
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.org_id', ${organizationId}, true)`.execute(trx);
    return work(trx);
  });
}
