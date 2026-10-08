// Platform operator CLI (D-19). Usage:
//   pnpm --filter @sentryops/api operator create-organization \
//     --name "Alpha Security" --timezone Asia/Karachi --owner-email owner@alpha.pk [--legal-name "…"]
// Reads DATABASE_URL (app_runtime), CELL_REGION and PUBLIC_ORIGIN like the API, and refuses to run
// as any other database role (D-33). Prints the owner's invitation link once.
import { parseArgs } from 'node:util';

import { createPool, verifyRuntimeRole } from '@sentryops/db';

import { loadConfig } from '../config.ts';
import { provisionOrganization } from '../provisioning.ts';
import { createDeps } from '../server.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    'legal-name': { type: 'string' },
    timezone: { type: 'string', default: 'Asia/Karachi' },
    'owner-email': { type: 'string' },
  },
});

if (positionals[0] !== 'create-organization' || !values.name || !values['owner-email']) {
  console.error(
    'usage: operator create-organization --name <name> --owner-email <email> [--timezone Asia/Karachi] [--legal-name <name>]',
  );
  process.exit(2);
}

const config = loadConfig(process.env);
const pool = createPool(config.DATABASE_URL, { applicationName: 'sentryops-operator', max: 2 });
try {
  await verifyRuntimeRole(pool, ['app_runtime']);
  const result = await provisionOrganization(createDeps(config, pool, { oidc: null }), {
    name: values.name,
    legalName: values['legal-name'] ?? null,
    timezone: values.timezone ?? 'Asia/Karachi',
    ownerEmail: values['owner-email'],
  });
  console.log(`Organization ${result.organizationId} created in ${config.CELL_REGION}.`);
  console.log('Send this invitation link to the owner (valid 7 days, single use):');
  console.log(result.acceptUrl);
} finally {
  await pool.end();
}
