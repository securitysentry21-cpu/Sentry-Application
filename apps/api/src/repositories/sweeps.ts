// Cross-organization sweeps (ARCH §4.5): run as system_worker, which can only read the columns its
// policies and grants expose. They enumerate due work; they never change anything.
import type { Database } from '@sentryops/db';
import { sql } from 'kysely';

export type DueShift = { id: string; organization_id: string; kind: 'MARK_MISSED' | 'AUTO_END' };

/** SCHEDULED past the start deadline, or ACTIVE past end + the shortest possible auto-end delay. */
export async function dueShifts(
  sweep: Database,
  now: Date,
  autoEndFloor: Date,
  limit: number,
): Promise<DueShift[]> {
  const { rows } = await sql<DueShift>`
    select id, organization_id,
           case when status = 'SCHEDULED' then 'MARK_MISSED' else 'AUTO_END' end as kind
      from shifts
     where (status = 'SCHEDULED' and start_deadline_at <= ${now})
        or (status = 'ACTIVE' and ends_at <= ${autoEndFloor})
     order by organization_id
     limit ${limit}`.execute(sweep);
  return rows;
}
