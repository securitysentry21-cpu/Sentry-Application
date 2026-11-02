// Platform operator CLI (D-19). Usage:
//   pnpm --filter @sentryops/api operator create-organization \
//     --name "Alpha Security" --timezone Asia/Karachi --owner-email owner@alpha.pk [--legal-name "…"] [--demo]
//   pnpm --filter @sentryops/api operator create-canary --owner-email canary@<operator domain>
// Reads DATABASE_URL (app_runtime), CELL_REGION and PUBLIC_ORIGIN like the API, and refuses to run
// as any other database role (D-33). Prints the owner's invitation link, or the canary's device
// secret, once.
import { parseArgs } from 'node:util';

import { createPool, verifyRuntimeRole } from '@sentryops/db';

import { loadConfig } from '../config.ts';
import { provisionCanary, provisionOrganization } from '../provisioning.ts';
import { createDeps } from '../server.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    'legal-name': { type: 'string' },
    timezone: { type: 'string', default: 'Asia/Karachi' },
    'owner-email': { type: 'string' },
    // A demo organization has no real people: every SOS in it is a drill (PROD §17, ADV-S10).
    demo: { type: 'boolean', default: false },
  },
});

const command = positionals[0];
if (
  !values['owner-email'] ||
  (command !== 'create-canary' && (command !== 'create-organization' || !values.name))
) {
  console.error(
    'usage: operator create-organization --name <name> --owner-email <email> [--timezone Asia/Karachi] [--legal-name <name>] [--demo]\n' +
      '       operator create-canary --owner-email <internal email>',
  );
  process.exit(2);
}

const config = loadConfig(process.env);
const pool = createPool(config.DATABASE_URL, { applicationName: 'sentryops-operator', max: 2 });
try {
  await verifyRuntimeRole(pool, ['app_runtime']);
  const deps = createDeps(config, pool, { oidc: null });
  if (command === 'create-canary') {
    const canary = await provisionCanary(deps, { ownerEmail: values['owner-email'] });
    console.log(`Canary organization ${canary.organizationId} created in ${config.CELL_REGION}.`);
    console.log('Put these in the worker secret (shown once, kept nowhere else):');
    console.log(`CANARY_DEVICE_ID=${canary.deviceId}`);
    console.log(`CANARY_DEVICE_KEY=${canary.privateKey}`);
  } else {
    const result = await provisionOrganization(deps, {
      name: values.name ?? '',
      legalName: values['legal-name'] ?? null,
      timezone: values.timezone ?? 'Asia/Karachi',
      ownerEmail: values['owner-email'],
      kind: values.demo ? 'DEMO' : 'CUSTOMER',
    });
    console.log(`Organization ${result.organizationId} created in ${config.CELL_REGION}.`);
    console.log('Send this invitation link to the owner (valid 7 days, single use):');
    console.log(result.acceptUrl);
  }
} finally {
  await pool.end();
}
