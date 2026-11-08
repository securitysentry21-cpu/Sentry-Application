// The guard app's version against the minimum and the revoked list (ARCH §15.2, INV-15). The app
// sends its version in X-App-Version on every request. This protects against honest old builds: a
// client that leaves the header out or lies cannot be told apart from a new one, and is not the
// threat a revocation is for (a released build with a known flaw).
import type { RoutePolicy } from '@sentryops/contracts';

import type { Config } from './config.ts';
import { AppError } from './errors.ts';

/** Compares dotted versions numerically ("1.10.0" > "1.9.2"); a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().split(/[.+-]/);
  const pb = b.trim().split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : Number.NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : Number.NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

export type VersionVerdict = 'OK' | 'BELOW_MINIMUM' | 'REVOKED';

export function versionVerdict(
  header: unknown,
  config: Pick<Config, 'MOBILE_MIN_VERSION' | 'MOBILE_REVOKED_VERSIONS'>,
): VersionVerdict {
  if (typeof header !== 'string' || !VERSION.test(header)) return 'OK';
  if (config.MOBILE_REVOKED_VERSIONS.some((v) => compareVersions(v, header) === 0)) return 'REVOKED';
  return compareVersions(header, config.MOBILE_MIN_VERSION) < 0 ? 'BELOW_MINIMUM' : 'OK';
}

/** Throws 426 when this route refuses the version the app announced. */
export function enforceAppVersion(
  header: unknown,
  policy: RoutePolicy,
  config: Pick<Config, 'MOBILE_MIN_VERSION' | 'MOBILE_REVOKED_VERSIONS'>,
): void {
  if (policy.appVersion === 'config') return;
  const verdict = versionVerdict(header, config);
  if (verdict === 'REVOKED') {
    throw new AppError('APP_VERSION_UNSUPPORTED', 'This version of the app was withdrawn. Please update it.');
  }
  const accepted = policy.appVersion === 'upload' || policy.sos === true;
  if (verdict === 'BELOW_MINIMUM' && !accepted) {
    throw new AppError('APP_VERSION_UNSUPPORTED', 'Please update the app.');
  }
}
