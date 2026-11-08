// The check of a database restored from a backup (ARCH §19.6), shared by scripts/restore-check.ts
// and its test. Read-only: unlike deploy.ts it repairs nothing, so whatever the copy lost is reported.
//   1. as migrator: every migration on disk is recorded, with the same checksum; the schema linter
//      (ADV-X01) finds nothing; every registered table's rows are counted;
//   2. as each runtime role: the startup role check (D-33, ADV-X07).
import type pg from 'pg';

import { loadMigrations } from './migrate.ts';
import { TABLES, type TableRegistry } from './registry.ts';
import { MIGRATOR, RUNTIME_ROLES, type DbRole } from './roles.ts';
import { verifyRuntimeRole } from './runtime-role.ts';
import { lintSchema } from './schema-lint.ts';

export type RestoreCheck = {
  readonly problems: readonly string[];
  readonly latestMigration: string | null;
  /** Rows in each registered table. */
  readonly rows: Readonly<Record<string, number>>;
};

async function inspectAsOwner(owner: pg.Client, registry: TableRegistry): Promise<RestoreCheck> {
  const problems: string[] = [];
  const { rows: applied } = await owner.query<{ version: string; checksum: string }>(
    'select version, checksum from schema_migrations order by version',
  );
  const recorded = new Map(applied.map((m) => [m.version, m.checksum]));
  for (const m of await loadMigrations()) {
    const checksum = recorded.get(m.version);
    if (checksum === undefined) problems.push(`migration ${m.version} is not applied`);
    else if (checksum !== m.checksum) problems.push(`migration ${m.version} differs from its file`);
  }
  problems.push(...(await lintSchema(owner, registry)));

  const rows: Record<string, number> = {};
  for (const table of Object.keys(registry).sort()) {
    const { rows: counted } = await owner.query<{ n: string }>(
      `select count(*) as n from ${owner.escapeIdentifier(table)}`,
    );
    rows[table] = Number(counted[0]?.n ?? 0);
  }
  return { problems, latestMigration: applied.at(-1)?.version ?? null, rows };
}

/** `connect` opens a connection as the given role; the check closes it. */
export async function checkRestoredDatabase(
  connect: (role: DbRole) => Promise<pg.Client>,
  registry: TableRegistry = TABLES,
): Promise<RestoreCheck> {
  const owner = await connect(MIGRATOR);
  const found = await inspectAsOwner(owner, registry).finally(() => owner.end());
  const problems = [...found.problems];
  for (const role of RUNTIME_ROLES) {
    try {
      const client = await connect(role);
      await verifyRuntimeRole(client, [role]).finally(() => client.end());
    } catch (error) {
      problems.push(`${role}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ...found, problems };
}
