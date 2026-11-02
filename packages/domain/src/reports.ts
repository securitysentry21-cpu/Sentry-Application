// Report arithmetic (PROD §15.1), pure: the API reads the rows, these turn them into the figures.
// Times are the server's estimates of capture (ARCH §8.7); local dates are the site's (ADV-TM02).
import { csvCell } from './attendance.ts';
import { haversineM, type Boundary } from './geo.ts';
import { INITIAL_GEOFENCE, stepGeofence, type GeofenceSettings } from './geofence.ts';
import { addDays, localToUtc } from './time.ts';

const DAY_MS = 86_400_000;
const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

/** Inclusive local dates in a time zone, as UTC instants [start, end); `days` counts the dates. */
export function localRange(
  from: string,
  to: string,
  timeZone: string,
): { start: Date; end: Date; days: number } {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  return {
    start: localToUtc(from, '00:00', timeZone),
    end: localToUtc(addDays(to, 1), '00:00', timeZone),
    days,
  };
}

// ── CSV (PROD §15.2, SEC §8) ────────────────────────────────────────────────────────────────

/** Excel reads UTF-8 (and so Urdu) correctly only with a byte-order mark. */
export const CSV_BOM = String.fromCharCode(0xfeff);

/** A whole CSV file: BOM, header, rows, CRLF line ends, every cell formula-safe (ADV-W02). */
export function csvDocument(
  header: readonly string[],
  rows: Iterable<readonly (string | number | null)[]>,
): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

// ── Patrols (PROD §15.1) ────────────────────────────────────────────────────────────────────

export type PatrolVisitFacts = {
  readonly checkpointId: string | null;
  readonly verificationStatus: string;
  readonly counted: boolean;
  readonly flags: readonly string[];
  readonly scannedAt: Date;
  readonly receivedAt: Date;
};

export type PatrolRunFacts = {
  readonly status: string;
  readonly requiredCount: number;
  readonly countedCount: number;
};

/** A scan that reached the server this long after it was made was sent late (offline). */
export const SENT_LATE_AFTER_MS = 5 * 60_000;

export function patrolFigures(
  run: PatrolRunFacts,
  visits: readonly PatrolVisitFacts[],
): {
  verified: number;
  qrOnly: number;
  missed: number;
  completionPct: number | null;
  flags: string[];
} {
  const counted = visits.filter((v) => v.counted);
  const distinct = (status: string) =>
    new Set(counted.filter((v) => v.verificationStatus === status).map((v) => v.checkpointId)).size;
  const closed = !['PENDING', 'IN_PROGRESS', 'CANCELLED'].includes(run.status);
  const flags = new Set<string>();
  for (const v of visits) {
    if (v.flags.includes('OUT_OF_ORDER')) flags.add('OUT_OF_ORDER');
    if (v.flags.includes('IMPLAUSIBLE_TRAVEL') || v.flags.includes('MOCK_LOCATION')) flags.add('SUSPICIOUS');
    if (v.receivedAt.getTime() - v.scannedAt.getTime() > SENT_LATE_AFTER_MS) flags.add('SENT_LATE');
  }
  return {
    verified: distinct('VERIFIED'),
    qrOnly: distinct('LOCATION_UNCONFIRMED'),
    // Only a closed round has missed checkpoints: one under way may still get them.
    missed: closed ? Math.max(0, run.requiredCount - run.countedCount) : 0,
    completionPct:
      run.requiredCount > 0
        ? Math.round((Math.min(run.countedCount, run.requiredCount) / run.requiredCount) * 100)
        : null,
    flags: [...flags].sort(),
  };
}

// ── Incidents (PROD §15.1) ──────────────────────────────────────────────────────────────────

export function incidentTimings(i: {
  readonly receivedAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly resolvedAt: Date | null;
}): { secondsToAcknowledge: number | null; secondsToResolve: number | null } {
  return {
    secondsToAcknowledge: i.acknowledgedAt
      ? seconds(i.acknowledgedAt.getTime() - i.receivedAt.getTime())
      : null,
    secondsToResolve: i.resolvedAt ? seconds(i.resolvedAt.getTime() - i.receivedAt.getTime()) : null,
  };
}

// ── Location (PROD §15.1) ───────────────────────────────────────────────────────────────────

export type TrackFix = {
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number | null;
  readonly capturedAt: Date;
  readonly receivedAt: Date;
};

export type LocationSummary = {
  firstFixAt: Date | null;
  lastFixAt: Date | null;
  insideSeconds: number;
  outsideSeconds: number;
  unknownSeconds: number;
  excursions: { from: Date; to: Date | null; seconds: number; detectedLate: boolean }[];
  longestGapSeconds: number;
  distanceM: number;
  points: number;
};

type Interval = { from: number; to: number };

function clip(i: Interval, w: Interval): Interval | null {
  const from = Math.max(i.from, w.from);
  const to = Math.min(i.to, w.to);
  return to > from ? { from, to } : null;
}

/** Total length of a set of intervals, overlaps counted once. */
function covered(intervals: readonly Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  let total = 0;
  let end = -Infinity;
  for (const i of sorted) {
    if (i.to <= end) continue;
    total += i.to - Math.max(i.from, end);
    end = i.to;
  }
  return total;
}

