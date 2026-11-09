// @proves ADV-X02
// Negative controls (ADV-X02, review M-04): prove the security checks CAN fail. Each control breaks
// one mechanism on purpose and asserts that the check guarding it turns red for the right reason.
// A control that stays green fails the build: the lesson of the lint step that did nothing.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT, runBin, runNode, vitestFailed, type RunResult } from './lib/run.ts';

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

/** Plants a file, lints it, removes it. */
const lintPlanted = (path: string, source: string) => async () => {
  writeFileSync(path, source);
  try {
    const result = await runBin('eslint', [path, '--max-warnings=0'], { quiet: true });
    return { ...result, failed: result.code !== 0 };
  } finally {
    rmSync(path, { force: true });
  }
};

/**
 * Fable pass 2 (§5, L-18): breaks the mechanism where it lives, in the source, for one test run. The
 * line must occur exactly once (so a refactor that moves it turns this control red, not silent), and
 * the file is restored in `finally`; an interrupted run shows in `git diff`.
 */
const mutated = (file: string, from: string, to: string, project: string, testFile: string) => async () => {
  const path = join(ROOT, file);
  const original = readFileSync(path, 'utf8');
  if (original.split(from).length !== 2) {
    return { code: 1, output: `the line to break is not found once in ${file}: ${from}`, failed: false };
  }
  writeFileSync(path, original.replace(from, to));
  try {
    const result = await runBin('vitest', ['run', '--project', project, testFile], { quiet: true });
    return { ...result, failed: vitestFailed(result) };
  } finally {
    writeFileSync(path, original);
  }
};

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
    name: 'retention_worker allowed to update more than positions → the schema linter (ADV-X01) must fail',
    expect: /× .*ADV-X01/,
    run: vitest('db', 'test/schema-lint.test.ts', 'retention-update-widened'),
  },
  {
    name: 'route mounted without a policy → the route meta-test (ADV-A09) must fail',
    expect: /× .*ADV-A09/,
    run: vitest('api', 'test/route-registry.test.ts', 'route-without-policy'),
  },
  {
    name: 'a library adds READ_CONTACTS to the release manifest → the ADV-X08 manifest check must fail',
    expect: /blocked permission android\.permission\.READ_CONTACTS/,
    run: async () => {
      const mobile = join(ROOT, 'apps', 'mobile');
      const good = readFileSync(join(mobile, 'test', 'fixtures', 'merged-release-manifest.xml'), 'utf8');
      const dir = mkdtempSync(join(tmpdir(), 'negative-control-'));
      const planted = join(dir, 'AndroidManifest.xml');
      writeFileSync(
        planted,
        good.replace(
          '<queries>',
          '<uses-permission android:name="android.permission.READ_CONTACTS" /><queries>',
        ),
      );
      try {
        const result = await runNode(
          [
            join(mobile, 'scripts', 'check-android-manifest.ts'),
            planted,
            '--application-id',
            'pk.sentryops.guard.staging',
          ],
          { quiet: true },
        );
        return { ...result, failed: result.code !== 0 };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  // Review L-18: the checks that had no control.
  {
    name: 'retention_worker policy without the organization → the role test (ADV-T06) must fail',
    expect: /× .*ADV-T06 every policy retention_worker is under/,
    run: vitest('db', 'test/rls.test.ts', 'retention-policy-unscoped'),
  },
  {
    name: 'a new grant to system_worker → the role test (ADV-T06) must fail',
    expect: /× .*ADV-T06 system_worker only reads/,
    run: vitest('db', 'test/rls.test.ts', 'system-worker-grant-added'),
  },
  // Fable pass 2: the checks pass 2 found without a control.
  {
    name: 'app_runtime may update a whole quarantined item → the schema linter (ADV-X01) must fail',
    expect: /× .*ADV-X01 the migrated schema/,
    run: vitest('db', 'test/schema-lint.test.ts', 'runtime-update-widened'),
  },
  {
    name: 'the response check switched off → the ADV-X05 spread-row test must fail',
    expect: /× .*ADV-X05 a handler that sends a coordinate its schema does not declare/,
    run: mutated(
      'apps/api/src/routes/registry.ts',
      "if (deps.config.NODE_ENV !== 'production' && result !== reply && !reply.sent) {",
      'if (false) {',
      'api',
      'test/route-registry.test.ts',
    ),
  },
  {
    name: 'an SOS refused below the minimum app version → the version-gate test (INV-15) must fail',
    expect:
      /× .*new work is refused with 426; the config, queued uploads, crash reports and an SOS still go through/,
    run: mutated(
      'apps/api/src/app-version.ts',
      "const accepted = policy.appVersion === 'upload' || policy.sos === true;",
      "const accepted = policy.appVersion === 'upload';",
      'api',
      'test/app-version.test.ts',
    ),
  },
  {
    name: 'SOS routes back on the shared pool → the SOS capacity test (INV-15, L-27) must fail',
    expect: /× .*INV-15 an SOS is received while every other connection is taken/,
    run: mutated(
      'apps/api/src/routes/registry.ts',
      'route.policy.sos && appDeps.sos ?',
      'false && appDeps.sos ?',
      'api',
      'test/sos-capacity.test.ts',
    ),
  },
  {
    name: 'an untagged coordinate in a response schema → the ADV-X05 meta-test must fail',
    expect: /× .*ADV-X05 every route returning guard coordinates/,
    run: vitest('api', 'test/route-registry.test.ts', 'untagged-coordinate'),
  },
  {
    name: 'phone numbers dropped from log redaction → the logger test (SEC §15) must fail',
    expect: /× .*SEC §15 the logger redacts/,
    run: vitest('api', 'test/logger.test.ts', 'redaction-dropped'),
  },
  {
    name: 'dangerouslySetInnerHTML planted in the dashboard → lint (ADV-W01) must fail',
    expect: /User-supplied text must render as text/,
    run: lintPlanted(
      join(ROOT, 'apps', 'web', 'components', '__negative_control__.tsx'),
      'export const Planted = ({ text }: { text: string }) => <div dangerouslySetInnerHTML={{ __html: text }} />;\n',
    ),
  },
  {
    name: 'raw SQL planted in a route → lint (ARCH §4.2) must fail',
    expect: /Raw SQL lives in packages\/db or a repository/,
    run: lintPlanted(
      join(ROOT, 'apps', 'api', 'src', 'routes', '__negative_control__.ts'),
      "import { sql } from 'kysely';\n\nexport const planted = sql`select 1`;\n",
    ),
  },
  {
    name: 'the audit endpoint answers with an error → the dependency audit (SEC §14) must fail',
    expect: /could not read the audit report \(ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS\)/,
    run: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'negative-control-'));
      const report = join(dir, 'audit.json');
      // What pnpm prints, exit code 0, when the registry has no audit endpoint (review L-10).
      writeFileSync(report, '{"error":{"code":"ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS"}}\n');
      try {
        const result = await runNode([join(ROOT, 'scripts', 'audit-deps.ts'), '--report', report], {
          quiet: true,
        });
        return { ...result, failed: result.code !== 0 };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
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
