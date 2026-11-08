// ADV-X08: checks the merged release manifest of the generated Android project, or one manifest file.
//   node apps/mobile/scripts/check-android-manifest.ts apps/mobile/android
//   node apps/mobile/scripts/check-android-manifest.ts some/AndroidManifest.xml --application-id pk.sentryops.guard
// Exit 0 only when a merged manifest was found and it matches (android-manifest.ts). Finding none is a
// failure, never a pass. In CI it runs after `expo prebuild` and Gradle's :app:processReleaseManifest.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { checkMergedManifest, grantedPermissions, parseManifest, releaseRules } from './android-manifest.ts';

const args = process.argv.slice(2);
const flag = args.indexOf('--application-id');
const applicationIdFlag = flag >= 0 ? args[flag + 1] : undefined;
const target = args.find((a, i) => !a.startsWith('--') && !(flag >= 0 && i === flag + 1));

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (!target)
  fail(
    'usage: check-android-manifest.ts <android project directory | AndroidManifest.xml> [--application-id <id>]',
  );
if (!existsSync(target)) fail(`${target} does not exist`);

let manifest: string;
let applicationId = applicationIdFlag;
if (statSync(target).isDirectory()) {
  if (!applicationId) {
    const gradle = readFileSync(join(target, 'app', 'build.gradle'), 'utf8');
    applicationId = /applicationId\s+['"]([^'"]+)['"]/.exec(gradle)?.[1];
    if (!applicationId) fail('no applicationId in app/build.gradle');
  }
  const intermediates = join(target, 'app', 'build', 'intermediates');
  const found = walk(intermediates)
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => p.endsWith('/AndroidManifest.xml'));
  // The final merged manifest first; the one before the last adjustments if Gradle names it differently.
  manifest =
    found.find((p) => /\/merged_manifests\/release\//.test(p)) ??
    found.find((p) => /\/merged_manifest\/release\//.test(p)) ??
    fail(
      `no merged release manifest under ${intermediates}. Run :app:processReleaseManifest first. Manifests found: ${found.length === 0 ? 'none' : found.join(', ')}`,
    );
} else {
  if (!applicationId) fail('a manifest file needs --application-id');
  manifest = target;
}

const xml = readFileSync(manifest, 'utf8');
console.log(`checking ${manifest} for ${applicationId}`);
console.log(`permissions in it: ${grantedPermissions(parseManifest(xml)).join(', ') || 'none'}`);
const problems = checkMergedManifest(xml, releaseRules(applicationId));
if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(`ADV-X08 failed: ${problems.length} problem(s) in the release manifest`);
  process.exit(1);
}
console.log(
  '✓ ADV-X08: the release manifest declares the Play monitoring tool and asks for exactly the allow-listed permissions',
);
