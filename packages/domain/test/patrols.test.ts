import { describe, expect, it } from 'vitest';

import { haversineM } from '../src/geo.ts';
import {
  distanceBand,
  isOutOfOrder,
  nextStop,
  runProgress,
  runSchedule,
  runStatus,
  verifyScan,
  type RouteStop,
  type RunVisit,
  type ScanInput,
  type ScanSettings,
} from '../src/patrols.ts';

const SETTINGS: ScanSettings = {
  maxFixAgeS: 30,
  maxUsableAccuracyM: 50,
  maxPlausibleSpeedMps: 15,
  countUnconfirmed: true,
  treatMockAsUnconfirmed: true,
};

const GATE = { lat: 31.47, lng: 74.4 };
/** About `metres` north of the gate. */
const north = (metres: number) => ({ lat: GATE.lat + metres / 111_320, lng: GATE.lng });

function scan(overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    checkpoint: { siteId: 'site-a', location: GATE, radiusM: 30 },
    shift: { siteId: 'site-a' },
    duplicate: false,
    fix: { ...north(5), accuracyM: 8, fixAgeS: 2, isMock: false },
    scannedAtMs: 1_000_000,
    previous: null,
    outOfOrder: false,
    ...overrides,
  };
}

describe('scan verification (ARCH §11.2)', () => {
  it('a fresh, accurate fix inside the radius is VERIFIED and counts (ADV-Q01)', () => {
    const v = verifyScan(scan(), SETTINGS);
    expect(v).toMatchObject({ outcome: 'VERIFIED', counted: true, reason: null, suspicious: false });
    expect(v.distanceM).toBe(5);
    expect(v.flags).toEqual([]);
  });

  it('a fix clearly outside the radius is OUTSIDE_RADIUS and does not count (ADV-Q02)', () => {
    const v = verifyScan(scan({ fix: { ...north(85), accuracyM: 10, fixAgeS: 1, isMock: false } }), SETTINGS);
    expect(v).toMatchObject({ outcome: 'OUTSIDE_RADIUS', counted: false, distanceM: 85 });
  });

  it('far away stays OUTSIDE_RADIUS even when the accuracy is too poor to verify with (ADV-Q02)', () => {
    const v = verifyScan(
      scan({ fix: { ...north(2_000), accuracyM: 120, fixAgeS: 1, isMock: false } }),
      SETTINGS,
    );
    expect(v).toMatchObject({ outcome: 'OUTSIDE_RADIUS', counted: false });
    expect(v.flags).toContain('LOW_ACCURACY');
  });

  it('poor accuracy near the checkpoint is LOCATION_UNCONFIRMED, counted per D-17 (ADV-Q03)', () => {
    const indoor = scan({ fix: { ...north(20), accuracyM: 90, fixAgeS: 3, isMock: false } });
    expect(verifyScan(indoor, SETTINGS)).toMatchObject({
      outcome: 'LOCATION_UNCONFIRMED',
      reason: 'LOW_ACCURACY',
      counted: true,
    });
    expect(verifyScan(indoor, { ...SETTINGS, countUnconfirmed: false })).toMatchObject({
      outcome: 'LOCATION_UNCONFIRMED',
      counted: false,
    });
  });

  it('no fix, a stale fix, no accuracy or no checkpoint position: LOCATION_UNCONFIRMED with the reason', () => {
    expect(verifyScan(scan({ fix: null }), SETTINGS)).toMatchObject({ reason: 'NO_FIX', distanceM: null });
    expect(
      verifyScan(scan({ fix: { ...north(5), accuracyM: 8, fixAgeS: 31, isMock: false } }), SETTINGS),
    ).toMatchObject({ outcome: 'LOCATION_UNCONFIRMED', reason: 'STALE_FIX' });
    expect(
      verifyScan(scan({ fix: { ...north(5), accuracyM: null, fixAgeS: 1, isMock: false } }), SETTINGS),
    ).toMatchObject({ outcome: 'LOCATION_UNCONFIRMED', reason: 'LOW_ACCURACY' });
    expect(
      verifyScan(scan({ checkpoint: { siteId: 'site-a', location: null, radiusM: 30 } }), SETTINGS),
    ).toMatchObject({ outcome: 'LOCATION_UNCONFIRMED', reason: 'NO_CHECKPOINT_POSITION', counted: true });
  });

  it('within the accuracy of the edge is LOCATION_UNCONFIRMED, not a guess either way', () => {
    // 40 m away, ±20 m: maybe inside a 30 m radius, maybe not.
    const v = verifyScan(scan({ fix: { ...north(40), accuracyM: 20, fixAgeS: 1, isMock: false } }), SETTINGS);
    expect(v).toMatchObject({ outcome: 'LOCATION_UNCONFIRMED', reason: 'NEAR_EDGE', distanceM: 40 });
  });

  it('a mock fix is flagged and suspicious; by policy it never verifies (ADV-L11)', () => {
    const mock = scan({ fix: { ...north(5), accuracyM: 5, fixAgeS: 1, isMock: true } });
    expect(verifyScan(mock, SETTINGS)).toMatchObject({
      outcome: 'LOCATION_UNCONFIRMED',
      reason: 'MOCK_LOCATION',
      suspicious: true,
      flags: ['MOCK_LOCATION'],
    });
    expect(verifyScan(mock, { ...SETTINGS, treatMockAsUnconfirmed: false })).toMatchObject({
      outcome: 'VERIFIED',
      suspicious: true,
    });
  });

  it('keeps the order: label, shift, site, duplicate, then location (ADV-Q05, Q06, Q07)', () => {
    const far = { ...north(5_000), accuracyM: 5, fixAgeS: 1, isMock: false };
    expect(verifyScan(scan({ checkpoint: null, shift: null, fix: far }), SETTINGS).outcome).toBe(
      'INVALID_QR',
    );
    expect(verifyScan(scan({ shift: null, fix: far }), SETTINGS).outcome).toBe('NO_ACTIVE_SHIFT');
    expect(verifyScan(scan({ shift: { siteId: 'site-b' }, fix: far }), SETTINGS).outcome).toBe('WRONG_SITE');
    expect(verifyScan(scan({ duplicate: true, fix: far }), SETTINGS)).toMatchObject({
      outcome: 'DUPLICATE',
      counted: false,
    });
    for (const outcome of ['INVALID_QR', 'NO_ACTIVE_SHIFT', 'WRONG_SITE', 'DUPLICATE'] as const) {
      const v = verifyScan(
        outcome === 'INVALID_QR'
          ? scan({ checkpoint: null })
          : outcome === 'NO_ACTIVE_SHIFT'
            ? scan({ shift: null })
            : outcome === 'WRONG_SITE'
              ? scan({ shift: { siteId: 'site-b' } })
              : scan({ duplicate: true }),
        SETTINGS,
      );
      // Nothing about location is worked out for these, and none of them counts (INV-11).
      expect(v).toMatchObject({ outcome, counted: false, distanceM: null, reason: null });
    }
  });

  it('two checkpoints 500 m apart scanned 10 s apart: IMPLAUSIBLE_TRAVEL and suspicious (ADV-Q08)', () => {
    const v = verifyScan(
      scan({ previous: { scannedAtMs: 1_000_000 - 10_000, location: north(500) } }),
      SETTINGS,
    );
    expect(v.flags).toContain('IMPLAUSIBLE_TRAVEL');
    expect(v.suspicious).toBe(true);
    // A walk at a normal pace is fine.
    const walk = verifyScan(
      scan({ previous: { scannedAtMs: 1_000_000 - 400_000, location: north(500) } }),
      SETTINGS,
    );
    expect(walk.flags).not.toContain('IMPLAUSIBLE_TRAVEL');
  });

  it('out-of-order scans still count, flagged; only counting scans are flagged', () => {
    expect(verifyScan(scan({ outOfOrder: true }), SETTINGS)).toMatchObject({
      counted: true,
      flags: ['OUT_OF_ORDER'],
    });
    const outside = scan({
      outOfOrder: true,
      fix: { ...north(300), accuracyM: 5, fixAgeS: 1, isMock: false },
    });
    expect(verifyScan(outside, SETTINGS).flags).not.toContain('OUT_OF_ORDER');
  });

  it('passes flags from ingestion through', () => {
    expect(verifyScan(scan({ flags: ['SKEWED_CLOCK'] }), SETTINGS).flags).toEqual(['SKEWED_CLOCK']);
  });

  it('bands distances for records kept outside a shift', () => {
    expect([0, 50, 51, 100, 249, 500, 1000, 1001].map(distanceBand)).toEqual([
      '0-50',
      '0-50',
      '50-100',
      '50-100',
      '100-250',
      '250-500',
      '500-1000',
      '1000+',
    ]);
    // The helper the bands are drawn from agrees with the verdict's distances.
    expect(Math.round(haversineM(GATE, north(85)))).toBe(85);
  });
});

