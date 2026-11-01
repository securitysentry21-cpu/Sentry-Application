// Location history for the viewer (PROD §14.5): a shift's points, thinned on the server.

export type TrackPoint = {
  /** Capture time in epoch milliseconds; the input is ordered by it. */
  readonly t: number;
  /** Mock locations, implausible jumps and other flags are always kept. */
  readonly flagged: boolean;
};

export type KeptPoint = {
  /** Index into the input. */
  readonly index: number;
  /** A gap longer than the limit lies between this point and the previous one kept: a break. */
  readonly gapBefore: boolean;
};

/**
 * Picks at most `maxPoints` of an ordered track for drawing. Always kept, in this order of priority
 * when even they don't fit: the first and last points, the points on either side of every gap, then
 * flagged points. The rest of the budget is spread evenly over the remaining points. A kept point
 * carries `gapBefore` when any gap lies between it and the previous kept point, so thinning never
 * turns a gap into a straight line that implies travel.
 */
export function downsampleTrack(
  points: readonly TrackPoint[],
  maxPoints: number,
  gapMs: number,
): KeptPoint[] {
  const n = points.length;
  if (n === 0 || maxPoints <= 0) return [];
  const gap = (i: number) => i > 0 && points[i]!.t - points[i - 1]!.t > gapMs;

  const keep = new Set<number>();
  const take = (indices: Iterable<number>) => {
    for (const i of indices) {
      if (keep.size >= maxPoints) return;
      keep.add(i);
    }
  };
  if (n <= maxPoints) {
    take(points.keys());
  } else {
    take([0, n - 1]);
    const edges = new Set<number>();
    for (let i = 1; i < n; i++) {
      if (gap(i)) {
        edges.add(i - 1);
        edges.add(i);
      }
    }
    take(
      evenly(
        [...edges].filter((i) => !keep.has(i)),
        maxPoints - keep.size,
      ),
    );
    const flagged = [...points.keys()].filter((i) => points[i]!.flagged && !keep.has(i));
    take(evenly(flagged, maxPoints - keep.size));
    const rest = [...points.keys()].filter((i) => !keep.has(i));
    take(evenly(rest, maxPoints - keep.size));
  }

  const kept = [...keep].sort((a, b) => a - b);
  const gapsUpTo: number[] = [];
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (gap(i)) count++;
    gapsUpTo.push(count);
  }
  return kept.map((index, k) => {
    const previous = kept[k - 1];
    return {
      index,
      gapBefore: previous !== undefined && gapsUpTo[index]! > gapsUpTo[previous]!,
    };
  });
}

/** Up to `budget` items spread evenly over `items`, keeping the first and last when possible. */
function evenly(items: readonly number[], budget: number): number[] {
  if (budget <= 0) return [];
  if (items.length <= budget) return [...items];
  if (budget === 1) return [items[0]!];
  const out: number[] = [];
  const step = (items.length - 1) / (budget - 1);
  for (let k = 0; k < budget; k++) out.push(items[Math.round(k * step)]!);
  return out;
}

// ── How a live guard reads at a glance (PROD §14.2) ─────────────────────────────────────────

export type SiteStatus = 'ON_SITE' | 'OFF_SITE' | 'UNKNOWN';

/**
 * On site only when the geofence says INSIDE; off site only once a departure is confirmed (PROD §8.4).
 * A suspected departure, an uncertain fix or no fix yet is shown as not known, never guessed.
 */
export function siteStatus(geofenceState: string): SiteStatus {
  if (geofenceState === 'INSIDE') return 'ON_SITE';
  if (geofenceState === 'OUTSIDE_CONFIRMED') return 'OFF_SITE';
  return 'UNKNOWN';
}

/** The phone itself reports that tracking can't work as it should (PROD §8.3 device report). */
export function hasTrackingProblem(report: {
  readonly trackingServiceState: string | null;
  readonly locationPermission: string | null;
}): boolean {
  if (report.trackingServiceState === 'STOPPED' || report.trackingServiceState === 'PERMISSION_PROBLEM')
    return true;
  return report.locationPermission !== null && report.locationPermission !== 'ALWAYS';
}
