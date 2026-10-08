// @proves ADV-X02
// Negative controls (ADV-X02, review M-04): prove the security checks CAN fail. Each control breaks
// one mechanism on purpose and asserts that the check guarding it turns red for the right reason.
// A control that stays green fails the build: the lesson of the lint step that did nothing.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, runBin, vitestFailed, type RunResult } from './lib/run.ts';

type Control = {
  name: string;
  /** Text the failing output must contain, so a crash for an unrelated reason doesn't count. */
  expect: RegExp;
  run: () => Promise<RunResult & { failed: boolean }>;
};

const vitest = (project: string, file: string, control: string) => async () => {
  const result = await runBin('vitest', ['run', '--project', project, file], {
    env: { NEGATIVE_CONTROL: control },
    quiet: true,
  });
  return { ...result, failed: vitestFailed(result) };
};

const PLANTED = join(ROOT, 'packages', 'domain', 'src', '__negative_control__.ts');

const controls: Control[] = [
  {
    name: 'RLS switched off on a tenant table → ADV-T06 must fail',
    expect: /× .*ADV-T06/,
    run: vitest('db', 'test/rls.test.ts', 'rls-disabled'),
  },
  {
    name: 'UPDATE granted on an append-only table → the schema linter (ADV-X01) must fail',
    expect: /× .*ADV-X01/,
    run: vitest('db', 'test/schema-lint.test.ts', 'append-only-update-granted'),
  },
  {
    name: 'route mounted without a policy → the route meta-test (ADV-A09) must fail',
    expect: /× .*ADV-A09/,
    run: vitest('api', 'test/route-registry.test.ts', 'route-without-policy'),
  },
  {
    name: 'wall-clock read planted in domain code → lint must fail',
    expect: /Read time from the injected Clock/,
    run: async () => {
      writeFileSync(PLANTED, 'export const planted = Date.now();\n');
      try {
        const result = await runBin('eslint', [PLANTED, '--max-warnings=0'], { quiet: true });
        return { ...result, failed: result.code !== 0 };
      } finally {
        rmSync(PLANTED, { force: true });
      }
    },
  },
];

let failures = 0;
for (const control of controls) {
  const result = await control.run();
  const turnedRed = result.failed && control.expect.test(result.output);
  console.log(`${turnedRed ? '✓' : '✗'} ${control.name}`);
  if (!turnedRed) {
    failures++;
    console.error(
      result.failed
        ? '  it failed, but not for the expected reason:'
        : '  the check stayed GREEN with the mechanism broken',
    );
    console.error(result.output.split('\n').slice(-25).join('\n'));
  }
}

if (failures > 0) process.exit(1);
console.log(`✓ all ${controls.length} negative controls turned their checks red`);
