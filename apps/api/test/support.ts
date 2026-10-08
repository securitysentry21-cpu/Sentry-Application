import type { Config } from '../src/config.ts';

export const NOW = '2026-10-08T19:57:03.120Z';

export function testConfig(databaseUrl: string): Config {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    DATABASE_URL: databaseUrl,
    CELL_REGION: 'eu-central-1',
    LOG_LEVEL: 'silent',
  };
}

/** A URL nothing listens on: the pool only fails when used. */
export const UNREACHABLE_DATABASE = 'postgres://app_runtime:unused@127.0.0.1:1/none';
