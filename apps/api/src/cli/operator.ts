// Platform operator CLI (D-19). Usage (through infra/scripts/operator.sh in AWS):
//   operator create-organization --name "Alpha Security" --timezone Asia/Karachi --owner-email owner@alpha.pk [--legal-name "…"] [--demo]
//   operator create-canary --owner-email canary@<operator domain>
//   operator delivery-health --org <id> --reason "<why>" [--hours 24]
//   operator quarantine-list --org <id> --reason "<why>" [--all] [--limit 50]
//   operator quarantine-replay --org <id> --reason "<why>" [--id <item id>] [--limit 50]
// Reads DATABASE_URL (app_runtime), CELL_REGION and PUBLIC_ORIGIN like the API, and refuses to run
// as any other database role (D-33). Prints the owner's invitation link, or the canary's device
// secret, once. The three commands that look into an organization need a reason, write a
// PLATFORM_ACCESS audit row the organization can see, and print counts, ages, IDs and codes only.
import { createPool, verifyRuntimeRole } from '@sentryops/db';

import { loadConfig } from '../config.ts';
import { parseOperatorArgs, USAGE } from './operator-args.ts';
import { provisionCanary, provisionOrganization } from '../provisioning.ts';
import {
  deliveryHealth,
  formatDeliveryHealth,
  formatQuarantine,
  listQuarantine,
  OperatorError,
  replayQuarantine,
} from '../services/operator.ts';
import { createDeps } from '../server.ts';

const parsed = (() => {
  try {
    return parseOperatorArgs(process.argv.slice(2));
  } catch {
    return null; // an unknown option
  }
})();
if (!parsed) {
  console.error(USAGE);
  process.exit(2);
}
const { command, values } = parsed;

const config = loadConfig(process.env);
const pool = createPool(config.DATABASE_URL, { applicationName: 'sentryops-operator', max: 2 });
try {
  await verifyRuntimeRole(pool, ['app_runtime']);
  const deps = createDeps(config, pool, { oidc: null });
  const org = values.org ?? '';
  const reason = values.reason ?? '';
  const limit = Math.min(Math.max(Number.parseInt(values.limit, 10) || 50, 1), 500);
  if (command === 'create-canary') {
    const canary = await provisionCanary(deps, { ownerEmail: values['owner-email'] ?? '' });
    console.log(`Canary organization ${canary.organizationId} created in ${config.CELL_REGION}.`);
    console.log('Put these in the worker secret (shown once, kept nowhere else):');
    console.log(`CANARY_DEVICE_ID=${canary.deviceId}`);
    console.log(`CANARY_DEVICE_KEY=${canary.privateKey}`);
  } else if (command === 'create-organization') {
    const result = await provisionOrganization(deps, {
      name: values.name ?? '',
      legalName: values['legal-name'] ?? null,
      timezone: values.timezone ?? 'Asia/Karachi',
      ownerEmail: values['owner-email'] ?? '',
      kind: values.demo ? 'DEMO' : 'CUSTOMER',
    });
    console.log(`Organization ${result.organizationId} created in ${config.CELL_REGION}.`);
    console.log('Send this invitation link to the owner (valid 7 days, single use):');
    console.log(result.acceptUrl);
  } else if (command === 'delivery-health') {
    const health = await deliveryHealth(deps, org, { hours: Number(values.hours), reason });
    for (const line of formatDeliveryHealth(health)) console.log(line);
  } else if (command === 'quarantine-list') {
    const rows = await listQuarantine(deps, org, { reason, includeReplayed: values.all, limit });
    for (const line of formatQuarantine(rows, deps.clock.now())) console.log(line);
  } else {
    const outcomes = await replayQuarantine(deps, org, {
      reason,
      ...(values.id ? { id: values.id } : {}),
      limit,
    });
    if (outcomes.length === 0) console.log('No open quarantined items.');
    for (const o of outcomes)
      console.log(`${o.id}  ${(o.itemType ?? '?').padEnd(16)} ${o.result.padEnd(13)} ${o.detail}`);
    if (outcomes.some((o) => o.result === 'STILL_FAILING')) process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof OperatorError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}
