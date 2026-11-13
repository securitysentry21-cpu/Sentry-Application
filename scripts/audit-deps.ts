// Dependency audit (SEC §14): fails on High or Critical advisories unless an entry in
// security/audit-allowlist.json explains why the advisory doesn't apply. Entries expire at most
// 90 days after their review, so every exception gets looked at again. The decision itself is in
// scripts/lib/audit.ts (tested by scripts/test/audit.test.ts).
//   node scripts/audit-deps.ts                  runs `pnpm audit --json`
//   node scripts/audit-deps.ts --report <file>  judges a saved report (the negative control uses it)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type AllowEntry, evaluateAudit } from './lib/audit.ts';
import { ROOT, runPnpm } from './lib/run.ts';

const allowlist = JSON.parse(readFileSync(join(ROOT, 'security', 'audit-allowlist.json'), 'utf8')) as {
  advisories: AllowEntry[];
};
const today = new Date().toISOString().slice(0, 10);

const reportAt = process.argv.indexOf('--report');
const output =
  reportAt >= 0
    ? readFileSync(process.argv[reportAt + 1] ?? '', 'utf8')
    : (await runPnpm(['audit', '--json'], { quiet: true })).output;

let report: unknown;
try {
  report = JSON.parse(output.slice(output.indexOf('{')));
} catch {
  report = undefined;
}

const outcome = evaluateAudit(report, allowlist.advisories, today);

// Exit codes through process.exitCode: process.exit() right after console.error trips a libuv
// assertion on Windows (exit 127 instead of 1).
function judge(): number {
  if (outcome.unreadable !== undefined) {
    console.error(`✗ could not read the audit report (${outcome.unreadable}): is the registry reachable?`);
    console.error(output.split('\n').slice(-10).join('\n'));
    return 1;
  }
  for (const problem of outcome.invalid) console.error(`✗ ${problem}`);
  for (const e of outcome.expired)
    console.error(`✗ allow-list entry ${e.id} (${e.package}) expired on ${e.expires}; review it`);
  for (const a of outcome.blocking)
    console.error(`✗ ${a.severity} ${a.id} in ${a.module}: ${a.title} ${a.url}`);
  if (outcome.invalid.length > 0 || outcome.blocking.length > 0 || outcome.expired.length > 0) return 1;

  for (const e of outcome.stale)
    console.log(`! allow-list entry ${e.id} (${e.package}) no longer matches; remove it`);
  for (const { advisory, entry } of outcome.allowed)
    console.log(
      `! allow-listed until ${entry.expires}: ${advisory.severity} ${advisory.id} in ${entry.package}`,
    );
  console.log(
    `✓ no unreviewed High or Critical advisories (${outcome.allowed.length} allow-listed, ${outcome.lower} lower-severity reported by pnpm audit)`,
  );
  return 0;
}
process.exitCode = judge();
