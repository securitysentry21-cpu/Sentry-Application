// Patrol rules (PROD §9, ARCH §11.2–§11.3), pure: the verdict on one checkpoint scan, the schedule
// of a route's runs inside a shift, and a run's progress. The API applies them inside its
// transactions; these functions decide.
import { haversineM, type Point } from './geo.ts';

export const SCAN_OUTCOMES = [
  'VERIFIED',
  'LOCATION_UNCONFIRMED',
  'OUTSIDE_RADIUS',
  'WRONG_SITE',
  'INVALID_QR',
  'NO_ACTIVE_SHIFT',
  'DUPLICATE',
] as const;
export type ScanOutcome = (typeof SCAN_OUTCOMES)[number];

/** Why a valid scan's location could not be confirmed (LOCATION_UNCONFIRMED). */
export type UnconfirmedReason =
  'NO_CHECKPOINT_POSITION' | 'NO_FIX' | 'STALE_FIX' | 'MOCK_LOCATION' | 'LOW_ACCURACY' | 'NEAR_EDGE';

export type ScanSettings = {
  readonly maxFixAgeS: number; // checkpoint.max_fix_age_s (30)
  readonly maxUsableAccuracyM: number; // checkpoint.max_usable_accuracy_m (50)
  readonly maxPlausibleSpeedMps: number; // checkpoint.max_plausible_speed_mps (15)
  readonly countUnconfirmed: boolean; // patrol.count_unconfirmed_as_completed (true, D-17)
  readonly treatMockAsUnconfirmed: boolean; // patrol.treat_mock_as_unconfirmed (true)
};

export type ScanFix = {
  readonly lat: number;
  readonly lng: number;
  /** Metres; null when the phone didn't report it. */
  readonly accuracyM: number | null;
  /** Seconds between the fix and the scan; null when unknown (treated as fresh). */
  readonly fixAgeS: number | null;
  readonly isMock: boolean;
};

export type ScanInput = {
  /** The label's checkpoint, or null when it is not one of the organization's active checkpoints. */
  readonly checkpoint: {
    readonly siteId: string;
    readonly location: Point | null;
    readonly radiusM: number;
  } | null;
  /** The guard's shift whose window holds the scan's capture time; null when there is none. */
  readonly shift: { readonly siteId: string } | null;
  /** The same checkpoint already counted in the same run (or shift) within the duplicate window. */
  readonly duplicate: boolean;
  readonly fix: ScanFix | null;
  readonly scannedAtMs: number;
  /** The previous counting visit in the shift, for travel plausibility. */
  readonly previous: { readonly scannedAtMs: number; readonly location: Point | null } | null;
  /** Enforced order only: a required checkpoint earlier in the route is not yet counted in the run. */
  readonly outOfOrder: boolean;
  /** From ingestion, e.g. SKEWED_CLOCK from the capture-time estimate. */
  readonly flags?: readonly string[];
};

export type ScanVerdict = {
  readonly outcome: ScanOutcome;
  readonly counted: boolean;
  readonly reason: UnconfirmedReason | null;
  /** Metres from the checkpoint, rounded; null without a fix or a checkpoint position. */
  readonly distanceM: number | null;
  readonly flags: readonly string[];
  /** Mock location or implausible travel: SUSPICIOUS_LOCATION opens (PROD §8.5). */
  readonly suspicious: boolean;
};

const verdict = (outcome: ScanOutcome, flags: Set<string>, rest: Partial<ScanVerdict> = {}): ScanVerdict => ({
  outcome,
  counted: false,
  reason: null,
  distanceM: null,
  suspicious: false,
  ...rest,
  flags: [...flags].sort(),
});

/**
 * ARCH §11.2, in its order: the label, the shift, the site, duplicates, then location evidence.
 * A QR code alone never completes a checkpoint (INV-11): every outcome but VERIFIED and (by the
 * organization's D-17 setting) LOCATION_UNCONFIRMED leaves the run unchanged.
 *
 * Location: a fix clearly outside the radius even allowing for its accuracy is OUTSIDE_RADIUS, also
 * when that accuracy is too poor to verify with (PROD §9.3, ADV-Q02). Only then does poor accuracy
 * make a scan LOCATION_UNCONFIRMED; a stale fix, a fake one (by policy) or a checkpoint without a
 * position always does.
 */
