// Dependency audit (SEC §14): fails on High or Critical advisories unless an entry in
// security/audit-allowlist.json explains why the advisory doesn't apply. Entries expire at most
// 90 days after their review, so every exception gets looked at again.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, runPnpm } from './lib/run.ts';

type Allowed = { id: string; package: string; reason: string; reviewed: string; expires: string };
type Advisory = { id: string; module: string; severity: string; title: string; url: string };

const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const allowlist = JSON.parse(readFileSync(join(ROOT, 'security', 'audit-allowlist.json'), 'utf8')) as {
  advisories: Allowed[];
};
const today = new Date().toISOString().slice(0, 10);

// An exception is only as good as its justification: reject entries that are vague or open-ended.
const invalid: string[] = [];
for (const a of allowlist.advisories) {
  const label = `allow-list entry ${a.id || '(no id)'}`;
  if (!/^GHSA-[\w-]+$/.test(a.id)) invalid.push(`${label}: id must be a GHSA advisory ID`);
  if (!a.package) invalid.push(`${label}: name the affected package`);
  if ((a.reason ?? '').trim().length < 40) invalid.push(`${label}: explain why it does not apply`);
  if (!ISO_DATE.test(a.reviewed ?? '') || !ISO_DATE.test(a.expires ?? '')) {
    invalid.push(`${label}: reviewed and expires must be YYYY-MM-DD dates`);
  } else if (Date.parse(a.expires) - Date.parse(a.reviewed) > MAX_DAYS * DAY_MS) {
    invalid.push(`${label}: expires more than ${MAX_DAYS} days after its review`);
  }
}
const expired = allowlist.advisories.filter((a) => a.expires < today);
const allowed = new Map(allowlist.advisories.filter((a) => a.expires >= today).map((a) => [a.id, a]));

const result = await runPnpm(['audit', '--json'], { quiet: true });
let report: { advisories?: Record<string, Record<string, unknown>> };
try {
  report = JSON.parse(result.output.slice(result.output.indexOf('{'))) as typeof report;
} catch {
  console.error('✗ could not read the audit report (is the registry reachable?)');
  console.error(result.output.split('\n').slice(-10).join('\n'));
  process.exit(1);
}

// The report is untyped JSON; keep only scalar fields so an unexpected shape can't print "[object Object]".
const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;

const advisories: Advisory[] = Object.values(report.advisories ?? {}).map((a) => ({
  id: str(a.github_advisory_id, str(a.id, '?')),
  module: str(a.module_name, '?'),
  severity: str(a.severity, 'unknown'),
  title: str(a.title, ''),
  url: str(a.url, ''),
}));
const blocking = advisories.filter((a) => ['high', 'critical'].includes(a.severity) && !allowed.has(a.id));
const stale = [...allowed.keys()].filter((id) => !advisories.some((a) => a.id === id));

for (const problem of invalid) console.error(`✗ ${problem}`);
for (const e of expired)
  console.error(`✗ allow-list entry ${e.id} (${e.package}) expired on ${e.expires}; review it`);
for (const a of blocking) console.error(`✗ ${a.severity} ${a.id} in ${a.module}: ${a.title} ${a.url}`);
if (invalid.length > 0 || blocking.length > 0 || expired.length > 0) process.exit(1);

for (const id of stale) console.log(`! allow-list entry ${id} no longer matches any advisory; remove it`);
for (const a of advisories.filter((x) => allowed.has(x.id)))
  console.log(`! allow-listed until ${allowed.get(a.id)?.expires}: ${a.severity} ${a.id} in ${a.module}`);
const lower = advisories.filter((a) => !['high', 'critical'].includes(a.severity)).length;
console.log(
  `✓ no unreviewed High or Critical advisories (${allowed.size} allow-listed, ${lower} lower-severity reported by pnpm audit)`,
);
