// Which location readings become LOCATION items (PROD §8.2), from location alone, with no motion
// permission:
//
//   moving       a point every `movingDistanceFilterM` (20 m), no more than one per `minIntervalS`
//                (15 s), at least one per `maxIntervalS` (60 s)
//   stationary   one point every `stationaryFixIntervalS` (5 min)
//
// The phone is stationary when its fixes stay within max(20 m, accuracy) of one point for 2 minutes,
// and moving again on the first fix more than 20 m from that point. Fixes worse than 100 m are still
// recorded on the time rules (the server flags them) but never change moving/stationary.
// The location library may call back more often than this; the sampler keeps data within the
// guards' own mobile-data budget (ARCH §8.10).
import type { MobileConfig } from '@sentryops/contracts';

import { distanceM, isPlausibleCoordinate, type RawFix } from './fix.ts';

export type SamplerSettings = Pick<
  MobileConfig['tracking'],
  'movingDistanceFilterM' | 'minIntervalS' | 'maxIntervalS' | 'stationaryFixIntervalS'
>;

export type SamplerState = {
  readonly mode: 'MOVING' | 'STATIONARY';
  readonly lastRecorded: { latitude: number; longitude: number; atMs: number } | null;
  /** The point fixes have stayed near, and since when (for the 2-minute stationary rule). */
  readonly anchor: { latitude: number; longitude: number; sinceMs: number } | null;
};

export const STATIONARY_AFTER_MS = 120_000;
export const STATIONARY_RADIUS_M = 20;
export const MODE_ACCURACY_LIMIT_M = 100;

export const initialSamplerState: SamplerState = { mode: 'MOVING', lastRecorded: null, anchor: null };

/** Decides about one reading. `atMs` is the reading's capture time on the phone's clock. */
export function sample(
  state: SamplerState,
  fix: RawFix,
  atMs: number,
  settings: SamplerSettings,
): { record: boolean; state: SamplerState } {
  if (!isPlausibleCoordinate(fix)) return { record: false, state };
  const point = { latitude: fix.latitude, longitude: fix.longitude };
  const usableForMode = fix.accuracyM !== null && fix.accuracyM <= MODE_ACCURACY_LIMIT_M;

  // 1. Moving or stationary.
  let { mode, anchor } = state;
  if (usableForMode) {
    const radius = Math.max(STATIONARY_RADIUS_M, fix.accuracyM ?? 0);
    if (anchor && distanceM(anchor, point) <= radius) {
      if (mode === 'MOVING' && atMs - anchor.sinceMs >= STATIONARY_AFTER_MS) mode = 'STATIONARY';
    } else {
      if (anchor && mode === 'STATIONARY' && distanceM(anchor, point) > STATIONARY_RADIUS_M) mode = 'MOVING';
      anchor = { ...point, sinceMs: atMs };
    }
  }

  // 2. Record?
  const last = state.lastRecorded;
  let record: boolean;
  if (!last) {
    record = true;
  } else {
    const elapsedMs = atMs - last.atMs;
    if (elapsedMs < settings.minIntervalS * 1_000) {
      record = false;
    } else if (mode === 'STATIONARY') {
      record = elapsedMs >= settings.stationaryFixIntervalS * 1_000;
    } else {
      record =
        elapsedMs >= settings.maxIntervalS * 1_000 ||
        (usableForMode && distanceM(last, point) >= settings.movingDistanceFilterM);
    }
  }

  return {
    record,
    state: { mode, anchor, lastRecorded: record ? { ...point, atMs } : last },
  };
}
