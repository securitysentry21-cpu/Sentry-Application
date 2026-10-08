// Mermaid ERD generated from the live catalog (ARCH §6.6). docs/generated/erd.md is checked
// against it in CI, so the diagram can never describe a superseded schema.
import type pg from 'pg';

export async function generateErd(db: pg.ClientBase): Promise<string> {
  const { rows: columns } = await db.query<{ table: string; column: string; type: string; pk: boolean }>(`
    select c.relname as "table", a.attname as "column", format_type(a.atttypid, a.atttypmod) as type,
           exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)) as pk
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where c.relkind in ('r', 'p') and n.nspname = 'public'
     order by c.relname, a.attnum`);
  const { rows: fks } = await db.query<{ child: string; parent: string; name: string }>(`
    select child.relname as child, parent.relname as parent, con.conname as name
      from pg_constraint con
      join pg_class child on child.oid = con.conrelid
      join pg_class parent on parent.oid = con.confrelid
      join pg_namespace n on n.oid = child.relnamespace
     where con.contype = 'f' and n.nspname = 'public'
     order by child.relname, con.conname`);

  const lines = ['erDiagram'];
  let current = '';
  for (const c of columns) {
    if (c.table !== current) {
      if (current) lines.push('  }');
      lines.push(`  ${c.table} {`);
      current = c.table;
    }
    const type = c.type.replace(/[^a-zA-Z0-9_]/g, '_');
    lines.push(`    ${type} ${c.column}${c.pk ? ' PK' : ''}`);
  }
  if (current) lines.push('  }');
  for (const fk of fks) lines.push(`  ${fk.parent} ||--o{ ${fk.child} : "${fk.name}"`);

  return [
    '# Entity-relationship diagram',
    '',
    'Generated from the migrated schema by `packages/db/src/erd.ts`; do not edit by hand.',
    'Regenerate with `UPDATE_GENERATED=1 pnpm test --project db`.',
    '',
    '```mermaid',
    ...lines,
    '```',
    '',
  ].join('\n');
}
