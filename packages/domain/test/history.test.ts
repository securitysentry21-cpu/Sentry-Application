import { describe, expect, it } from 'vitest';

import { downsampleTrack, hasTrackingProblem, siteStatus, type TrackPoint } from '../src/history.ts';

const MIN = 60_000;
const GAP = 5 * MIN;

/** A point every `everyMs`, starting at 0. */
function track(count: number, everyMs: number, flaggedAt: readonly number[] = []): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => ({ t: i * everyMs, flagged: flaggedAt.includes(i) }));
}

describe('location history thinning (PROD §14.5)', () => {
  it('keeps every point when they fit', () => {
    const kept = downsampleTrack(track(10, MIN), 2000, GAP);
    expect(kept.map((k) => k.index)).toEqual([...Array(10).keys()]);
    expect(kept.some((k) => k.gapBefore)).toBe(false);
  });

  it('never returns more than the limit, and keeps the first, last and flagged points', () => {
    const points = track(10_000, 10_000, [17, 5_000, 9_998]);
    const kept = downsampleTrack(points, 2000, GAP);
    expect(kept.length).toBe(2000);
    const indices = kept.map((k) => k.index);
    for (const i of [0, 17, 5_000, 9_998, 9_999]) expect(indices).toContain(i);
    // Ordered by capture time, no repeats.
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('marks a gap longer than 5 minutes as a break, also after thinning', () => {
    // 3,000 points every 10 s, a 40-minute hole after point 1,499, then 3,000 more.
    const before = track(1500, 10_000);
    const after = track(1500, 10_000).map((p) => ({ ...p, t: p.t + 1500 * 10_000 + 40 * MIN }));
    const kept = downsampleTrack([...before, ...after], 500, GAP);
    const breaks = kept.filter((k) => k.gapBefore);
    expect(breaks.map((k) => k.index)).toEqual([1500]);
    // Both sides of the gap are kept, so the line ends and starts exactly at the hole.
    expect(kept.map((k) => k.index)).toContain(1499);
  });

  it('shows a break even when thinning drops the points beside a gap', () => {
    // More gaps than the budget can keep the edges of: every gap still separates kept points.
    const points: TrackPoint[] = [];
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += i % 2 === 0 ? 10 * MIN : 10_000;
      points.push({ t, flagged: false });
    }
    const kept = downsampleTrack(points, 50, GAP);
    expect(kept.length).toBe(50);
    for (let k = 1; k < kept.length; k++) {
      const from = kept[k - 1]!.index;
      const to = kept[k]!.index;
      let gapBetween = false;
      for (let i = from + 1; i <= to; i++) if (points[i]!.t - points[i - 1]!.t > GAP) gapBetween = true;
      expect(kept[k]!.gapBefore, `between ${from} and ${to}`).toBe(gapBetween);
    }
  });

  it('a gap of exactly 5 minutes is not a break', () => {
    const kept = downsampleTrack(track(3, GAP), 2000, GAP);
    expect(kept.some((k) => k.gapBefore)).toBe(false);
  });

  it('handles empty tracks and a zero budget', () => {
    expect(downsampleTrack([], 2000, GAP)).toEqual([]);
    expect(downsampleTrack(track(5, MIN), 0, GAP)).toEqual([]);
  });
});

describe('site status (PROD §8.4, §14.2)', () => {
  it('is on site only inside, off site only once a departure is confirmed', () => {
    expect(siteStatus('INSIDE')).toBe('ON_SITE');
    expect(siteStatus('OUTSIDE_CONFIRMED')).toBe('OFF_SITE');
    for (const s of ['OUTSIDE_SUSPECTED', 'UNCERTAIN', 'UNKNOWN']) expect(siteStatus(s)).toBe('UNKNOWN');
  });
});

describe('tracking problems (PROD §8.3)', () => {
  it('flags a stopped service, a permission problem and anything short of "Allow all the time"', () => {
    expect(hasTrackingProblem({ trackingServiceState: 'RUNNING', locationPermission: 'ALWAYS' })).toBe(false);
    expect(hasTrackingProblem({ trackingServiceState: 'STOPPED', locationPermission: 'ALWAYS' })).toBe(true);
    expect(hasTrackingProblem({ trackingServiceState: 'PERMISSION_PROBLEM', locationPermission: null })).toBe(
      true,
    );
    expect(hasTrackingProblem({ trackingServiceState: 'RUNNING', locationPermission: 'WHILE_IN_USE' })).toBe(
      true,
    );
    // Nothing reported yet is not a problem the phone told us about.
    expect(hasTrackingProblem({ trackingServiceState: null, locationPermission: null })).toBe(false);
  });
});
