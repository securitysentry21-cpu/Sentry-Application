// Plain SQL migrations (D-10), applied in file order, each in its own transaction, recorded with a
// checksum. An applied migration must never change: the runner refuses if one has.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import type pg from 'pg';

import { MIGRATOR } from './roles.ts';

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export type Migration = { version: string; sql: string; checksum: string };

export async function loadMigrations(dir: URL = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(new URL(file, dir), 'utf8');
      return {
        version: file.replace(/\.sql$/, ''),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

export async function latestMigrationVersion(dir: URL = MIGRATIONS_DIR): Promise<string | null> {
  return (await loadMigrations(dir)).at(-1)?.version ?? null;
}

export class MigrationError extends Error {}

/** Applies pending migrations. Returns the versions it applied. */
export async function migrate(client: pg.ClientBase, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  const { rows: who } = await client.query<{ user: string }>('select current_user as "user"');
  if (who[0]?.user !== MIGRATOR) {
    throw new MigrationError(`migrations must run as ${MIGRATOR} (the table owner), not ${who[0]?.user}`);
  }

  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
  const { rows } = await client.query<{ version: string; checksum: string }>(
    'select version, checksum from schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));
  const migrations = await loadMigrations(dir);
  const known = new Set(migrations.map((m) => m.version));

  for (const version of applied.keys()) {
    if (!known.has(version)) throw new MigrationError(`applied migration ${version} is missing from disk`);
  }
  for (const m of migrations) {
    const checksum = applied.get(m.version);
    if (checksum !== undefined && checksum !== m.checksum) {
      throw new MigrationError(`applied migration ${m.version} was modified; add a new migration instead`);
    }
  }

  const done: string[] = [];
  for (const m of migrations.filter((x) => !applied.has(x.version))) {
    await client.query('begin');
    try {
      await client.query(m.sql);
      await client.query('insert into schema_migrations (version, checksum) values ($1, $2)', [
        m.version,
        m.checksum,
      ]);
      await client.query('commit');
      done.push(m.version);
    } catch (error) {
      await client.query('rollback');
      throw new MigrationError(`migration ${m.version} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  return done;
}
