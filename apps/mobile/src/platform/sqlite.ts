// The outbox database on the phone: expo-sqlite, in the app's private storage (ARCH §8.6, §8.11).
// Android: android.allowBackup is off (app.config.ts), so it never reaches a cloud backup.
// iOS: excluding the file from iCloud backup needs NSURLIsExcludedFromBackupKey, which Expo does not
// expose; see README ("On-device data").
import * as SQLite from 'expo-sqlite';

import { type RawSqlConnection, serializedDatabase, type SqlDatabase } from '../core/storage/sql.ts';

export const OUTBOX_DATABASE = 'sentry-outbox.db';

export async function openOutboxDatabase(): Promise<SqlDatabase> {
  const db = await SQLite.openDatabaseAsync(OUTBOX_DATABASE);
  const connection: RawSqlConnection = {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params = []) => {
      const result = await db.runAsync(sql, [...params]);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
    all: <T>(sql: string, params: readonly (string | number | null)[] = []) =>
      db.getAllAsync<T>(sql, [...params]),
    get: <T>(sql: string, params: readonly (string | number | null)[] = []) =>
      db.getFirstAsync<T>(sql, [...params]),
    close: () => db.closeAsync(),
  };
  return serializedDatabase(connection);
}
