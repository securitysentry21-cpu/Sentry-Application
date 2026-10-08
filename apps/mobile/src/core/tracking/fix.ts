// Turning what the location library reports into the contract's `fix` (packages/contracts geo +
// fixSchema), honestly: an accuracy the platform did not report stays null (the server flags it
// ACCURACY_UNKNOWN), and invalid optional readings are left out rather than invented (SEC §8).
import type { Fix } from '@sentryops/contracts';

/** A location reading as the platform delivered it (expo-location's LocationObject, flattened). */
export type RawFix = {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyM: number | null;
  readonly altitudeM: number | null;
  readonly speedMps: number | null;
  readonly headingDeg: number | null;
  /** When the fix was taken, ms since the epoch, as the platform stamped it. */
  readonly timestampMs: number;
  /** Android: Location.isMock(). Undefined where the platform does not say. */
  readonly mocked?: boolean | undefined;
};

export type Provider = NonNullable<Fix['provider']>;

/** Beyond this the fix timestamp is not trusted to back-date an item (see `captureAgeMs`). */
export const MAX_TRUSTED_FIX_AGE_MS = 10 * 60_000;

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * How long ago (by the phone's clock) the fix was taken. Platforms stamp fixes with their own time
 * source (GPS time can differ from a wrong phone clock), so an age that is negative or larger than
 * 10 minutes is not trusted and counts as 0: the item is then stamped at callback time.
 */
export function captureAgeMs(fix: Pick<RawFix, 'timestampMs'>, wallNowMs: number): number {
  const age = wallNowMs - fix.timestampMs;
  return finite(age) && age >= 0 && age <= MAX_TRUSTED_FIX_AGE_MS ? age : 0;
}

export function isPlausibleCoordinate(fix: Pick<RawFix, 'latitude' | 'longitude'>): boolean {
  return (
    finite(fix.latitude) &&
    finite(fix.longitude) &&
    Math.abs(fix.latitude) <= 90 &&
    Math.abs(fix.longitude) <= 180 &&
    !(fix.latitude === 0 && fix.longitude === 0)
  );
}

/**
 * The contract fix. `fixAgeS` is set for on-demand fixes attached to an action (start, end, scan,
 * incident), where the server checks freshness (shift.startMaxFixAgeSeconds).
 */
export function toContractFix(raw: RawFix, options: { provider?: Provider; fixAgeS?: number } = {}): Fix {
  const fix: {
    lat: number;
    lon: number;
    accuracyM: number | null;
    altitudeM?: number;
    speedMps?: number;
    headingDeg?: number;
    isMock?: boolean;
    provider?: Provider;
    fixAgeS?: number;
  } = {
    lat: raw.latitude,
    lon: raw.longitude,
    accuracyM: finite(raw.accuracyM) && raw.accuracyM > 0 ? raw.accuracyM : null,
  };
  if (finite(raw.altitudeM) && raw.altitudeM >= -500 && raw.altitudeM <= 10_000)
    fix.altitudeM = raw.altitudeM;
  if (finite(raw.speedMps) && raw.speedMps >= 0) fix.speedMps = raw.speedMps;
  if (finite(raw.headingDeg) && raw.headingDeg >= 0 && raw.headingDeg < 360) fix.headingDeg = raw.headingDeg;
  if (typeof raw.mocked === 'boolean') fix.isMock = raw.mocked;
  if (options.provider) fix.provider = options.provider;
  if (options.fixAgeS !== undefined && finite(options.fixAgeS) && options.fixAgeS >= 0) {
    fix.fixAgeS = Math.round(options.fixAgeS * 10) / 10;
  }
  return fix;
}

/** Great-circle distance in metres (WGS-84 mean radius; fine for the few-km scales here). */
export function distanceM(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The best of several readings collected for an on-demand fix (PROD §8.2: wait up to 10 s for good
 * accuracy, then take the best): the most accurate, newest on ties; readings with unknown accuracy
 * only when nothing else came.
 */
export function bestFix(readings: readonly RawFix[]): RawFix | null {
  let best: RawFix | null = null;
  for (const r of readings) {
    if (!isPlausibleCoordinate(r)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const ra = finite(r.accuracyM) && r.accuracyM > 0 ? r.accuracyM : Number.POSITIVE_INFINITY;
    const ba = finite(best.accuracyM) && best.accuracyM > 0 ? best.accuracyM : Number.POSITIVE_INFINITY;
    if (ra < ba || (ra === ba && r.timestampMs > best.timestampMs)) best = r;
  }
  return best;
}
