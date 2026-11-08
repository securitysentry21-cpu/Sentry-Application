// @proves ADV-X03
// ID traceability (ADV-X03, review M-05). Tests name the INV / ADV IDs they prove. This fails if a
// test cites an ID the spec doesn't define, or if an ID due in the current or a completed phase
// (ARCH §22, "Exit tests") has no test. It writes docs/generated/traceability.md.
// `--through <phase>` checks as if every phase up to that one were done, and writes nothing: what is
// still missing before status.json may move. Through the last phase every adversarial test SEC defines
// is due, as the definition of done requires (PROD §18).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ROOT } from './lib/run.ts';

const ID = /\b(?:ADV-[A-Z]+\d{2}|INV-\d{2})\b/g;

// IDs the spec defines.
const sec = readFileSync(join(ROOT, 'docs', 'SECURITY_AND_INVARIANTS.md'), 'utf8');
const defined = new Set(sec.match(ID) ?? []);

// IDs due by phase, from the exit-test column of ARCH §22.
function dueByPhase(): Map<string, string[]> {
  const arch = readFileSync(join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
  const start = arch.indexOf('## 22. Implementation phases');
  const end = arch.indexOf('\n## ', start + 10);
  const due = new Map<string, string[]>();
  for (const line of arch.slice(start, end).split('\n')) {
    const phase = /^\|\s*\*\*(\w+)\s/.exec(line)?.[1];
    if (!phase) continue;
    const exitColumn =
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .at(-1) ?? '';
    const ids: string[] = [];
    for (const raw of exitColumn.split(/[,;]/)) {
      const m = /^(?:ADV-)?([A-Z]+)(\d{2})(?:\s*[–-]\s*(?:[A-Z]+)?(\d{2}))?$/.exec(raw.trim());
      if (!m) continue;
      const [, prefix, from, to] = m;
      for (let n = Number(from); n <= Number(to ?? from); n++)
        ids.push(`ADV-${prefix}${String(n).padStart(2, '0')}`);
    }
    due.set(phase, ids);
  }
  return due;
}

// IDs the tests cite, from it()/test()/describe() titles.
function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const TITLE = /\b(?:it|test|describe)(?:\.\w+)?\(\s*(['"`])((?:(?!\1).)*)\1/g;
// Verification scripts that are themselves the proof (e.g. negative controls) say so in a header
// line: `// @proves ADV-X02`.
const PROVES = /^\/\/ @proves ((?:ADV-[A-Z]+\d{2}|INV-\d{2})(?:,\s*(?:ADV-[A-Z]+\d{2}|INV-\d{2}))*)\s*$/gm;
const cited = new Map<string, Set<string>>();
const cite = (id: string, file: string) => {
  if (!cited.has(id)) cited.set(id, new Set());
  cited.get(id)?.add(relative(ROOT, file).replace(/\\/g, '/'));
};
for (const group of ['apps', 'packages']) {
  for (const file of testFiles(join(ROOT, group))) {
    for (const match of readFileSync(file, 'utf8').matchAll(TITLE)) {
      for (const id of match[2]?.match(ID) ?? []) cite(id, file);
    }
  }
}
for (const entry of readdirSync(join(ROOT, 'scripts'))) {
  if (!entry.endsWith('.ts')) continue;
  const file = join(ROOT, 'scripts', entry);
  for (const match of readFileSync(file, 'utf8').matchAll(PROVES)) {
    for (const id of match[1]?.match(ID) ?? []) cite(id, file);
  }
}

const status = JSON.parse(readFileSync(join(ROOT, 'docs', 'phases', 'status.json'), 'utf8')) as {
  current: string;
  completed: string[];
};
const due = dueByPhase();
const order = [...due.keys()];
const throughAt = process.argv.indexOf('--through');
const through = throughAt >= 0 ? process.argv[throughAt + 1] : undefined;
if (throughAt >= 0 && (through === undefined || !order.includes(through))) {
  console.error(`✗ --through needs a phase from the ARCH §22 table: ${order.join(', ')}`);
  process.exit(2);
}
const lastPhase = through ?? status.current;
const phases =
  through === undefined ? [...status.completed, status.current] : order.slice(0, order.indexOf(through) + 1);
const problems: string[] = [];

for (const id of cited.keys()) {
  if (!defined.has(id)) problems.push(`a test cites ${id}, which SEC does not define`);
}
const missing = new Set<string>();
for (const phase of phases) {
  if (!due.has(phase)) problems.push(`phase ${phase} is not in the ARCH §22 table`);
  for (const id of due.get(phase) ?? []) {
    if (cited.has(id)) continue;
    missing.add(id);
    problems.push(`${id} is due in phase ${phase} but no test carries it`);
  }
}
if (lastPhase === order.at(-1)) {
  for (const id of [...defined].sort()) {
    if (id.startsWith('ADV-') && !cited.has(id) && !missing.has(id)) {
      problems.push(`${id} has no test, and the definition of done needs every adversarial test (PROD §18)`);
    }
  }
}
if (through !== undefined) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.log(
    problems.length === 0
      ? `✓ every ID due through phase ${through} has a test`
      : `${problems.length} problem(s) through phase ${through}`,
  );
  process.exit(problems.length === 0 ? 0 : 1);
}

const rows = [...cited.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, files]) => `| ${id} | ${[...files].sort().join('<br>')} |`);
writeFileSync(
  join(ROOT, 'docs', 'generated', 'traceability.md'),
  [
    '<!-- Generated by scripts/traceability.ts from test titles. Do not edit. -->',
    '# Test traceability',
    '',
    `Current phase: ${status.current}. IDs due through this phase: ${phases.flatMap((p) => due.get(p) ?? []).join(', ') || 'none'}.`,
    '',
    '| ID | Tests |',
    '|---|---|',
    ...rows,
    '',
  ].join('\n'),
);

if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(
  `✓ ${cited.size} IDs cited by tests, all defined; every ID due through phase ${lastPhase} has a test`,
);
