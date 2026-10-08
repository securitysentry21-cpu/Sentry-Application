// @proves ADV-X04
// Generated reference tables (ADV-X04, review M-06). The code is the source; these files are
// derived from it. `--check` fails if any committed file differs from what the code generates.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ERROR_CODES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  SETTINGS,
  type Permission,
} from '@sentryops/contracts';

import { buildOpenApi } from '../apps/api/src/openapi.ts';
import { ROUTES } from '../apps/api/src/routes/index.ts';
import { ROOT } from './lib/run.ts';

const OUT = join(ROOT, 'docs', 'generated');
const HEADER = (source: string) =>
  `<!-- Generated from ${source} by scripts/generate-docs.ts. Do not edit; run \`pnpm docs:generate\`. -->\n`;

function settingsMd(): string {
  const rows = Object.entries(SETTINGS).map(
    ([key, def]) =>
      `| \`${key}\` | \`${JSON.stringify(def.default)}\` | ${def.scope} | ${def.dashboardEditable ? 'yes' : 'no'} | ${def.note} |`,
  );
  return [
    HEADER('packages/contracts/src/settings.ts'),
    '# Settings',
    '',
    'Defaults and scope of every organization setting (PROD Appendix B). "Dashboard" marks the settings an organization can edit itself in V1 (review P-06).',
    '',
    '| Key | Default | Scope | Dashboard | Bounds / note |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function permissionsMd(): string {
  const rows = (Object.keys(PERMISSIONS) as Permission[]).map(
    (p) =>
      `| \`${p}\` | ${ROLES.map((r) => (ROLE_PERMISSIONS[r].has(p) ? '✔' : '–')).join(' | ')} | ${PERMISSIONS[p]} |`,
  );
  return [
    HEADER('packages/contracts/src/permissions.ts'),
    '# Permissions',
    '',
    'The role → permission map that implements PROD §3.2. Code checks these strings, never role names.',
    '',
    `| Permission | ${ROLES.join(' | ')} | Meaning |`,
    `|---|${ROLES.map(() => '---').join('|')}|---|`,
    ...rows,
    '',
  ].join('\n');
}

function errorCodesMd(): string {
  const rows = Object.entries(ERROR_CODES).map(([code, e]) => `| \`${code}\` | ${e.http} | ${e.meaning} |`);
  return [
    HEADER('packages/contracts/src/errors.ts'),
    '# Error codes',
    '',
    '| Code | HTTP | Meaning |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

const files: Record<string, string> = {
  'settings.md': settingsMd(),
  'permissions.md': permissionsMd(),
  'error-codes.md': errorCodesMd(),
  'openapi.json': `${JSON.stringify(buildOpenApi(ROUTES), null, 2)}\n`,
};

const check = process.argv.includes('--check');
const drifted: string[] = [];
mkdirSync(OUT, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  const path = join(OUT, name);
  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // missing counts as drift
    }
    if (current !== content) drifted.push(name);
  } else {
    writeFileSync(path, content);
    console.log(`wrote docs/generated/${name}`);
  }
}

if (check) {
  if (drifted.length > 0) {
    console.error(`✗ generated docs are stale: ${drifted.join(', ')}. Run \`pnpm docs:generate\`.`);
    process.exit(1);
  }
  console.log(`✓ ${Object.keys(files).length} generated docs match the code`);
}
