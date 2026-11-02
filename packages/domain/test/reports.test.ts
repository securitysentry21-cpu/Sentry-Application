import { describe, expect, it } from 'vitest';

import {
  csvDocument,
  incidentTimings,
  localRange,
  locationSummary,
  patrolFigures,
  type TrackFix,
} from '../src/reports.ts';

const GEOFENCE = {
  maxUsableAccuracyM: 100,
  outsideBufferM: 25,
  departurePersistenceS: 300,
  departureMinPoints: 3,
  returnAccuracyM: 50,
};
const SITE = { kind: 'CIRCLE' as const, center: { lat: 31.47, lng: 74.4 }, radiusM: 150 };
const T0 = Date.parse('2026-10-08T04:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000);
/** A fix `northM` metres north of the site's centre, taken at minute `min`, received at once. */
function fix(min: number, northM: number, accuracyM: number | null = 10, receivedLateMin = 0): TrackFix {
  return {
    lat: 31.47 + northM / 111_195,
    lng: 74.4,
    accuracyM,
    capturedAt: at(min),
    receivedAt: at(min + receivedLateMin),
  };
}

describe('report dates (ADV-TM02)', () => {
  it('ADV-TM02 inclusive local dates become the UTC span of those days in the site zone', () => {
    // Karachi is UTC+5: 1 October local starts at 19:00 UTC the day before.
    const karachi = localRange('2026-10-01', '2026-10-31', 'Asia/Karachi');
    expect(karachi.start.toISOString()).toBe('2026-09-30T19:00:00.000Z');
    expect(karachi.end.toISOString()).toBe('2026-10-31T19:00:00.000Z');
    expect(karachi.days).toBe(31);
    // London leaves summer time on 25 October 2026: the range still ends at local midnight.
    const london = localRange('2026-10-25', '2026-10-25', 'Europe/London');
    expect(london.start.toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect(london.end.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(london.days).toBe(1);
  });
});

describe('CSV (ADV-W02, PROD §15.2)', () => {
  it('ADV-W02 formulas in any cell come out neutralised; the file is UTF-8 with a BOM and CRLF lines', () => {
    const csv = csvDocument(
      ['Name', 'Note'],
      [
        ['=HYPERLINK("http://evil.example","click")', '+cmd|calc'],
        ['@SUM(A1:A9)', '-2+3'],
        ['احمد خان', 'plain, with "quotes"'],
      ],
    );
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://evil.example"",""click"")","'+cmd|calc"`);
    expect(lines[2]).toBe(`"'@SUM(A1:A9)","'-2+3"`);
    expect(lines[3]).toBe('احمد خان,"plain, with ""quotes"""');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('patrol figures (PROD §15.1)', () => {
  const visit = (status: string, counted: boolean, flags: string[] = [], lateMin = 0) => ({
    checkpointId: `cp-${status}-${flags.join('')}`,
    verificationStatus: status,
    counted,
    flags,
    scannedAt: at(0),
    receivedAt: at(lateMin),
  });

  it('counts verified and QR-only checkpoints, the missed ones of a closed round, and completion', () => {
    const figures = patrolFigures({ status: 'INCOMPLETE', requiredCount: 4, countedCount: 3 }, [
      visit('VERIFIED', true),
      visit('VERIFIED', true, ['OUT_OF_ORDER']),
      visit('LOCATION_UNCONFIRMED', true),
      visit('OUTSIDE_RADIUS', false, ['IMPLAUSIBLE_TRAVEL'], 10),
    ]);
    expect(figures).toEqual({
      verified: 2,
      qrOnly: 1,
      missed: 1,
      completionPct: 75,
      flags: ['OUT_OF_ORDER', 'SENT_LATE', 'SUSPICIOUS'],
    });
  });

  it('a round still under way has nothing missed yet; a round with nothing required has no completion', () => {
    expect(patrolFigures({ status: 'IN_PROGRESS', requiredCount: 4, countedCount: 1 }, []).missed).toBe(0);
    expect(
      patrolFigures({ status: 'COMPLETED', requiredCount: 0, countedCount: 0 }, []).completionPct,
    ).toBeNull();
  });
});

describe('incident timings (PROD §15.1)', () => {
  it('times to acknowledge and resolve count from receipt; null while not done', () => {
    expect(incidentTimings({ receivedAt: at(0), acknowledgedAt: at(3), resolvedAt: at(45) })).toEqual({
      secondsToAcknowledge: 180,
      secondsToResolve: 2700,
    });
    expect(incidentTimings({ receivedAt: at(0), acknowledgedAt: null, resolvedAt: null })).toEqual({
      secondsToAcknowledge: null,
      secondsToResolve: null,
    });
  });
});

describe('the location summary (PROD §15.1)', () => {
  const summarise = (fixes: TrackFix[], window = { start: at(0), end: at(60) }) =>
    locationSummary({ window, fixes, boundary: SITE, geofence: GEOFENCE, staleAfterS: 600, lateAfterS: 300 });

  it('inside, outside and unknown add up to the worked time; one confirmed excursion with its duration', () => {
    const fixes: TrackFix[] = [];
    for (let m = 0; m <= 10; m += 2) fixes.push(fix(m, 10)); // inside, 0–10
    for (let m = 12; m <= 30; m += 2) fixes.push(fix(m, 800)); // out from 12 (confirmed after 5 min)
    for (let m = 32; m <= 40; m += 2) fixes.push(fix(m, 10)); // back at 32
    // Nothing from 40 to 60: the last 20 minutes are unknown.
    const s = summarise(fixes);
    expect(s.excursions).toEqual([{ from: at(12), to: at(32), seconds: 1200, detectedLate: false }]);
    expect(s.outsideSeconds).toBe(1200);
    expect(s.unknownSeconds).toBe(1200);
    expect(s.insideSeconds).toBe(3600 - 1200 - 1200);
    expect(s.longestGapSeconds).toBe(1200);
    expect(s.firstFixAt).toEqual(at(0));
    expect(s.lastFixAt).toEqual(at(40));
    expect(s.points).toBe(21);
    // 800 m out and 800 m back, give or take.
    expect(s.distanceM).toBeGreaterThan(1500);
    expect(s.distanceM).toBeLessThan(1700);
  });

  it('an excursion found only after the phone synced is marked detected late', () => {
    const fixes: TrackFix[] = [fix(0, 10)];
    for (let m = 2; m <= 20; m += 2) fixes.push(fix(m, 800, 10, 45)); // offline: arrived 45 min later
    const s = summarise(fixes, { start: at(0), end: at(20) });
    expect(s.excursions).toHaveLength(1);
    expect(s.excursions[0]).toMatchObject({ from: at(2), to: null, detectedLate: true });
  });

  it('unusable fixes are data for gaps but never move the guard; no window means nothing was worked', () => {
    const s = summarise([fix(0, 10), fix(5, 2_000, 900), fix(9, 10)], { start: at(0), end: at(10) });
    expect(s.excursions).toEqual([]);
    expect(s.outsideSeconds).toBe(0);
    expect(s.insideSeconds + s.unknownSeconds).toBe(600);
    const none = locationSummary({
      window: null,
      fixes: [],
      boundary: SITE,
      geofence: GEOFENCE,
      staleAfterS: 600,
      lateAfterS: 300,
    });
    expect(none).toMatchObject({ insideSeconds: 0, outsideSeconds: 0, unknownSeconds: 0, points: 0 });
  });
});
