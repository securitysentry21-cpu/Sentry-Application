// Database roles (ARCH §4.3). Roles are cluster-wide, so they are created once per PostgreSQL
// server by an administrator — locally by the test harness, in AWS by the setup in infra/.
import type pg from 'pg';

export const MIGRATOR = 'migrator';
export const RUNTIME_ROLES = ['app_runtime', 'system_worker', 'retention_worker'] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];
export type DbRole = typeof MIGRATOR | RuntimeRole;

/** Local development and test passwords only. Real environments read them from Secrets Manager. */
export const DEV_PASSWORDS: Readonly<Record<DbRole, string>> = {
  migrator: 'migrator-dev-only',
  app_runtime: 'app-runtime-dev-only',
  system_worker: 'system-worker-dev-only',
  retention_worker: 'retention-worker-dev-only',
};

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Creates the four roles if missing and (re)sets their passwords. Needs an administrator connection:
 * a superuser locally, RDS's master user (CREATEROLE, not a superuser) in AWS. Either way it ends by
 * checking that no role is a superuser or bypasses row-level security (D-33).
 */
export async function bootstrapRoles(
  admin: pg.ClientBase,
  passwords: Readonly<Record<DbRole, string>> = DEV_PASSWORDS,
): Promise<void> {
  const roles: DbRole[] = [MIGRATOR, ...RUNTIME_ROLES];
  const { rows } = await admin.query<{ rolsuper: boolean }>(
    'select rolsuper from pg_roles where rolname = current_user',
  );
  const superuser = rows[0]?.rolsuper === true;
  for (const role of roles) {
    // Concurrent bootstraps may race; a duplicate is fine.
    await admin.query(`
      do $$ begin
        create role ${quoteIdent(role)} login nosuperuser nobypassrls nocreatedb nocreaterole;
      exception when duplicate_object then null;
      end $$`);
    // Only a superuser may name SUPERUSER or BYPASSRLS in ALTER ROLE, even to clear them, so RDS's
    // administrator sets the password alone; the check below covers both cases.
    const clear = superuser ? 'nosuperuser nobypassrls ' : '';
    await admin.query(
      `alter role ${quoteIdent(role)} login ${clear}password ${quoteLiteral(passwords[role])}`,
    );
  }
  const unsafe = await admin.query<{ rolname: string }>(
    'select rolname from pg_roles where rolname = any($1) and (rolsuper or rolbypassrls) order by rolname',
    [roles],
  );
  if (unsafe.rowCount) {
    throw new Error(`refusing: superuser or BYPASSRLS on ${unsafe.rows.map((r) => r.rolname).join(', ')}`);
  }
}

/**
 * Creates a UTF-8 database owned by `migrator` that only the runtime roles may connect to. UTF-8 is
 * explicit because a cluster's default can be a single-byte Windows encoding that can't hold Urdu.
 */
export async function createDatabase(admin: pg.ClientBase, name: string): Promise<void> {
  await admin.query(
    `create database ${quoteIdent(name)} owner ${MIGRATOR} encoding 'UTF8' template template0`,
  );
  await admin.query(`revoke all on database ${quoteIdent(name)} from public`);
  await admin.query(
    `grant connect on database ${quoteIdent(name)} to ${MIGRATOR}, ${RUNTIME_ROLES.join(', ')}`,
  );
}

export async function dropDatabase(admin: pg.ClientBase, name: string): Promise<void> {
  await admin.query(`drop database if exists ${quoteIdent(name)} with (force)`);
}

/** The URL for `role` on database `database`, derived from an administrator URL. */
export function roleUrl(
  adminUrl: string,
  database: string,
  role: DbRole,
  passwords: Readonly<Record<DbRole, string>> = DEV_PASSWORDS,
): string {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = passwords[role];
  url.pathname = `/${database}`;
  return url.toString();
}
