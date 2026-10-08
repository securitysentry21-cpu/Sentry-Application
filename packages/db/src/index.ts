import pg from 'pg';

export type { Pool, PoolClient } from 'pg';

export * from './erd.ts';
export * from './kysely.ts';
export * from './migrate.ts';
export * from './readiness.ts';
export * from './registry.ts';
export * from './roles.ts';
export * from './runtime-role.ts';
export * from './schema-lint.ts';
export * from './tenant.ts';

export function createPool(
  connectionString: string,
  options: { max?: number; applicationName?: string; connectionTimeoutMs?: number } = {},
): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'sentryops',
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
  });
}
