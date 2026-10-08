// Build-time and server-delivered configuration.
//
// - The build variant and API origin come from app.config.ts (APP_VARIANT, EXPO_PUBLIC_API_BASE_URL)
//   and are checked again here at runtime: staging and production must use HTTPS, and only
//   development may use plain HTTP (SEC §11: debug and staging builds cannot point at production;
//   TLS only outside development).
// - Tracking, sync and shift settings come from GET /mobile/config (ARCH §15.2). Until the first
//   successful fetch the phone uses the product defaults (PROD Appendix B) with every optional
//   feature off, and any value from the server is clamped to sane bounds so a bad setting can never
//   stop the phone from tracking or uploading.
import { MAX_BATCH_ITEMS, type MobileConfig } from '@sentryops/contracts';

export const APP_VARIANTS = ['development', 'staging', 'production'] as const;
export type AppVariant = (typeof APP_VARIANTS)[number];

export type RuntimeConfig = { readonly variant: AppVariant; readonly apiBaseUrl: string };

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Validates what app.config.ts embedded (`extra.sentry`). Throws ConfigError; never guesses. */
export function validateRuntimeConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError('missing app configuration');
  const { variant, apiBaseUrl } = raw as { variant?: unknown; apiBaseUrl?: unknown };
  if (typeof variant !== 'string' || !(APP_VARIANTS as readonly string[]).includes(variant)) {
    throw new ConfigError('unknown app variant');
  }
  if (typeof apiBaseUrl !== 'string') throw new ConfigError('missing API base URL');
  return { variant: variant as AppVariant, apiBaseUrl: checkApiOrigin(apiBaseUrl, variant as AppVariant) };
}

/** An API origin: scheme, host and optional port, nothing else. */
export function checkApiOrigin(value: string, variant: AppVariant): string {
  const match = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?\/?$/.exec(value.trim());
  if (!match) throw new ConfigError('the API base URL must be an origin such as https://api.example.com');
  const [, scheme, host, port] = match;
  if (scheme === 'http' && variant !== 'development') {
    throw new ConfigError(`${variant} builds must use HTTPS`);
  }
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535))
    throw new ConfigError('invalid port');
  return `${scheme}://${host}${port === undefined ? '' : `:${port}`}`;
}

// ── Server settings ──────────────────────────────────────────────────────────────────────────

export type EffectiveSettings = Pick<MobileConfig, 'tracking' | 'sync' | 'shift' | 'features'>;

/** PROD Appendix B defaults, used before the first GET /mobile/config. Features stay off. */
export const DEFAULT_SETTINGS: EffectiveSettings = {
  tracking: {
    movingDistanceFilterM: 20,
    minIntervalS: 15,
    maxIntervalS: 60,
    stationaryFixIntervalS: 300,
    sosIntervalS: 10,
  },
  sync: {
    uploadIntervalS: 60,
    heartbeatIntervalS: 60,
    maxOfflineAgeHours: 168,
    maxBatchItems: MAX_BATCH_ITEMS,
  },
  shift: {
    earliestStartMinutes: 30,
    autoEndAfterMinutes: 60,
    startMaxFixAgeSeconds: 120,
    requireBackgroundPermission: 'BLOCK',
  },
  features: { sos: false, patrols: false, incidents: false },
};

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.round(value), min), max) : min;

export function effectiveSettings(config: MobileConfig | null): EffectiveSettings {
  if (!config) return DEFAULT_SETTINGS;
  const t = config.tracking;
  const s = config.sync;
  const minIntervalS = clamp(t.minIntervalS, 5, 300);
  const maxIntervalS = clamp(t.maxIntervalS, minIntervalS, 900);
  return {
    tracking: {
      movingDistanceFilterM: clamp(t.movingDistanceFilterM, 5, 500),
      minIntervalS,
      maxIntervalS,
      stationaryFixIntervalS: clamp(t.stationaryFixIntervalS, maxIntervalS, 3_600),
      sosIntervalS: clamp(t.sosIntervalS, 5, 60),
    },
    sync: {
      uploadIntervalS: clamp(s.uploadIntervalS, 15, 900),
      heartbeatIntervalS: clamp(s.heartbeatIntervalS, 15, 900),
      maxOfflineAgeHours: clamp(s.maxOfflineAgeHours, 1, 24 * 30),
      maxBatchItems: clamp(s.maxBatchItems, 1, MAX_BATCH_ITEMS),
    },
    shift: {
      earliestStartMinutes: clamp(config.shift.earliestStartMinutes, 0, 24 * 60),
      autoEndAfterMinutes: clamp(config.shift.autoEndAfterMinutes, 0, 24 * 60),
      startMaxFixAgeSeconds: clamp(config.shift.startMaxFixAgeSeconds, 10, 3_600),
      requireBackgroundPermission: config.shift.requireBackgroundPermission,
    },
    features: config.features,
  };
}

// ── App version gate (ARCH §15.2) ────────────────────────────────────────────────────────────

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

export type VersionGate = 'OK' | 'UPDATE_RECOMMENDED' | 'UPDATE_REQUIRED' | 'REVOKED';

/**
 * REVOKED (a version withdrawn for security): nothing more is accepted, SOS included (INV-15's only
 * exception). UPDATE_REQUIRED (below the minimum): no new shifts, but already-captured data and SOS
 * still go up (ARCH §15.2).
 */
export function versionGate(
  appVersion: string,
  config: Pick<MobileConfig, 'minSupportedVersion' | 'recommendedVersion' | 'revokedVersions'> | null,
): VersionGate {
  if (!config) return 'OK';
  if (config.revokedVersions.some((v) => compareVersions(v, appVersion) === 0)) return 'REVOKED';
  if (compareVersions(appVersion, config.minSupportedVersion) < 0) return 'UPDATE_REQUIRED';
  if (compareVersions(appVersion, config.recommendedVersion) < 0) return 'UPDATE_RECOMMENDED';
  return 'OK';
}
