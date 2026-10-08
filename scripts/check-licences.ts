// Licence allow-list (SEC §14): every installed package, including build tools, must carry a licence
// from security/licence-policy.json or have an exception there with a reason. Unknown or unparseable
// licences fail, so a new dependency can't arrive without someone reading its terms.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, runPnpm } from './lib/run.ts';

type Exception = { package: string; licences: string[]; reason: string };
type Policy = { allowed: string[]; exceptions: Exception[] };
type Listed = { name: string; versions?: string[] };

const policy = JSON.parse(readFileSync(join(ROOT, 'security', 'licence-policy.json'), 'utf8')) as Policy;
const allowed = new Set(policy.allowed);

const matches = (pattern: string, name: string) =>
  pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;

// SPDX expressions as npm packages use them: "A", "(A OR B)", "A AND B". Anything more complex is
// reported for a human to read rather than guessed at.
function permitted(expression: string): boolean {
  const text = expression.trim().replace(/^\((.*)\)$/, '$1');
  if (/[()]/.test(text)) return false;
  return text
    .split(/\s+OR\s+/)
    .some((alternative) => alternative.split(/\s+AND\s+/).every((id) => allowed.has(id.trim())));
}

const result = await runPnpm(['licenses', 'list', '--json'], { quiet: true });
let report: Record<string, Listed[]>;
try {
  report = JSON.parse(result.output.slice(result.output.indexOf('{'))) as typeof report;
} catch {
  console.error('✗ could not read the licence report');
  console.error(result.output.split('\n').slice(-10).join('\n'));
  process.exit(1);
}

const problems: string[] = [];
const usedExceptions = new Set<string>();
let total = 0;
for (const [licence, packages] of Object.entries(report)) {
  for (const pkg of packages) {
    total++;
    if (permitted(licence)) continue;
    const exception = policy.exceptions.find(
      (e) => matches(e.package, pkg.name) && e.licences.includes(licence),
    );
    if (exception && exception.reason.trim().length >= 40) {
      usedExceptions.add(exception.package);
      continue;
    }
    problems.push(
      `${pkg.name}@${pkg.versions?.join(', ') ?? '?'} is licensed "${licence}", which is not allowed`,
    );
  }
}

for (const p of problems) console.error(`✗ ${p}`);
if (problems.length > 0) {
  console.error(
    'Read the licence, then allow it or add an exception with a reason in security/licence-policy.json.',
  );
  process.exit(1);
}
for (const e of policy.exceptions.filter((x) => !usedExceptions.has(x.package)))
  console.log(`! licence exception ${e.package} matches nothing installed on this platform`);
console.log(
  `✓ ${total} packages checked; all licences allowed (${usedExceptions.size} reviewed exceptions in use)`,
);
