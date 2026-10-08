// Tracking rules shared by the API, the dashboard and the app (ARCH §8.7, §10; D-36; INV-07, INV-09).

// ── Freshness: two separate signals, never merged (D-36) ────────────────────────────────────

export type TrackingHealth = 'LIVE' | 'DELAYED' | 'OFFLINE';
export type LocationAge = 'CURRENT' | 'LAST_KNOWN' | 'UNKNOWN';

export type FreshnessSettings = {
  /** freshness.health_live_max_s (default 90). */
  readonly healthLiveMaxS: number;
  /** freshness.offline_after_s (default 300). */
  readonly offlineAfterS: number;
  /** freshness.location_current_max_s (default 150). */
  readonly locationCurrentMaxS: number;
};

/** When the server last heard from the phone — heartbeat, status or point (PROD §8.3). */
export function trackingHealth(now: Date, lastContactAt: Date | null, s: FreshnessSettings): TrackingHealth {
  if (!lastContactAt) return 'OFFLINE';
  const age = (now.getTime() - lastContactAt.getTime()) / 1000;
  if (age <= s.healthLiveMaxS) return 'LIVE';
  if (age <= s.offlineAfterS) return 'DELAYED';
  return 'OFFLINE';
}

/** When the newest usable fix was captured. A last-known location is never current (INV-09). */
export function locationAge(now: Date, lastFixCapturedAt: Date | null, s: FreshnessSettings): LocationAge {
  if (!lastFixCapturedAt) return 'UNKNOWN';
  return (now.getTime() - lastFixCapturedAt.getTime()) / 1000 <= s.locationCurrentMaxS
    ? 'CURRENT'
    : 'LAST_KNOWN';
}

// ── Capture time (ARCH §8.7) ────────────────────────────────────────────────────────────────

export type ClockStatus = 'VERIFIED_MONOTONIC' | 'DEVICE_CLOCK_ONLY' | 'SKEWED';

export type CaptureEstimate = {
  readonly capturedAt: Date;
  readonly clockStatus: ClockStatus;
  /** SKEWED_CLOCK when the phone's wall clock and the estimate disagree by more than 120 s. */
  readonly flags: readonly string[];
};

const SKEW_LIMIT_MS = 120_000;

/**
 * Same boot (the batch and the item share `bootId`): captured = received − (sentMono − itemMono),
 * which needs no trust in the phone's wall clock. Otherwise the phone's clock is all we have. The
 * estimate is never later than receipt: nothing is stored as happening in the future (ADV-L03).
 */
export function estimateCapture(input: {
  readonly receivedAt: Date;
  readonly recordedAt: Date;
  readonly itemMonoMs: number;
  readonly batchSentMonoMs: number;
  readonly sameBoot: boolean;
}): CaptureEstimate {
  const flags: string[] = [];
  let capturedMs: number;
  let clockStatus: ClockStatus;
  const elapsed = input.batchSentMonoMs - input.itemMonoMs;
  if (input.sameBoot && elapsed >= 0) {
    capturedMs = input.receivedAt.getTime() - elapsed;
    clockStatus = 'VERIFIED_MONOTONIC';
  } else {
    capturedMs = input.recordedAt.getTime();
    clockStatus = 'DEVICE_CLOCK_ONLY';
  }
  if (capturedMs > input.receivedAt.getTime()) capturedMs = input.receivedAt.getTime();
  if (Math.abs(input.recordedAt.getTime() - capturedMs) > SKEW_LIMIT_MS) {
    flags.push('SKEWED_CLOCK');
    if (clockStatus === 'DEVICE_CLOCK_ONLY') clockStatus = 'SKEWED';
  }
  return { capturedAt: new Date(capturedMs), clockStatus, flags };
}

/** ARCH §9.2 step 5: a point belongs to the shift if captured from start − 60 s to (end or now) + 60 s. */
export function inShiftWindow(
  capturedAt: Date,
  startedAt: Date | null,
  endedAt: Date | null,
  now: Date,
): boolean {
  if (!startedAt) return false;
  const tolerance = 60_000;
  const end = (endedAt ?? now).getTime() + tolerance;
  return capturedAt.getTime() >= startedAt.getTime() - tolerance && capturedAt.getTime() <= end;
}
