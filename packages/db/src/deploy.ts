// Cloud database setup (ARCH §4.3, §19.8), shared by scripts/deploy-db.ts and its test. Idempotent:
//   1. as the administrator: the four roles (no superuser, no BYPASSRLS) with the given passwords,
//      and the UTF-8 database owned by migrator;
//   2. as migrator: pending migrations.
// The administrator need not be a superuser (RDS's master user isn't): CREATEROLE, CREATEDB and
// ADMIN OPTION on the roles it created are enough.
import pg from 'pg';

import { migrate } from './migrate.ts';
import { bootstrapRoles, createDatabase, MIGRATOR, type DbRole } from './roles.ts';

export type DeployConnection = Omit<pg.ClientConfig, 'database' | 'user' | 'password' | 'connectionString'>;

export async function deployDatabase(input: {
  readonly connection: DeployConnection;
  readonly admin: { readonly user: string; readonly password: string; readonly database?: string };
  readonly database: string;
  readonly passwords: Readonly<Record<DbRole, string>>;
}): Promise<{ createdDatabase: boolean; applied: string[] }> {
  const admin = new pg.Client({
    ...input.connection,
    database: input.admin.database ?? 'postgres',
    user: input.admin.user,
    password: input.admin.password,
  });
  await admin.connect();
  let createdDatabase = false;
  try {
    await bootstrapRoles(admin, input.passwords);
    const exists = await admin.query('select 1 from pg_database where datname = $1', [input.database]);
    if (exists.rowCount === 0) {
      // A non-superuser may create a database owned by migrator only as a member of that role
      // (PostgreSQL 16+); it holds ADMIN OPTION on the roles it created, so it may grant itself that.
      await admin.query(`grant ${MIGRATOR} to current_user`);
      await createDatabase(admin, input.database);
      createdDatabase = true;
    }
  } finally {
    await admin.end();
  }

  const migrator = new pg.Client({
    ...input.connection,
    database: input.database,
    user: MIGRATOR,
    password: input.passwords.migrator,
  });
  await migrator.connect();
  try {
    return { createdDatabase, applied: await migrate(migrator) };
  } finally {
    await migrator.end();
  }
}
