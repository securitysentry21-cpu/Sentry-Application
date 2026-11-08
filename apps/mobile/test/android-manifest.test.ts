import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ANDROID_PERMISSIONS, BLOCKED_ANDROID_PERMISSIONS } from '../android-permissions.ts';
import {
  checkMergedManifest,
  dynamicReceiverPermission,
  grantedPermissions,
  MIN_TARGET_SDK,
  parseManifest,
  releaseRules,
} from '../scripts/android-manifest.ts';

const APPLICATION_ID = 'pk.sentryops.guard.staging';
const FIXTURE = new URL('./fixtures/merged-release-manifest.xml', import.meta.url);
const good = readFileSync(FIXTURE, 'utf8');
const rules = releaseRules(APPLICATION_ID);
const check = (xml: string) => checkMergedManifest(xml, rules);

/** The good manifest with one change; fails the test if the change found nothing to change. */
function changed(from: string | RegExp, to: string): string {
  const out = good.replace(from, to);
  expect(out, `the fixture has no ${String(from)}`).not.toBe(good);
  return out;
}
const permission = (name: string) => `    <uses-permission android:name="${name}" />\n`;

describe('release manifest check (ADV-X08)', () => {
  it('ADV-X08 accepts a manifest that declares the Play monitoring tool and asks for exactly the allow-list', () => {
    expect(check(good)).toEqual([]);
    // The allow-list in the fixture is the real one: nothing was copied by hand.
    expect(grantedPermissions(parseManifest(good))).toEqual(
      [
        ...ANDROID_PERMISSIONS,
        'android.permission.INTERNET',
        dynamicReceiverPermission(APPLICATION_ID),
      ].sort(),
    );
  });

  it('ADV-X08 fails a build without the Play monitoring-tool declaration, or with the wrong value', () => {
    const missing = changed(
      /<meta-data\s+android:name="isMonitoringTool"\s+android:value="enterprise_management" \/>/,
      '',
    );
    expect(check(missing).join('\n')).toMatch(/monitoring-tool declaration is missing/);
    const wrong = changed('android:value="enterprise_management"', 'android:value="parental_control"');
    expect(check(wrong).join('\n')).toMatch(/isMonitoringTool is "parental_control"/);
    // In a comment, or outside <application>, it is not a declaration.
    const commented = changed(
      /<meta-data\s+android:name="isMonitoringTool"\s+android:value="enterprise_management" \/>/,
      '<!-- <meta-data android:name="isMonitoringTool" android:value="enterprise_management" /> -->',
    );
    expect(check(commented).join('\n')).toMatch(/declaration is missing/);
    const outside = changed(
      /<meta-data\s+android:name="isMonitoringTool"\s+android:value="enterprise_management" \/>/,
      '',
    ).replace(
      '<application',
      '<meta-data android:name="isMonitoringTool" android:value="enterprise_management" />\n<application',
    );
    expect(check(outside).join('\n')).toMatch(/declaration is missing/);
  });

  it('ADV-X08 fails a permission a library added, naming it, and says when it is one we block', () => {
    const contacts = changed('<queries>', `${permission('android.permission.READ_CONTACTS')}    <queries>`);
    expect(check(contacts)).toEqual([
      expect.stringMatching(/blocked permission android\.permission\.READ_CONTACTS/),
    ]);
    // One that is neither allowed nor blocked is "unexpected": someone has to look at it.
    const calendar = changed('<queries>', `${permission('android.permission.READ_CALENDAR')}    <queries>`);
    expect(check(calendar)).toEqual([
      expect.stringMatching(/unexpected permission android\.permission\.READ_CALENDAR/),
    ]);
    // The older element for permissions that only apply from Android 6, and attribute quotes of either kind.
    const sdk23 = changed(
      '<queries>',
      `    <uses-permission-sdk-23 android:name='android.permission.READ_SMS' />\n    <queries>`,
    );
    expect(check(sdk23).join('\n')).toMatch(/blocked permission android\.permission\.READ_SMS/);
    // Every permission we block is refused, by name.
    for (const name of BLOCKED_ANDROID_PERMISSIONS) {
      const problems = check(changed('<queries>', `${permission(name)}    <queries>`));
      expect(problems.join('\n'), name).toContain(`blocked permission ${name}`);
    }
  });

  it('ADV-X08 fails when a permission the product needs has gone, and ignores merger removal markers', () => {
    const gone = changed(permission('android.permission.FOREGROUND_SERVICE_LOCATION'), '');
    expect(check(gone)).toEqual([
      'required permission android.permission.FOREGROUND_SERVICE_LOCATION is missing from the release manifest',
    ]);
    // Before the merge, a blocked permission is only a marker telling the merger to remove it.
    const marker = changed(
      '<queries>',
      '    <uses-permission android:name="android.permission.RECORD_AUDIO" tools:node="remove" />\n    <queries>',
    ).replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
    expect(check(marker)).toEqual([]);
  });

  it('ADV-X08 fails a build whose location service lacks its foreground type, or that targets too low', () => {
    const noType = changed(
      'android:foregroundServiceType="location"',
      'android:foregroundServiceType="camera"',
    );
    expect(check(noType).join('\n')).toMatch(/no foregroundServiceType="location"/);
    const noService = changed(/<service[\s\S]*?\/>/, '');
    expect(check(noService).join('\n')).toMatch(/LocationTaskService\) is not declared/);
    expect(
      check(
        changed(
          `android:targetSdkVersion="${MIN_TARGET_SDK}"`,
          `android:targetSdkVersion="${MIN_TARGET_SDK - 1}"`,
        ),
      ).join('\n'),
    ).toMatch(/targetSdkVersion is 35; Google Play requires 36/);
    expect(check(changed(/<uses-sdk[\s\S]*?\/>/, '')).join('\n')).toMatch(/targetSdkVersion cannot be read/);
  });

  it('ADV-X08 fails a build that allows cloud backups or plain HTTP', () => {
    expect(check(changed('android:allowBackup="false"', 'android:allowBackup="true"')).join('\n')).toMatch(
      /allowBackup/,
    );
    expect(check(changed('android:allowBackup="false"', '')).join('\n')).toMatch(/allowBackup/);
    expect(
      check(
        changed(
          'android:allowBackup="false"',
          'android:allowBackup="false" android:usesCleartextTraffic="true"',
        ),
      ).join('\n'),
    ).toMatch(/usesCleartextTraffic/);
  });

  it('ADV-X08 fails a file that is not a manifest, so an empty file is never a pass', () => {
    for (const nothing of ['', '   ', '<html><body>404</body></html>']) {
      expect(check(nothing)).toEqual(['the file is not an Android manifest (no <manifest> root)']);
    }
  });

  it('ADV-X08 the command exits 1 for a bad manifest and 0 for a good one, and never passes without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adv-x08-'));
    try {
      const command = fileURLToPath(new URL('../scripts/check-android-manifest.ts', import.meta.url));
      const run = (file: string, ...extra: string[]) =>
        spawnSync(process.execPath, [command, file, ...extra], { encoding: 'utf8' });
      const goodFile = join(dir, 'good.xml');
      const badFile = join(dir, 'bad.xml');
      writeFileSync(goodFile, good);
      writeFileSync(
        badFile,
        changed('<queries>', `${permission('android.permission.READ_CONTACTS')}    <queries>`),
      );
      const ok = run(goodFile, '--application-id', APPLICATION_ID);
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('✓ ADV-X08');
      const bad = run(badFile, '--application-id', APPLICATION_ID);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('android.permission.READ_CONTACTS');
      // A project directory with no merged manifest is a failure, not a pass.
      expect(run(dir, '--application-id', APPLICATION_ID).status).toBe(1);
      expect(run(join(dir, 'missing.xml'), '--application-id', APPLICATION_ID).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
