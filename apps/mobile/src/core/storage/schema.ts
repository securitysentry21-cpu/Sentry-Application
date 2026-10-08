// The phone's local database schema and its migrations (ARCH §8.6, ADV-O08). The outbox must survive
// app updates mid-shift, so the schema only ever moves forward through these numbered steps, each in
// its own transaction, tracked in PRAGMA user_version.
//
// Rules (the same as the server's migrations):
// - Never edit or remove a migration that has shipped; add a new one. test/storage.test.ts pins the
//   SHA-256 of every shipped migration and fails if one changes.
// - Migrations only add: tables, columns with defaults, indexes. Pending items must stay readable.
import type { SqlDatabase } from './sql.ts';

export type Migration = { readonly version: number; readonly name: string; readonly sql: string };

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'outbox, batches, local shift state, key-value metadata',
    sql: `
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  partition_key TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('MAIN', 'SOS')),
  client_event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  shift_id TEXT,
  payload TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  mono_ms INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX outbox_lane_order ON outbox (partition_key, lane, seq);
CREATE INDEX outbox_by_batch ON outbox (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX outbox_by_shift ON outbox (partition_key, shift_id, type);

CREATE TABLE batches (
  batch_id TEXT PRIMARY KEY NOT NULL,
  partition_key TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE local_shifts (
  shift_id TEXT PRIMARY KEY NOT NULL,
  partition_key TEXT NOT NULL,
  record TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
`,
  },
  {
    version: 2,
    name: 'receipts for honest action states; per-item retry time for the SOS lane',
    sql: `
CREATE TABLE receipts (
  client_event_id TEXT PRIMARY KEY NOT NULL,
  partition_key TEXT NOT NULL,
  type TEXT NOT NULL,
  shift_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'ACCEPTED', 'DUPLICATE', 'QUARANTINED', 'REJECTED', 'DISCARDED')),
  error_code TEXT,
  server_ref TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX receipts_recent ON receipts (partition_key, updated_at_ms);

ALTER TABLE outbox ADD COLUMN next_attempt_at_ms INTEGER NOT NULL DEFAULT 0;
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/** The database was written by a newer app version (the app was downgraded). Never touch it. */
export class SchemaTooNewError extends Error {
  override name = 'SchemaTooNewError';
  readonly found: number;
  constructor(found: number) {
    super(`local database schema ${found} is newer than this app (${SCHEMA_VERSION})`);
    this.found = found;
  }
}

/** Connection settings applied on every open, before migrating. */
export async function configureConnection(db: SqlDatabase): Promise<void> {
  // WAL keeps readers and the single writer apart; FULL syncs every commit, so a sudden power loss
  // never loses an acknowledged write. The write rate (one item every few seconds) makes it cheap.
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA synchronous = FULL;');
  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec('PRAGMA busy_timeout = 5000;');
}

export async function schemaVersion(db: SqlDatabase): Promise<number> {
  const row = await db.get<{ user_version: number }>('PRAGMA user_version;');
  return row?.user_version ?? 0;
}

/** Brings the schema up to date. Returns the versions before and after. */
export async function migrate(
  db: SqlDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ from: number; to: number }> {
  const latest = migrations.at(-1)?.version ?? 0;
  const from = await schemaVersion(db);
  if (from > latest) throw new SchemaTooNewError(from);
  for (const migration of migrations) {
    if (migration.version <= from) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      // user_version lives in the database header and changes with the transaction.
      await tx.exec(`PRAGMA user_version = ${Math.trunc(migration.version)};`);
    });
  }
  return { from, to: await schemaVersion(db) };
}
