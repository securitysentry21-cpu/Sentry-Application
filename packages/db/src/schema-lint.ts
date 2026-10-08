// Schema linter (ADV-X01): turns SEC §19's catalog checks into a CI gate. It reads the live catalog
// and reports every way the schema breaks the tenancy rules. An empty result means clean.
import type pg from 'pg';

import { isTenantKind, type TableRegistry } from './registry.ts';
import { MIGRATOR, RUNTIME_ROLES } from './roles.ts';

const TENANT_CONTEXT = 'app.current_org_id()';

type Table = { oid: number; schema: string; name: string; rls: boolean; forced: boolean; owner: string };

export async function lintSchema(db: pg.ClientBase, registry: TableRegistry): Promise<string[]> {
  const problems: string[] = [];
  const { rows: tables } = await db.query<Table>(`
    select c.oid::int as oid, n.nspname as schema, c.relname as name,
           c.relrowsecurity as rls, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner) as owner
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and n.nspname not in ('pg_catalog', 'information_schema')
       and n.nspname not like 'pg_toast%'
     order by n.nspname, c.relname`);

  const kindOf = (name: string) => registry[name]?.kind;

  for (const t of tables) {
    const entry = registry[t.name];
    const label = `${t.schema}.${t.name}`;
    if (t.schema !== 'public') {
      problems.push(`${label}: tables belong in schema public`);
      continue;
    }
    if (!entry) {
      problems.push(`${label}: not classified in the table registry`);
      continue;
    }
    if (t.owner !== MIGRATOR) problems.push(`${label}: owned by ${t.owner}, expected ${MIGRATOR}`);
    if (t.forced) problems.push(`${label}: RLS is forced; V1 uses ENABLE, not FORCE (D-33)`);

    if (entry.kind === 'global' || entry.kind === 'internal') {
      if (!entry.reason) problems.push(`${label}: ${entry.kind} tables need a recorded reason`);
      if (entry.kind === 'internal') {
        for (const role of RUNTIME_ROLES) {
          for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const) {
            if (await hasPrivilege(db, role, t.oid, privilege)) {
              problems.push(`${label}: ${role} must not have ${privilege} on an internal table`);
            }
          }
        }
      }
      continue;
    }

    // Tenant tables.
    if (!t.rls) problems.push(`${label}: row-level security is not enabled`);

    const policies = await db.query<{
      name: string;
      roles: string[];
      qual: string | null;
      check: string | null;
    }>(
      `select policyname as name, roles::text[] as roles, qual, with_check as check
         from pg_policies where schemaname = $1 and tablename = $2`,
      [t.schema, t.name],
    );
    const runtimePolicies = policies.rows.filter(
      (p) => p.roles.includes('app_runtime') || p.roles.includes('public'),
    );
    if (runtimePolicies.length === 0) problems.push(`${label}: no RLS policy applies to app_runtime`);
    for (const p of runtimePolicies) {
      const text = `${p.qual ?? ''} ${p.check ?? ''}`;
      if (!text.includes(TENANT_CONTEXT)) {
        problems.push(`${label}: policy ${p.name} does not read the tenant context via ${TENANT_CONTEXT}`);
      }
    }

    if (entry.kind === 'tenant-root') continue;

    const columns = await db.query<{ name: string; notnull: boolean; type: string }>(
      `select attname as name, attnotnull as notnull, format_type(atttypid, atttypmod) as type
         from pg_attribute where attrelid = $1 and attnum > 0 and not attisdropped`,
      [t.oid],
    );
    const org = columns.rows.find((c) => c.name === 'organization_id');
    if (!org) problems.push(`${label}: missing organization_id`);
    else {
      if (!org.notnull) problems.push(`${label}: organization_id must be NOT NULL (INV-13)`);
      if (org.type !== 'uuid') problems.push(`${label}: organization_id must be uuid, is ${org.type}`);
    }

    const uniques = await db.query<{ cols: string[] }>(
      `select array(select a.attname::text from unnest(i.indkey) k
                      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k) as cols
         from pg_index i where i.indrelid = $1 and i.indisunique`,
      [t.oid],
    );
    const hasCompositeKey = uniques.rows.some(
      (u) => u.cols.length === 2 && u.cols.includes('organization_id') && u.cols.includes('id'),
    );
    if (!hasCompositeKey) problems.push(`${label}: missing UNIQUE (organization_id, id) (ARCH §4.4)`);

    const fks = await db.query<{ name: string; target: string; cols: string[] }>(
      `select con.conname as name, rel.relname as target,
              array(select a.attname::text from unnest(con.conkey) k
                      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k) as cols
         from pg_constraint con join pg_class rel on rel.oid = con.confrelid
        where con.conrelid = $1 and con.contype = 'f'`,
      [t.oid],
    );
    for (const fk of fks.rows) {
      const targetKind = kindOf(fk.target);
      if (targetKind && isTenantKind(targetKind) && !fk.cols.includes('organization_id')) {
        problems.push(
          `${label}: foreign key ${fk.name} to ${fk.target} must include organization_id (INV-13)`,
        );
      }
    }

    if (entry.kind === 'tenant-append-only') {
      for (const role of RUNTIME_ROLES) {
        for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
          // retention_worker deletes by design (SEC §16.5); everyone else only inserts and reads.
          if (role === 'retention_worker' && privilege === 'DELETE') continue;
          if (await hasPrivilege(db, role, t.oid, privilege)) {
            problems.push(`${label}: ${role} has ${privilege} on an append-only table (INV-05)`);
          }
        }
      }
    }
  }

  for (const name of Object.keys(registry)) {
    if (!tables.some((t) => t.name === name))
      problems.push(`registry lists ${name}, but the table does not exist`);
  }

  const roles = await db.query<{ name: string; superuser: boolean; bypassrls: boolean; owned: number }>(
    `select r.rolname as name, r.rolsuper as superuser, r.rolbypassrls as bypassrls,
            (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relowner = r.oid and n.nspname not in ('pg_catalog', 'information_schema')
                and n.nspname not like 'pg_toast%') as owned
       from pg_roles r where r.rolname = any($1)`,
    [[...RUNTIME_ROLES]],
  );
  for (const r of roles.rows) {
    if (r.superuser) problems.push(`role ${r.name} must not be a superuser`);
    if (r.bypassrls) problems.push(`role ${r.name} must not have BYPASSRLS`);
    if (r.owned > 0) problems.push(`role ${r.name} must not own relations (owns ${r.owned})`);
  }
  return problems;
}

async function hasPrivilege(
  db: pg.ClientBase,
  role: string,
  oid: number,
  privilege: string,
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>('select has_table_privilege($1, $2::oid, $3) as ok', [
    role,
    oid,
    privilege,
  ]);
  return rows[0]?.ok === true;
}