/**
 * One shift's track, summarised. The window is the worked time (actual start to actual end, or
 * now for a shift still running). Within it:
 *   - unknown: no data — before the first fix, after the last one, and every gap between fixes
 *     longer than `staleAfterS` (freshness.location_stale_after_s);
 *   - outside: confirmed departures by the geofence rules (PROD §8.4), from the first outside fix
 *     to the confirmed return (or the last fix), less what is unknown;
 *   - inside: the rest. The three always add up to the window.
 * An excursion is `detectedLate` when the fix that confirmed it reached the server more than
 * `lateAfterS` after it was taken: it was found after the phone synced (PROD §15.1).
 */
export function locationSummary(input: {
  readonly window: { readonly start: Date; readonly end: Date } | null;
  readonly fixes: readonly TrackFix[];
  readonly boundary: Boundary;
  readonly geofence: GeofenceSettings;
  readonly staleAfterS: number;
  readonly lateAfterS: number;
}): LocationSummary {
  const fixes = [...input.fixes].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const usable = fixes.filter(
    (f) => f.accuracyM !== null && f.accuracyM <= input.geofence.maxUsableAccuracyM,
  );
  const summary: LocationSummary = {
    firstFixAt: fixes[0]?.capturedAt ?? null,
    lastFixAt: fixes.at(-1)?.capturedAt ?? null,
    insideSeconds: 0,
    outsideSeconds: 0,
    unknownSeconds: 0,
    excursions: [],
    longestGapSeconds: 0,
    distanceM: 0,
    points: fixes.length,
  };
  for (let i = 1; i < usable.length; i++) {
    const a = usable[i - 1];
    const b = usable[i];
    if (a && b) summary.distanceM += haversineM(a, b);
  }
  summary.distanceM = Math.round(summary.distanceM);
  if (!input.window) return summary;
  const w: Interval = { from: input.window.start.getTime(), to: input.window.end.getTime() };
  if (w.to <= w.from) return summary;

  // Gaps (any fix counts as data, whatever its accuracy).
  const times = fixes.map((f) => f.capturedAt.getTime()).filter((t) => t >= w.from && t <= w.to);
  const edges = [w.from, ...times, w.to];
  const unknown: Interval[] = [];
  for (let i = 1; i < edges.length; i++) {
    const from = edges[i - 1] ?? w.from;
    const to = edges[i] ?? w.to;
    const gap = to - from;
    summary.longestGapSeconds = Math.max(summary.longestGapSeconds, seconds(gap));
    if (gap > input.staleAfterS * 1000) unknown.push({ from, to });
  }

  // Departures and returns, by the same rules as the live alerts.
  let memory = INITIAL_GEOFENCE;
  let open: { from: number; detectedLate: boolean } | null = null;
  const outside: Interval[] = [];
  for (const fix of usable) {
    const step = stepGeofence(memory, input.boundary, { ...fix, accuracyM: fix.accuracyM }, input.geofence);
    memory = step.memory;
    if (step.event?.type === 'LEFT_SITE') {
      open = {
        from: step.event.since.getTime(),
        detectedLate: fix.receivedAt.getTime() - fix.capturedAt.getTime() > input.lateAfterS * 1000,
      };
    } else if (step.event?.type === 'ENTERED_SITE' && open) {
      const to = step.event.at.getTime();
      outside.push({ from: open.from, to });
      summary.excursions.push({
        from: new Date(open.from),
        to: new Date(to),
        seconds: seconds(to - open.from),
        detectedLate: open.detectedLate,
      });
      open = null;
    }
  }
  if (open) {
    const last = usable.at(-1)?.capturedAt.getTime() ?? open.from;
    outside.push({ from: open.from, to: last });
    summary.excursions.push({
      from: new Date(open.from),
      to: null,
      seconds: seconds(last - open.from),
      detectedLate: open.detectedLate,
    });
  }

  const total = w.to - w.from;
  const unknownMs = covered(unknown.map((i) => clip(i, w)).filter((i): i is Interval => i !== null));
  const outsideOrUnknown = covered(
    [...unknown, ...outside].map((i) => clip(i, w)).filter((i): i is Interval => i !== null),
  );
  summary.unknownSeconds = seconds(unknownMs);
  summary.outsideSeconds = seconds(outsideOrUnknown - unknownMs);
  summary.insideSeconds = Math.max(0, seconds(total) - summary.unknownSeconds - summary.outsideSeconds);
  return summary;
}

// ── Site activity (PROD §15.1, R2) ──────────────────────────────────────────────────────────

export type SiteDayFacts = {
  shiftsScheduled: number;
  shiftsCovered: number;
  shiftsMissed: number;
  lateStarts: number;
  workedMinutes: number;
  patrolRequired: number;
  patrolCounted: number;
  incidents: number;
  incidentsHighOrCritical: number;
};

export const emptySiteDay = (): SiteDayFacts => ({
  shiftsScheduled: 0,
  shiftsCovered: 0,
  shiftsMissed: 0,
  lateStarts: 0,
  workedMinutes: 0,
  patrolRequired: 0,
  patrolCounted: 0,
  incidents: 0,
  incidentsHighOrCritical: 0,
});

export function patrolCompletionPct(required: number, counted: number): number | null {
  return required > 0 ? Math.round((Math.min(counted, required) / required) * 100) : null;
}
