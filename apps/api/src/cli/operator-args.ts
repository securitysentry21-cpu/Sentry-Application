// The operator CLI's arguments (apps/api/src/cli/operator.ts). Kept apart from the command itself,
// which opens a database pool, so the checks that must hold before anything is touched are cheap to
// test: a command that looks into an organization needs a valid organization ID and a reason.
import { parseArgs } from 'node:util';

export const USAGE =
  'usage: operator create-organization --name <name> --owner-email <email> [--timezone Asia/Karachi] [--legal-name <name>] [--demo]\n' +
  '       operator create-canary --owner-email <internal email>\n' +
  '       operator delivery-health --org <id> --reason <why> [--hours 24]\n' +
  '       operator quarantine-list --org <id> --reason <why> [--all] [--limit 50]\n' +
  '       operator quarantine-replay --org <id> --reason <why> [--id <item id>] [--limit 50]';

export const COMMANDS = [
  'create-organization',
  'create-canary',
  'delivery-health',
  'quarantine-list',
  'quarantine-replay',
] as const;
export type OperatorCommand = (typeof COMMANDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseOperatorArgs(argv: readonly string[]) {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      'legal-name': { type: 'string' },
      timezone: { type: 'string', default: 'Asia/Karachi' },
      'owner-email': { type: 'string' },
      // A demo organization has no real people: every SOS in it is a drill (PROD §17, ADV-S10).
      demo: { type: 'boolean', default: false },
      org: { type: 'string' },
      reason: { type: 'string' },
      hours: { type: 'string', default: '24' },
      limit: { type: 'string', default: '50' },
      id: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
  });
  const command = COMMANDS.find((c) => c === positionals[0]);
  if (!command) return null;
  const looksIntoOrganization = command.startsWith('delivery-') || command.startsWith('quarantine-');
  if (command === 'create-canary' && !values['owner-email']) return null;
  if (command === 'create-organization' && (!values.name || !values['owner-email'])) return null;
  if (looksIntoOrganization && (!values.org || !UUID.test(values.org) || !values.reason?.trim())) return null;
  if (values.id !== undefined && !UUID.test(values.id)) return null;
  return { command, values };
}
