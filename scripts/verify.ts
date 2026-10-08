// `pnpm verify`: everything CI runs, in one command, so it works the same locally (ARCH §19.3).
// Options: --skip=<step,step> (for example --skip=audit when offline).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, runBin, runNode, vitestFailed, type RunResult } from './lib/run.ts';

type Step = { key: string; name: string; run: () => Promise<RunResult> };

// Build tools phone home with usage statistics by default; automated runs don't.
process.env.NEXT_TELEMETRY_DISABLED ??= '1';
process.env.EXPO_NO_TELEMETRY ??= '1';

const tsconfigs = [
  'tsconfig.json',
  'packages/contracts/tsconfig.json',
  'packages/domain/tsconfig.json',
  'packages/db/tsconfig.json',
  'apps/api/tsconfig.json',
  'apps/web/tsconfig.json',
  'apps/mobile/tsconfig.json',
].filter((p) => existsSync(join(ROOT, p)));

async function typecheckAll(): Promise<RunResult> {
  let output = '';
  for (const project of tsconfigs) {
    // Next.js generates next-env.d.ts and the route types, which are not committed: a fresh clone
    // (CI) has neither until this runs.
    if (project.startsWith('apps/web/')) {
      const typegen = await runBin('next', ['typegen'], { cwd: join(ROOT, 'apps/web') });
      output += typegen.output;
      if (typegen.code !== 0) return { code: typegen.code, output };
    }
    const result = await runBin('typescript', ['-p', project], { bin: 'tsc' });
    output += result.output;
    if (result.code !== 0) return { code: result.code, output };
  }
  return { code: 0, output };
}

const steps: Step[] = [
  {
    key: 'scope',
    name: 'workspace scope: no @sentry/* packages',
    run: () => runNode(['scripts/check-workspace-scope.ts']),
  },
  { key: 'format', name: 'format (prettier)', run: () => runBin('prettier', ['.', '--check']) },
  {
    key: 'lint',
    name: 'lint (eslint, warnings fail)',
    run: () => runBin('eslint', ['.', '--max-warnings=0']),
  },
  { key: 'typecheck', name: `typecheck (${tsconfigs.length} projects)`, run: typecheckAll },
  {
    key: 'test',
    name: 'tests (unit + integration on PostgreSQL as app_runtime)',
    run: async () => {
      const result = await runBin('vitest', ['run']);
      return { ...result, code: vitestFailed(result) ? 1 : 0 };
    },
  },
  {
    key: 'docs',
    name: 'generated docs match the code (ADV-X04)',
    run: () => runNode(['scripts/generate-docs.ts', '--check']),
  },
  {
    key: 'dbtypes',
    name: 'generated database types match the schema (D-10)',
    run: () => runNode(['packages/db/scripts/codegen.ts', '--check']),
  },
  { key: 'trace', name: 'test ID traceability (ADV-X03)', run: () => runNode(['scripts/traceability.ts']) },
  {
    key: 'negative',
    name: 'negative controls turn checks red (ADV-X02)',
    run: () => runNode(['scripts/negative-controls.ts']),
  },
  {
    key: 'audit',
    name: 'dependency audit (High/Critical fail)',
    run: () => runNode(['scripts/audit-deps.ts']),
  },
  {
    key: 'licences',
    name: 'licence allow-list (SEC §14)',
    run: () => runNode(['scripts/check-licences.ts']),
  },
];
if (existsSync(join(ROOT, 'apps/web/package.json'))) {
  steps.push({
    key: 'web',
    name: 'build: web dashboard (next build)',
    run: () => runBin('next', ['build'], { cwd: join(ROOT, 'apps/web') }),
  });
}
if (existsSync(join(ROOT, 'apps/mobile/package.json'))) {
  steps.push({
    key: 'mobile',
    name: 'build: guard app JS bundle (expo export, Android)',
    run: () =>
      runBin('expo', ['export', '--platform', 'android', '--output-dir', join(ROOT, '.tmp', 'expo-export')], {
        cwd: join(ROOT, 'apps/mobile'),
      }),
  });
}

const skip = new Set(
  process.argv
    .find((a) => a.startsWith('--skip='))
    ?.slice('--skip='.length)
    .split(',') ?? [],
);

const results: { step: Step; ok: boolean; seconds: number; skipped: boolean }[] = [];
for (const step of steps) {
  if (skip.has(step.key)) {
    results.push({ step, ok: true, seconds: 0, skipped: true });
    continue;
  }
  console.log(`\n━━━ ${step.name}`);
  const started = performance.now();
  const result = await step.run();
  results.push({
    step,
    ok: result.code === 0,
    seconds: (performance.now() - started) / 1000,
    skipped: false,
  });
}

console.log('\n━━━ summary');
for (const r of results) {
  const mark = r.skipped ? '–' : r.ok ? '✓' : '✗';
  console.log(`${mark} ${r.step.name}${r.skipped ? ' (skipped)' : ` (${r.seconds.toFixed(1)} s)`}`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n✗ verify failed: ${failed.map((r) => r.step.key).join(', ')}`);
  process.exit(1);
}
console.log(`\n✓ verify passed${skip.size > 0 ? ` (skipped: ${[...skip].join(', ')})` : ''}`);
