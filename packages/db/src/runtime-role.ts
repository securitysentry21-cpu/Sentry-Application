// Startup role check (D-33, ADV-X07). The API and workers call this before serving anything and
// refuse to start unless they are connected as a runtime role that cannot bypass RLS: not the
// table owner, not a superuser, no BYPASSRLS. This is what FORCE RLS would otherwise guard:
// a misconfigured DATABASE_URL.
import type pg from 'pg';

import { RUNTIME_ROLES, type RuntimeRole } from './roles.ts';

export class RuntimeRoleError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`refusing to start: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

export async function verifyRuntimeRole(
  db: pg.ClientBase | pg.Pool,
  allowed: readonly RuntimeRole[] = RUNTIME_ROLES,
): Promise<RuntimeRole> {
  const { rows } = await db.query<{ name: string; superuser: boolean; bypassrls: boolean; owned: number }>(`
    select r.rolname as name, r.rolsuper as superuser, r.rolbypassrls as bypassrls,
           (select count(*)::int
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relowner = r.oid
               and n.nspname not in ('pg_catalog', 'information_schema')
               and n.nspname not like 'pg_toast%') as owned
      from pg_roles r
     where r.rolname = current_user`);
  const me = rows[0];
  if (!me) throw new RuntimeRoleError(['current_user not found in pg_roles']);

  const problems: string[] = [];
  if (!(allowed as readonly string[]).includes(me.name)) {
    problems.push(`connected as "${me.name}", expected one of ${allowed.join(', ')}`);
  }
  if (me.superuser) problems.push(`"${me.name}" is a superuser`);
  if (me.bypassrls) problems.push(`"${me.name}" has BYPASSRLS`);
  if (me.owned > 0) problems.push(`"${me.name}" owns ${me.owned} relation(s)`);
  if (problems.length > 0) throw new RuntimeRoleError(problems);
  return me.name as RuntimeRole;
}
