// ADV-X08: what the guard app's release AndroidManifest.xml must say once Gradle has merged every
// library's manifest into ours. A library can add a permission, drop a declaration or lower the target
// level without touching our code, and the config's own lists (android-permissions.ts) cannot see
// that: only the merged file shows what ships. CI builds it and runs this (check-android-manifest.ts,
// .github/workflows/ci.yml › android-manifest). Pure on purpose: text in, problems out.
import { ANDROID_PERMISSIONS, BLOCKED_ANDROID_PERMISSIONS } from '../android-permissions.ts';

/** Added to every build by React Native itself, not by a choice of ours. */
export const BASELINE_PERMISSIONS = ['android.permission.INTERNET'] as const;

/** AndroidX adds this signature-level permission, named after the app, to guard its own receivers. */
export const dynamicReceiverPermission = (applicationId: string): string =>
  `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`;

/**
 * Google Play requires new apps and updates to target API 36 since 31 Aug 2026 (EXT-06, verified
 * 2026-10-08). The deadline moves every year: raise this when it does.
 */
export const MIN_TARGET_SDK = 36;

export type ManifestRules = {
  readonly applicationId: string;
  /** Exactly the permissions the product asks for: each must be present. */
  readonly required: readonly string[];
  /** Permissions the platform adds to every build: allowed, not required. */
  readonly baseline: readonly string[];
  /** Named in the message when a library brings one in. */
  readonly blocked: readonly string[];
  readonly minTargetSdk: number;
};

export function releaseRules(applicationId: string): ManifestRules {
  return {
    applicationId,
    required: ANDROID_PERMISSIONS,
    baseline: [...BASELINE_PERMISSIONS, dynamicReceiverPermission(applicationId)],
    blocked: BLOCKED_ANDROID_PERMISSIONS,
    minTargetSdk: MIN_TARGET_SDK,
  };
}

export type ManifestElement = {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  /** The names of the elements it sits in, outermost first: ['manifest', 'application']. */
  readonly path: readonly string[];
};

const TAG = /<(\/?)([A-Za-z][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A small reader for the shape of an Android manifest; comments and declarations are dropped first. */
export function parseManifest(xml: string): ManifestElement[] {
  const text = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  const elements: ManifestElement[] = [];
  const open: string[] = [];
  for (const match of text.matchAll(TAG)) {
    const [, closing = '', name = '', rawAttributes = '', selfClosing = ''] = match;
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at >= 0) open.length = at;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attribute of rawAttributes.matchAll(ATTRIBUTE)) {
      attrs[attribute[1] ?? ''] = attribute[2] ?? attribute[3] ?? '';
    }
    elements.push({ name, attrs, path: [...open] });
    if (!selfClosing) open.push(name);
  }
  return elements;
}

const NAME = 'android:name';

/** What the merged release manifest grants the app, by permission name. */
export function grantedPermissions(elements: readonly ManifestElement[]): string[] {
  const names = new Set<string>();
  for (const e of elements) {
    if (e.path.join('/') !== 'manifest') continue;
    if (e.name !== 'uses-permission' && e.name !== 'uses-permission-sdk-23') continue;
    // A removal marker (tools:node="remove") is the merger's instruction, not a request.
    if (e.attrs['tools:node'] === 'remove' || e.attrs['tools:node'] === 'removeAll') continue;
    const name = e.attrs[NAME];
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** Every way the merged manifest differs from what we ship. An empty list means it matches. */
export function checkMergedManifest(xml: string, rules: ManifestRules): string[] {
  const elements = parseManifest(xml);
  if (elements[0]?.name !== 'manifest') return ['the file is not an Android manifest (no <manifest> root)'];
  const problems: string[] = [];
  const inApplication = (e: ManifestElement) => e.path.join('/') === 'manifest/application';

  // 1. Google Play's monitoring-tool declaration (EXT-20): in every build of every track.
  const declarations = elements.filter(
    (e) => e.name === 'meta-data' && inApplication(e) && e.attrs[NAME] === 'isMonitoringTool',
  );
  if (declarations.length === 0) {
    problems.push(
      'the Play monitoring-tool declaration is missing: <application> needs <meta-data isMonitoringTool = enterprise_management> (EXT-20)',
    );
  }
  for (const d of declarations) {
    if (d.attrs['android:value'] !== 'enterprise_management') {
      problems.push(
        `isMonitoringTool is "${d.attrs['android:value'] ?? ''}", not "enterprise_management" (EXT-20)`,
      );
    }
  }

  // 2. Permissions: exactly the allow-list, plus what the platform adds.
  const granted = grantedPermissions(elements);
  const allowed = new Set([...rules.required, ...rules.baseline]);
  const blocked = new Set(rules.blocked);
  for (const name of granted) {
    if (allowed.has(name)) continue;
    problems.push(
      blocked.has(name)
        ? `blocked permission ${name} is in the release manifest: a library added it (SEC §11)`
        : `unexpected permission ${name} is in the release manifest: a library added it. Review it, then block it or add it to android-permissions.ts with its reason (SEC §11)`,
    );
  }
  for (const name of rules.required) {
    if (!granted.includes(name))
      problems.push(`required permission ${name} is missing from the release manifest`);
  }

  // 3. The location foreground service declares its type; Android 14 refuses to start it otherwise (EXT-31).
  const service = elements.find(
    (e) => e.name === 'service' && inApplication(e) && (e.attrs[NAME] ?? '').endsWith('LocationTaskService'),
  );
  if (!service) {
    problems.push("the location foreground service (expo-location's LocationTaskService) is not declared");
  } else if (!(service.attrs['android:foregroundServiceType'] ?? '').split('|').includes('location')) {
    problems.push('the location foreground service has no foregroundServiceType="location" (EXT-31)');
  }

  // 4. The target level Google Play requires (EXT-06).
  const target = Number(elements.find((e) => e.name === 'uses-sdk')?.attrs['android:targetSdkVersion']);
  if (!Number.isInteger(target)) {
    problems.push('targetSdkVersion cannot be read from the release manifest');
  } else if (target < rules.minTargetSdk) {
    problems.push(
      `targetSdkVersion is ${target}; Google Play requires ${rules.minTargetSdk} or higher (EXT-06)`,
    );
  }

  // 5. Backups and plain HTTP stay off (SEC §11, app.config.ts: location queues and the device
  // identity never reach a cloud backup).
  const application = elements.find((e) => e.name === 'application' && e.path.join('/') === 'manifest');
  if (application?.attrs['android:allowBackup'] !== 'false') {
    problems.push(
      'android:allowBackup must be "false": the outbox and the device key must never reach a cloud backup',
    );
  }
  if (application?.attrs['android:usesCleartextTraffic'] === 'true') {
    problems.push(
      'android:usesCleartextTraffic is "true" in a release build: TLS only outside development (SEC §11)',
    );
  }
  return problems;
}
