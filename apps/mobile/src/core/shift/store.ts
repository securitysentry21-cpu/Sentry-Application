// Persists the phone's per-shift records (local_shifts), so the headless location task, a restart
// or a reboot all see the same shift state as the screens.
import type { SqlDatabase } from '../storage/sql.ts';
import type { LocalShift } from './local-shift.ts';

export class LocalShiftStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;

  constructor(db: SqlDatabase, now: () => number) {
    this.#db = db;
    this.#now = now;
  }

  async all(partitionKey: string): Promise<LocalShift[]> {
    const rows = await this.#db.all<{ record: string }>(
      'SELECT record FROM local_shifts WHERE partition_key = ? ORDER BY updated_at_ms DESC',
      [partitionKey],
    );
    const out: LocalShift[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.record) as LocalShift);
      } catch {
        // A damaged record is skipped; the server's shift list still shows the shift.
      }
    }
    return out;
  }

  async put(partitionKey: string, shift: LocalShift): Promise<void> {
    await this.#db.run(
      `INSERT INTO local_shifts (shift_id, partition_key, record, updated_at_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (shift_id) DO UPDATE SET partition_key = excluded.partition_key, record = excluded.record,
         updated_at_ms = excluded.updated_at_ms`,
      [shift.shiftId, partitionKey, JSON.stringify(shift), this.#now()],
    );
  }

  /** Old finished records are not needed on the phone. */
  async prune(olderThanMs: number): Promise<void> {
    await this.#db.run('DELETE FROM local_shifts WHERE updated_at_ms < ?', [olderThanMs]);
  }
}
