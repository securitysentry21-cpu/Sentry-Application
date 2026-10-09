// `node packages/db/scripts/deploy-db.ts`: prepares the cloud database and applies migrations. Runs as
// a one-off ECS task before each release (infra/README.md), never on a laptop. The task definition
// injects every value below; TLS is required and verified against the RDS certificate authority.
import { readFileSync } from 'node:fs';

import { deployDatabase } from '../src/deploy.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

const result = await deployDatabase({
  connection: {
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    ssl: { ca: readFileSync(required('DB_SSL_ROOT_CERT'), 'utf8'), rejectUnauthorized: true },
    application_name: 'sentryops-deploy-db',
  },
  admin: { user: required('DB_ADMIN_USER'), password: required('DB_ADMIN_PASSWORD') },
  database: required('DB_NAME'),
  passwords: {
    migrator: required('MIGRATOR_PASSWORD'),
    app_runtime: required('APP_RUNTIME_PASSWORD'),
    system_worker: required('SYSTEM_WORKER_PASSWORD'),
    retention_worker: required('RETENTION_WORKER_PASSWORD'),
  },
});
if (result.createdDatabase) console.log('created the database');
console.log(`migrations applied: ${result.applied.join(', ') || 'none (up to date)'}`);
