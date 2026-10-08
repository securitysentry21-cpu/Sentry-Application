// Readiness (ARCH §15.3 GET /ready): the database answers and the schema is at the expected
// migration. The job system joins this check when pg-boss arrives (Phase 3).
import type pg from 'pg';

import { latestMigrationVersion } from './migrate.ts';

export type Readiness = { ok: boolean; problems: string[] };

export async function checkReadiness(pool: pg.Pool): Promise<Readiness> {
  const problems: string[] = [];
  try {
    const { rows } = await pool.query<{ version: string | null }>(
      'select max(version) as version from schema_migrations',
    );
    const expected = await latestMigrationVersion();
    const actual = rows[0]?.version ?? null;
    if (actual !== expected) problems.push(`schema at ${actual ?? 'no migrations'}, expected ${expected}`);
  } catch (error) {
    problems.push(`database unreachable: ${(error as Error).message}`);
  }
  return { ok: problems.length === 0, problems };
}
