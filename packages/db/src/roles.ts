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

/** Creates the four roles if missing and (re)sets their passwords. Needs an administrator connection. */
export async function bootstrapRoles(
  admin: pg.ClientBase,
  passwords: Readonly<Record<DbRole, string>> = DEV_PASSWORDS,
): Promise<void> {
  for (const role of [MIGRATOR, ...RUNTIME_ROLES] as DbRole[]) {
    // Concurrent bootstraps may race; a duplicate is fine.
    await admin.query(`
      do $$ begin
        create role ${quoteIdent(role)} login nosuperuser nobypassrls nocreatedb nocreaterole;
      exception when duplicate_object then null;
      end $$`);
    await admin.query(
      `alter role ${quoteIdent(role)} login nosuperuser nobypassrls password ${quoteLiteral(passwords[role])}`,
    );
  }
}

/** Creates a database owned by `migrator` that only the runtime roles may connect to. */
export async function createDatabase(admin: pg.ClientBase, name: string): Promise<void> {
  await admin.query(`create database ${quoteIdent(name)} owner ${MIGRATOR}`);
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
