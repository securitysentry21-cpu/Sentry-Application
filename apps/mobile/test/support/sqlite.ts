// The outbox's SQL interface on Node's built-in SQLite, so tests run the same SQL and migrations
// as expo-sqlite on the phone.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { type RawSqlConnection, serializedDatabase, type SqlDatabase } from '../../src/core/storage/sql.ts';

export function nodeConnection(path = ':memory:'): RawSqlConnection {
  const db = new DatabaseSync(path);
  const bind = (params: readonly (string | number | null)[] | undefined): SQLInputValue[] => [
    ...(params ?? []),
  ];
  return {
    exec: (sql) => {
      db.exec(sql);
      return Promise.resolve();
    },
    run: (sql, params) => {
      const result = db.prepare(sql).run(...bind(params));
      return Promise.resolve({
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid),
      });
    },
    all: <T>(sql: string, params?: readonly (string | number | null)[]) =>
      Promise.resolve(db.prepare(sql).all(...bind(params)) as T[]),
    get: <T>(sql: string, params?: readonly (string | number | null)[]) =>
      Promise.resolve((db.prepare(sql).get(...bind(params)) ?? null) as T | null),
    close: () => {
      db.close();
      return Promise.resolve();
    },
  };
}

export function memoryDatabase(): SqlDatabase {
  return serializedDatabase(nodeConnection(':memory:'));
}

export function fileDatabase(path: string): SqlDatabase {
  return serializedDatabase(nodeConnection(path));
}