export function verifyScan(input: ScanInput, settings: ScanSettings): ScanVerdict {
  const flags = new Set(input.flags ?? []);
  const { checkpoint, shift, fix } = input;
  if (!checkpoint) return verdict('INVALID_QR', flags);
  if (!shift) return verdict('NO_ACTIVE_SHIFT', flags);
  if (checkpoint.siteId !== shift.siteId) return verdict('WRONG_SITE', flags);
  if (input.duplicate) return verdict('DUPLICATE', flags);

  if (fix?.isMock) flags.add('MOCK_LOCATION');
  const usable = fix !== null && fix.accuracyM !== null && fix.accuracyM <= settings.maxUsableAccuracyM;
  if (fix && !usable) flags.add('LOW_ACCURACY');
  const distanceM = fix && checkpoint.location ? Math.round(haversineM(checkpoint.location, fix)) : null;
  const { outcome, reason } = locate(checkpoint, fix, distanceM, usable, settings);

  // Two scans too far apart for the time between them: the photographed-labels pattern.
  const previous = input.previous;
  if (previous?.location && checkpoint.location) {
    const seconds = Math.max(1, (input.scannedAtMs - previous.scannedAtMs) / 1000);
    if (haversineM(previous.location, checkpoint.location) / seconds > settings.maxPlausibleSpeedMps) {
      flags.add('IMPLAUSIBLE_TRAVEL');
    }
  }

  const counted = outcome === 'VERIFIED' || (outcome === 'LOCATION_UNCONFIRMED' && settings.countUnconfirmed);
  if (counted && input.outOfOrder) flags.add('OUT_OF_ORDER');
  return verdict(outcome, flags, {
    counted,
    reason,
    distanceM,
    suspicious: flags.has('MOCK_LOCATION') || flags.has('IMPLAUSIBLE_TRAVEL'),
  });
}

function locate(
  checkpoint: { readonly location: Point | null; readonly radiusM: number },
  fix: ScanFix | null,
  distanceM: number | null,
  usable: boolean,
  settings: ScanSettings,
): { outcome: 'VERIFIED' | 'OUTSIDE_RADIUS' | 'LOCATION_UNCONFIRMED'; reason: UnconfirmedReason | null } {
  const unconfirmed = (reason: UnconfirmedReason) => ({ outcome: 'LOCATION_UNCONFIRMED' as const, reason });
  if (!checkpoint.location) return unconfirmed('NO_CHECKPOINT_POSITION');
  if (!fix || distanceM === null) return unconfirmed('NO_FIX');
  if (fix.fixAgeS !== null && fix.fixAgeS > settings.maxFixAgeS) return unconfirmed('STALE_FIX');
  if (fix.isMock && settings.treatMockAsUnconfirmed) return unconfirmed('MOCK_LOCATION');
  if (fix.accuracyM !== null && distanceM - fix.accuracyM > checkpoint.radiusM) {
    return { outcome: 'OUTSIDE_RADIUS', reason: null };
  }
  if (!usable) return unconfirmed('LOW_ACCURACY');
  if (distanceM <= checkpoint.radiusM) return { outcome: 'VERIFIED', reason: null };
  return unconfirmed('NEAR_EDGE');
}

export const DISTANCE_BANDS = ['0-50', '50-100', '100-250', '250-500', '500-1000', '1000+'] as const;
export type DistanceBand = (typeof DISTANCE_BANDS)[number];

/** Outside a shift only a band is kept, never a distance (SEC §16.1, INV-08). */
export function distanceBand(metres: number): DistanceBand {
  if (metres <= 50) return '0-50';
  if (metres <= 100) return '50-100';
  if (metres <= 250) return '100-250';
  if (metres <= 500) return '250-500';
  if (metres <= 1000) return '500-1000';
  return '1000+';
}

// ── Runs (PROD §9.2) ─────────────────────────────────────────────────────────────────────────

export type RouteSchedule = {
  readonly intervalMinutes: number;
  readonly firstRunOffsetMinutes: number;
  readonly completionWindowMinutes: number;
};

export type PlannedRun = { readonly sequenceNo: number; readonly dueAt: Date; readonly windowEndsAt: Date };

const MINUTE_MS = 60_000;
/** A 24-hour shift with the shortest interval (10 min) has 144 runs. */
const MAX_RUNS = 200;

