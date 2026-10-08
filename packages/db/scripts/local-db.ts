// `pnpm db:up`: a local development database. Starts embedded PostgreSQL 17 with its data kept in
// .local/postgres (so it survives restarts), creates the roles and the `sentryops` database, applies
// migrations, prints the connection URLs, and keeps running until Ctrl+C.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { migrate } from '../src/migrate.ts';
import {
  bootstrapRoles,
  createDatabase,
  MIGRATOR,
  roleUrl,
  RUNTIME_ROLES,
  type DbRole,
} from '../src/roles.ts';

const PORT = Number(process.env.LOCAL_DB_PORT ?? 54329);
const DATA = fileURLToPath(new URL('../../../.local/postgres', import.meta.url));
const SERVER = fileURLToPath(new URL('../test-support/embedded-server.ts', import.meta.url));
const NAME = 'sentryops';
const adminUrl = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;

mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, [SERVER, String(PORT), DATA], { stdio: ['pipe', 'pipe', 'inherit'] });
await new Promise<void>((resolve, reject) => {
  child.once('exit', (code) => reject(new Error(`PostgreSQL exited (code ${code})`)));
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.includes('"ready":true')) resolve();
  });
});

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await bootstrapRoles(admin);
const exists = await admin.query('select 1 from pg_database where datname = $1', [NAME]);
if (exists.rowCount === 0) await createDatabase(admin, NAME);
await admin.end();

const migrator = new pg.Client({ connectionString: roleUrl(adminUrl, NAME, MIGRATOR) });
await migrator.connect();
const applied = await migrate(migrator);
await migrator.end();

console.log(
  `\nLocal PostgreSQL 17 on port ${PORT} (data in .local/postgres). Applied: ${applied.join(', ') || 'nothing new'}.`,
);
console.log('Development-only credentials:');
const roles: DbRole[] = [MIGRATOR, ...RUNTIME_ROLES];
for (const role of roles) console.log(`  ${role.padEnd(17)} ${roleUrl(adminUrl, NAME, role)}`);
console.log('\nFor the API: DATABASE_URL = the app_runtime URL above. Press Ctrl+C to stop.');

process.once('SIGINT', () => {
  child.stdin.end('stop\n');
  child.once('exit', () => process.exit(0));
});