describe('run schedule (PROD §9.2)', () => {
  const start = new Date('2026-11-02T20:05:00Z');
  const end = new Date('2026-11-03T04:00:00Z');

  it('run k is due at start + offset + k·interval, closes at due + window, while due is before the end', () => {
    const runs = runSchedule(
      { intervalMinutes: 120, firstRunOffsetMinutes: 30, completionWindowMinutes: 30 },
      start,
      end,
    );
    expect(runs.map((r) => [r.sequenceNo, r.dueAt.toISOString(), r.windowEndsAt.toISOString()])).toEqual([
      [1, '2026-11-02T20:35:00.000Z', '2026-11-02T21:05:00.000Z'],
      [2, '2026-11-02T22:35:00.000Z', '2026-11-02T23:05:00.000Z'],
      [3, '2026-11-03T00:35:00.000Z', '2026-11-03T01:05:00.000Z'],
      [4, '2026-11-03T02:35:00.000Z', '2026-11-03T03:05:00.000Z'],
    ]);
  });

  it('a run due exactly at the end is not generated; an extension adds the later ones', () => {
    const schedule = { intervalMinutes: 60, firstRunOffsetMinutes: 0, completionWindowMinutes: 15 };
    const short = runSchedule(schedule, start, new Date('2026-11-02T22:05:00Z'));
    expect(short.map((r) => r.sequenceNo)).toEqual([1, 2]);
    const extended = runSchedule(schedule, start, new Date('2026-11-02T23:30:00Z'));
    expect(extended.map((r) => r.sequenceNo)).toEqual([1, 2, 3, 4]);
    expect(extended.slice(0, 2)).toEqual(short);
  });

  it('never more than a 24-hour shift can hold at the shortest interval', () => {
    const runs = runSchedule(
      { intervalMinutes: 10, firstRunOffsetMinutes: 0, completionWindowMinutes: 5 },
      start,
      new Date(start.getTime() + 24 * 3_600_000),
    );
    expect(runs.length).toBe(144);
  });
});

