// The small SQL surface the outbox needs (ARCH §8.6). The phone implements it with expo-sqlite
// (src/platform/sqlite.ts); the unit tests implement it with Node's built-in SQLite, so both run
// the same SQL and the same migrations.

export type SqlValue = string | number | null;
export type SqlParams = readonly SqlValue[];
export type RunResult = { changes: number; lastInsertRowId: number };

export interface SqlExecutor {
  /** One or more statements without parameters. */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParams): Promise<RunResult>;
  all<T>(sql: string, params?: SqlParams): Promise<T[]>;
  get<T>(sql: string, params?: SqlParams): Promise<T | null>;
}

/** What a platform supplies: a single connection, used by one caller at a time. */
export interface RawSqlConnection extends SqlExecutor {
  close(): Promise<void>;
}

export interface SqlDatabase extends SqlExecutor {
  /**
   * Runs `fn` inside BEGIN IMMEDIATE … COMMIT, rolling back if it throws. Nothing else touches the
   * connection meanwhile. Inside `fn`, use only the executor it receives: calling the database
   * itself would wait for the transaction to finish and never return.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Serializes every call on one connection through a queue. The location task, the sync engine and
 * the screens all share the database in one JavaScript runtime; without the queue, one caller's
 * statements could run inside another caller's open transaction.
 */
export function serializedDatabase(connection: RawSqlConnection): SqlDatabase {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    exec: (sql) => exclusive(() => connection.exec(sql)),
    run: (sql, params) => exclusive(() => connection.run(sql, params)),
    all: <T>(sql: string, params?: SqlParams) => exclusive(() => connection.all<T>(sql, params)),
    get: <T>(sql: string, params?: SqlParams) => exclusive(() => connection.get<T>(sql, params)),
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
      exclusive(async () => {
        await connection.exec('BEGIN IMMEDIATE');
        try {
          const value = await fn(connection);
          await connection.exec('COMMIT');
          return value;
        } catch (error) {
          try {
            await connection.exec('ROLLBACK');
          } catch {
            // The original error matters more than a failed rollback.
          }
          throw error;
        }
      }),
    close: () => exclusive(() => connection.close()),
  };
}

/** `?, ?, ?` for an IN (…) list. */
export const placeholders = (count: number): string => Array.from({ length: count }, () => '?').join(', ');
