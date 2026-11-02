// Patrols in words (PROD §7.7, §9): round states, scan outcomes, why a scan is "QR only", and flags,
// as the dashboard says them. Status is never colour alone: every badge carries one of these words
// (PROD §14.7). The limits below are the contracts' (packages/contracts/src/patrols.ts, sites.ts):
// the server enforces them; the forms only say so early, and zod stays out of the browser bundle.
import type {
  CheckpointVisit,
  PatrolRoute,
  PatrolRun,
  PatrolRunStatus,
  ScanOutcomeName,
} from '@sentryops/contracts';

import { formatDateTime, siteTime } from './format';

export const INTERVAL_MINUTES = { min: 10, max: 720 } as const;
export const WINDOW_MINUTES = { min: 5, max: 720 } as const;
export const OFFSET_MINUTES = { min: 0, max: 720 } as const;
/** A checkpoint's verification radius. */
export const RADIUS_M = { min: 10, max: 500 } as const;

/** In the order a round goes through them. */
export const RUN_STATUSES: readonly PatrolRunStatus[] = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'INCOMPLETE',
  'MISSED',
  'CANCELLED',
];

export const RUN_STATUS_LABEL: Record<PatrolRunStatus, string> = {
  PENDING: 'Due',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Done',
  INCOMPLETE: 'Incomplete',
  MISSED: 'Missed',
  CANCELLED: 'Cancelled',
};

export const RUN_STATUS_BADGE: Record<PatrolRunStatus, string> = {
  PENDING: 'info',
  IN_PROGRESS: 'info',
  COMPLETED: 'ok',
  INCOMPLETE: 'warn',
  MISSED: 'danger',
  CANCELLED: 'plain',
};

export const OUTCOME_LABEL: Record<ScanOutcomeName, string> = {
  VERIFIED: 'Verified',
  LOCATION_UNCONFIRMED: 'QR only',
  OUTSIDE_RADIUS: 'Not verified',
  WRONG_SITE: 'Checkpoint of another site',
  INVALID_QR: 'Unknown or old label',
  NO_ACTIVE_SHIFT: 'No active shift',
  DUPLICATE: 'Already scanned',
};

export const OUTCOME_BADGE: Record<ScanOutcomeName, string> = {
  VERIFIED: 'ok',
  LOCATION_UNCONFIRMED: 'warn',
  OUTSIDE_RADIUS: 'danger',
  WRONG_SITE: 'danger',
  INVALID_QR: 'danger',
  NO_ACTIVE_SHIFT: 'warn',
  DUPLICATE: 'plain',
};

/** Why a valid scan's location could not be confirmed (LOCATION_UNCONFIRMED). */
export const UNCONFIRMED_REASON: Record<string, string> = {
  NO_CHECKPOINT_POSITION: 'checkpoint has no position',
  NO_FIX: 'no GPS fix',
  STALE_FIX: 'old GPS fix',
  MOCK_LOCATION: 'fake GPS',
  LOW_ACCURACY: 'poor GPS accuracy',
  NEAR_EDGE: 'at the edge of the radius',
};

/** Flags don't change the outcome; they say what looked wrong (PROD §9.3). */
export const SCAN_FLAG_LABEL: Record<string, string> = {
  MOCK_LOCATION: 'fake GPS',
  IMPLAUSIBLE_TRAVEL: 'impossible travel between scans',
  SKEWED_CLOCK: 'phone clock wrong',
  LOW_ACCURACY: 'poor accuracy',
  OUT_OF_ORDER: 'out of order',
};

/** A code the dashboard has no words for yet, still readable. */
const plainWords = (code: string) => code.toLowerCase().replaceAll('_', ' ');

type VisitResult = Pick<CheckpointVisit, 'outcome' | 'reason' | 'distanceM' | 'counted'>;

/** What follows the outcome's name: why a scan is "QR only", how far away it was. */
export function outcomeDetail(v: VisitResult): string | null {
  if (v.outcome === 'LOCATION_UNCONFIRMED') {
    const parts = v.reason ? [UNCONFIRMED_REASON[v.reason] ?? plainWords(v.reason)] : [];
    // D-17: an organization may stop QR-only scans from counting.
    if (!v.counted) parts.push('not counted');
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (v.outcome === 'OUTSIDE_RADIUS') {
    return v.distanceM !== null ? `about ${v.distanceM} m away` : 'outside the radius';
  }
  return null;
}

/** "Verified", "QR only: no GPS fix", "Not verified: about 85 m away", "Already scanned"… */
export function outcomeText(v: VisitResult): string {
  const detail = outcomeDetail(v);
  return detail ? `${OUTCOME_LABEL[v.outcome]}: ${detail}` : OUTCOME_LABEL[v.outcome];
}

export function flagsText(flags: readonly string[]): string {
  return flags.map((f) => SCAN_FLAG_LABEL[f] ?? plainWords(f)).join(', ');
}

/** "4 of 6", with "(1 QR only)" when some were counted by QR-only scans alone (D-17). */
export function progressText(
  run: Pick<PatrolRun, 'countedCount' | 'requiredCount' | 'unconfirmedCount'>,
): string {
  const done = `${run.countedCount} of ${run.requiredCount}`;
  return run.unconfirmedCount > 0 ? `${done} (${run.unconfirmedCount} QR only)` : done;
}

/** The required checkpoints a round still lacks: nothing before it starts or once it is done. */
export function missingText(run: Pick<PatrolRun, 'status' | 'missing'>): string | null {
  if (run.missing.length === 0) return null;
  if (run.status === 'INCOMPLETE' || run.status === 'MISSED') return `Missing: ${run.missing.join(', ')}`;
  if (run.status === 'IN_PROGRESS') return `Still to scan: ${run.missing.join(', ')}`;
  return null;
}

/** "Every 60 min, 30 min to complete, first at start + 0 min", or "On demand". */
export function scheduleText(schedule: PatrolRoute['schedule']): string {
  if (!schedule) return 'On demand';
  return `Every ${schedule.intervalMinutes} min, ${schedule.completionWindowMinutes} min to complete, first at start + ${schedule.firstRunOffsetMinutes} min`;
}

/** One checkpoint of a round: done, and how, or why not. */
export function stopState(
  done: 'VERIFIED' | 'QR_ONLY' | null,
  required: boolean,
  status: PatrolRunStatus,
): { label: string; badge: string } {
  if (done === 'VERIFIED') return { label: '✓ Verified', badge: 'ok' };
  if (done === 'QR_ONLY') return { label: 'QR only', badge: 'warn' };
  if (required && (status === 'INCOMPLETE' || status === 'MISSED'))
    return { label: 'Missing', badge: 'danger' };
  if (status === 'PENDING' || status === 'IN_PROGRESS') return { label: 'Not yet', badge: 'plain' };
  return { label: 'Not scanned', badge: 'plain' };
}

/** A round's window in its site's time: "21:00–21:30 GMT+5", or with the date before it. */
export function runWindow(run: Pick<PatrolRun, 'dueAt' | 'windowEndsAt' | 'site'>, withDate = false): string {
  const tz = run.site.timezone;
  const start = withDate ? formatDateTime(run.dueAt, tz) : siteTime(run.dueAt, tz, false);
  return `${start}–${siteTime(run.windowEndsAt, tz)}`;
}

/** A scan's time in the site's zone, to the second: scans can be seconds apart. */
export function scanTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}
