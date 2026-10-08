import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MetaStore } from '../src/core/storage/meta.ts';
import {
  configureConnection,
  migrate,
  MIGRATIONS,
  SCHEMA_VERSION,
  SchemaTooNewError,
  schemaVersion,
} from '../src/core/storage/schema.ts';
import { Outbox } from '../src/core/outbox/outbox.ts';
import { fileDatabase, memoryDatabase } from './support/sqlite.ts';

// Shipped migrations are frozen: their SQL never changes, a new step is added instead (ADV-O08).
// If this list changes, an app update would leave phones with a schema the code does not expect.
const SHIPPED = {
  1: 'bbb9e688a94bdca20af2cf9a8a9818d3308f604e779581336a711d9e06ea0aae',
  2: '4c53f29b2b4df0904c682e55c7f3b1aa03f7bf7eec7c9c6beab4bf3a2815f241',
} as const;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('local schema migrations (ADV-O08)', () => {
  it('ADV-O08 shipped migrations are append-only: their SQL is pinned by hash', () => {
    for (const [version, hash] of Object.entries(SHIPPED)) {
      const migration = MIGRATIONS.find((m) => m.version === Number(version));
      expect(migration, `migration ${version} must still exist`).toBeDefined();
      expect(
        createHash('sha256')
          .update(migration?.sql ?? '')
          .digest('hex'),
        `migration ${version} was edited`,
      ).toBe(hash);
    }
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('migrates an empty database to the latest version, and re-running changes nothing', async () => {
    const db = memoryDatabase();
    await configureConnection(db);
    expect(await migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(await migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
  });

  it('ADV-O08 an outbox written by the first schema survives the upgrade and is still sent in order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentry-outbox-'));
    dirs.push(dir);
    const path = join(dir, 'outbox.db');

    // The app before the update: schema 1, with a shift's items waiting.
    const before = fileDatabase(path);
    await configureConnection(before);
    await migrate(before, MIGRATIONS.slice(0, 1));
    expect(await schemaVersion(before)).toBe(1);
    const items = ['SHIFT_START', 'LOCATION', 'LOCATION', 'SHIFT_END'] as const;
    for (const [i, type] of items.entries()) {
      const clientEventId = `0190a0d2-7c5e-7000-8000-00000000010${i}`;
      const base = {
        clientEventId,
        recordedAt: `2026-10-08T15:0${i}:00.000Z`,
        monoMs: 1000 + i,
        type,
        shiftId: '0190a0d2-7c5e-7000-8000-000000000101',
      };
      const payload =
        type === 'SHIFT_START'
          ? { ...base, fix: null, permission: { location: 'ALWAYS', precise: true } }
          : type === 'SHIFT_END'
            ? { ...base, fix: null }
            : { ...base, fix: { lat: 24.86, lon: 67.0, accuracyM: 9 } };
      await before.run(
        `INSERT INTO outbox (partition_key, lane, client_event_id, type, shift_id, payload, recorded_at_ms, mono_ms, boot_id, created_at_ms)
         VALUES ('org/guard', 'MAIN', ?, ?, ?, ?, ?, ?, 'run-1', 0)`,
        [
          clientEventId,
          type,
          base.shiftId,
          JSON.stringify(payload),
          Date.parse(base.recordedAt),
          base.monoMs,
        ],
      );
    }
    await before.close(); // the update replaces the app here

    // The updated app opens the same file.
    const after = fileDatabase(path);
    await configureConnection(after);
    expect(await migrate(after)).toEqual({ from: 1, to: SCHEMA_VERSION });
    const outbox = new Outbox(after, new MetaStore(after), () => 0);
    expect((await outbox.stats()).pending).toBe(4);
    const batch = await outbox.nextBatch('org/guard', {
      newBatchId: '0190a0d2-7c5e-7000-8000-0000000000b1',
      maxItems: 500,
      formedInBootId: 'run-2',
    });
    expect(batch?.items.map((i) => i.type)).toEqual(['SHIFT_START', 'LOCATION', 'LOCATION', 'SHIFT_END']);
    expect(batch?.items.map((i) => i.bootId)).toEqual(['run-1', 'run-1', 'run-1', 'run-1']);
    // New columns have their defaults; new tables work.
    const sos = await after.get<{ next_attempt_at_ms: number }>(
      'SELECT next_attempt_at_ms FROM outbox LIMIT 1',
    );
    expect(sos?.next_attempt_at_ms).toBe(0);
    expect(await after.get('SELECT COUNT(*) AS n FROM receipts')).toEqual({ n: 0 });
    await after.close();
  });

  it('refuses to touch a database written by a newer app (a downgrade)', async () => {
    const db = memoryDatabase();
    await migrate(db);
    await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
    await expect(migrate(db)).rejects.toBeInstanceOf(SchemaTooNewError);
  });

  it('a failed migration step rolls back completely', async () => {
    const db = memoryDatabase();
    await migrate(db, MIGRATIONS.slice(0, 1));
    const broken = [
      ...MIGRATIONS.slice(0, 1),
      { version: 2, name: 'broken', sql: 'CREATE TABLE x (a INTEGER); SELEC nonsense;' },
    ];
    await expect(migrate(db, broken)).rejects.toThrow();
    expect(await schemaVersion(db)).toBe(1);
    expect(await db.get("SELECT name FROM sqlite_master WHERE name = 'x'")).toBeNull();
  });
});
