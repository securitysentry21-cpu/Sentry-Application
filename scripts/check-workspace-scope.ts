// Workspace packages never use the @sentry/* npm scope: it belongs to Sentry.io, so our names would
// collide with real packages and invite dependency confusion (review §9, SEC §20 item 37).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './lib/run.ts';

const BOM = String.fromCharCode(0xfeff);

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const manifests = [join(ROOT, 'package.json')];
for (const group of ['apps', 'packages', 'tools']) {
  for (const entry of listDir(join(ROOT, group))) {
    const manifest = join(ROOT, group, entry, 'package.json');
    try {
      if (statSync(manifest).isFile()) manifests.push(manifest);
    } catch {
      // not a package
    }
  }
}

// Strip a UTF-8 byte-order mark: some Windows tools add one, and JSON.parse rejects it.
function packageName(path: string): string {
  let text = readFileSync(path, 'utf8');
  if (text.startsWith(BOM)) text = text.slice(1);
  return (JSON.parse(text) as { name?: string }).name ?? '';
}

const offenders = manifests
  .map((path) => ({ path, name: packageName(path) }))
  .filter(({ name }) => name.startsWith('@sentry/'));

if (offenders.length > 0) {
  for (const o of offenders) console.error(`✗ ${o.name} (${o.path}) uses the @sentry/ scope`);
  process.exit(1);
}
console.log(`✓ ${manifests.length} workspace package names checked; none uses @sentry/*`);
