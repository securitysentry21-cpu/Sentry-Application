// `node packages/db/scripts/restore-check.ts`: checks a database restored from a backup (ARCH §19.6)
// and prints what it found; it exits 1 on any problem. Runs as a one-off ECS task with the database
// task's definition and DB_HOST pointed at the copy (infra/scripts/restore-drill.sh), never on a
// laptop. TLS is required and verified against the RDS certificate authority.
import { readFileSync } from 'node:fs';

import pg from 'pg';

import { checkRestoredDatabase } from '../src/restore-check.ts';
import type { DbRole } from '../src/roles.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

const host = required('DB_HOST');
const passwords: Readonly<Record<DbRole, string>> = {
  migrator: required('MIGRATOR_PASSWORD'),
  app_runtime: required('APP_RUNTIME_PASSWORD'),
  system_worker: required('SYSTEM_WORKER_PASSWORD'),
  retention_worker: required('RETENTION_WORKER_PASSWORD'),
};
const ca = readFileSync(required('DB_SSL_ROOT_CERT'), 'utf8');

const result = await checkRestoredDatabase(async (role) => {
  const client = new pg.Client({
    host,
    port: Number(process.env.DB_PORT ?? 5432),
    database: required('DB_NAME'),
    user: role,
    password: passwords[role],
    ssl: { ca, rejectUnauthorized: true },
    application_name: 'sentryops-restore-check',
  });
  await client.connect();
  return client;
});

console.log(`${host}: migrations up to ${result.latestMigration ?? 'none'}`);
for (const [table, n] of Object.entries(result.rows)) console.log(`rows ${table} ${n}`);
for (const problem of result.problems) console.log(`PROBLEM ${problem}`);
console.log(
  result.problems.length === 0
    ? 'restore check passed'
    : `restore check FAILED: ${result.problems.length} problem(s)`,
);
process.exitCode = result.problems.length === 0 ? 0 : 1;