describe('run progress and status', () => {
  const stops: RouteStop[] = [
    { checkpointId: 'a', sequence: 1, required: true },
    { checkpointId: 'b', sequence: 2, required: true },
    { checkpointId: 'c', sequence: 3, required: false },
  ];
  const v = (
    checkpointId: string,
    scannedAtMs: number,
    outcome: RunVisit['outcome'] = 'VERIFIED',
  ): RunVisit => ({
    checkpointId,
    outcome,
    counted: outcome === 'VERIFIED' || outcome === 'LOCATION_UNCONFIRMED',
    scannedAtMs,
  });

  it('pending, then in progress, then completed when every required checkpoint counts', () => {
    expect(runStatus(runProgress(stops, []), false)).toBe('PENDING');
    const one = runProgress(stops, [v('a', 100)]);
    expect(one).toMatchObject({ requiredCount: 2, countedCount: 1, startedAtMs: 100, completedAtMs: null });
    expect(runStatus(one, false)).toBe('IN_PROGRESS');
    const all = runProgress(stops, [v('a', 100), v('c', 150), v('b', 200)]);
    expect(all).toMatchObject({ countedCount: 2, completedAtMs: 200 });
    expect(runStatus(all, false)).toBe('COMPLETED');
    expect(runStatus(all, true)).toBe('COMPLETED');
  });

  it('closes INCOMPLETE with some and MISSED with none; scans that did not count are not progress', () => {
    expect(runStatus(runProgress(stops, [v('a', 100)]), true)).toBe('INCOMPLETE');
    expect(
      runStatus(runProgress(stops, [v('a', 100, 'OUTSIDE_RADIUS'), v('b', 120, 'DUPLICATE')]), true),
    ).toBe('MISSED');
  });

  it('QR-only checkpoints are counted and reported; a later verified scan upgrades them', () => {
    const qrOnly = runProgress(stops, [v('a', 100, 'LOCATION_UNCONFIRMED'), v('b', 200)]);
    expect(qrOnly).toMatchObject({ countedCount: 2, unconfirmedCount: 1 });
    expect(qrOnly.done.get('a')).toBe('QR_ONLY');
    const upgraded = runProgress(stops, [v('a', 100, 'LOCATION_UNCONFIRMED'), v('b', 200), v('a', 300)]);
    expect(upgraded).toMatchObject({ unconfirmedCount: 0, completedAtMs: 200 });
    expect(upgraded.done.get('a')).toBe('VERIFIED');
  });

  it('order: the next stop, and what counts as out of order', () => {
    expect(nextStop(stops, new Set())?.checkpointId).toBe('a');
    expect(nextStop(stops, new Set(['a']))?.checkpointId).toBe('b');
    expect(nextStop(stops, new Set(['a', 'b']))).toBeNull();
    expect(isOutOfOrder(stops, new Set(), 'b')).toBe(true);
    expect(isOutOfOrder(stops, new Set(['a']), 'b')).toBe(false);
    expect(isOutOfOrder(stops, new Set(), 'a')).toBe(false);
    expect(isOutOfOrder(stops, new Set(), 'unknown')).toBe(false);
  });
});