/** Run k is due at actual start + offset + k·interval and closes at due + window, while due < end. */
export function runSchedule(schedule: RouteSchedule, startedAt: Date, endsAt: Date): PlannedRun[] {
  const runs: PlannedRun[] = [];
  const first = startedAt.getTime() + schedule.firstRunOffsetMinutes * MINUTE_MS;
  for (let k = 0; k < MAX_RUNS; k++) {
    const due = first + k * schedule.intervalMinutes * MINUTE_MS;
    if (due >= endsAt.getTime()) break;
    runs.push({
      sequenceNo: k + 1,
      dueAt: new Date(due),
      windowEndsAt: new Date(due + schedule.completionWindowMinutes * MINUTE_MS),
    });
  }
  return runs;
}

export const RUN_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'INCOMPLETE',
  'MISSED',
  'CANCELLED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ['PENDING', 'IN_PROGRESS'];

export type RouteStop = {
  readonly checkpointId: string;
  readonly sequence: number;
  readonly required: boolean;
};
export type RunVisit = {
  readonly checkpointId: string;
  readonly outcome: ScanOutcome;
  readonly counted: boolean;
  readonly scannedAtMs: number;
};

export type RunProgress = {
  readonly requiredCount: number;
  /** Required checkpoints counted at least once. */
  readonly countedCount: number;
  /** Of those, the ones counted only by QR-only scans (D-17). */
  readonly unconfirmedCount: number;
  /** The first counting scan in the run, required checkpoint or not. */
  readonly startedAtMs: number | null;
  /** When the last required checkpoint was first counted; null until all are. */
  readonly completedAtMs: number | null;
  /** Per checkpoint: VERIFIED if any counting scan verified it, else QR_ONLY. */
  readonly done: ReadonlyMap<string, 'VERIFIED' | 'QR_ONLY'>;
};

export function runProgress(stops: readonly RouteStop[], visits: readonly RunVisit[]): RunProgress {
  const firstCounted = new Map<string, number>();
  const done = new Map<string, 'VERIFIED' | 'QR_ONLY'>();
  let startedAtMs: number | null = null;
  for (const v of visits) {
    if (!v.counted) continue;
    startedAtMs = startedAtMs === null ? v.scannedAtMs : Math.min(startedAtMs, v.scannedAtMs);
    firstCounted.set(v.checkpointId, Math.min(firstCounted.get(v.checkpointId) ?? Infinity, v.scannedAtMs));
    if (v.outcome === 'VERIFIED' || done.get(v.checkpointId) === 'VERIFIED')
      done.set(v.checkpointId, 'VERIFIED');
    else done.set(v.checkpointId, 'QR_ONLY');
  }
  const required = stops.filter((s) => s.required);
  const counted = required.filter((s) => done.has(s.checkpointId));
  const complete = required.length > 0 && counted.length === required.length;
  return {
    requiredCount: required.length,
    countedCount: counted.length,
    unconfirmedCount: counted.filter((s) => done.get(s.checkpointId) === 'QR_ONLY').length,
    startedAtMs,
    completedAtMs: complete ? Math.max(...required.map((s) => firstCounted.get(s.checkpointId)!)) : null,
    done,
  };
}

/** PROD §9.2: COMPLETED with every required checkpoint; at the window's close, INCOMPLETE or MISSED. */
export function runStatus(progress: RunProgress, windowClosed: boolean): RunStatus {
  if (progress.completedAtMs !== null) return 'COMPLETED';
  if (!windowClosed) return progress.startedAtMs === null ? 'PENDING' : 'IN_PROGRESS';
  return progress.startedAtMs === null ? 'MISSED' : 'INCOMPLETE';
}

/** With "enforce order" on: a required checkpoint earlier in the route is still to be counted. */
export function isOutOfOrder(
  stops: readonly RouteStop[],
  counted: ReadonlySet<string>,
  checkpointId: string,
): boolean {
  const stop = stops.find((s) => s.checkpointId === checkpointId);
  if (!stop) return false;
  return stops.some((s) => s.required && s.sequence < stop.sequence && !counted.has(s.checkpointId));
}

/** The guard's next stop: the first required checkpoint in route order not yet counted. */
export function nextStop(stops: readonly RouteStop[], counted: ReadonlySet<string>): RouteStop | null {
  return (
    [...stops]
      .sort((a, b) => a.sequence - b.sequence)
      .find((s) => s.required && !counted.has(s.checkpointId)) ?? null
  );
}
