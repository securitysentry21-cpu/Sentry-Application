// What the dashboard says about patrol rounds and scans (PROD §7.7, §9.3): every outcome, reason and
// flag in words, and times in the site's own zone (PROD §14.7).
import { describe, expect, it } from 'vitest';

import {
  flagsText,
  missingText,
  outcomeText,
  progressText,
  runWindow,
  scanTime,
  scheduleText,
  stopState,
} from '../lib/patrols';

const KARACHI = {
  id: '0190a0d2-7c5e-7000-8000-0000000000bb',
  name: 'ABC Warehouse',
  timezone: 'Asia/Karachi',
};

describe('patrol words', () => {
  it('names every scan outcome, with why a scan is QR only or how far away it was', () => {
    const scan = { reason: null, distanceM: null, counted: false };
    expect(outcomeText({ ...scan, outcome: 'VERIFIED', counted: true })).toBe('Verified');
    expect(
      outcomeText({
        ...scan,
        outcome: 'LOCATION_UNCONFIRMED',
        reason: 'NO_CHECKPOINT_POSITION',
        counted: true,
      }),
    ).toBe('QR only: checkpoint has no position');
    expect(
      outcomeText({ ...scan, outcome: 'LOCATION_UNCONFIRMED', reason: 'STALE_FIX', counted: true }),
    ).toBe('QR only: old GPS fix');
    // D-17 turned off: the scan is labelled and does not count.
    expect(outcomeText({ ...scan, outcome: 'LOCATION_UNCONFIRMED', reason: 'NEAR_EDGE' })).toBe(
      'QR only: at the edge of the radius, not counted',
    );
    expect(outcomeText({ ...scan, outcome: 'OUTSIDE_RADIUS', distanceM: 85 })).toBe(
      'Not verified: about 85 m away',
    );
    expect(outcomeText({ ...scan, outcome: 'WRONG_SITE' })).toBe('Checkpoint of another site');
    expect(outcomeText({ ...scan, outcome: 'INVALID_QR' })).toBe('Unknown or old label');
    expect(outcomeText({ ...scan, outcome: 'NO_ACTIVE_SHIFT' })).toBe('No active shift');
    expect(outcomeText({ ...scan, outcome: 'DUPLICATE' })).toBe('Already scanned');
  });

  it('says what each flag means; a flag it does not know yet still reads as words', () => {
    expect(
      flagsText(['MOCK_LOCATION', 'IMPLAUSIBLE_TRAVEL', 'SKEWED_CLOCK', 'LOW_ACCURACY', 'OUT_OF_ORDER']),
    ).toBe('fake GPS, impossible travel between scans, phone clock wrong, poor accuracy, out of order');
    expect(flagsText(['SOMETHING_NEW'])).toBe('something new');
    expect(flagsText([])).toBe('');
  });

  it('counts checkpoints done by QR-only scans apart (D-17)', () => {
    expect(progressText({ countedCount: 4, requiredCount: 6, unconfirmedCount: 0 })).toBe('4 of 6');
    expect(progressText({ countedCount: 4, requiredCount: 6, unconfirmedCount: 1 })).toBe(
      '4 of 6 (1 QR only)',
    );
  });

  it('names what a round lacks only once it is under way or closed', () => {
    const missing = ['Main gate', 'Office'];
    expect(missingText({ status: 'PENDING', missing })).toBeNull();
    expect(missingText({ status: 'IN_PROGRESS', missing })).toBe('Still to scan: Main gate, Office');
    expect(missingText({ status: 'INCOMPLETE', missing })).toBe('Missing: Main gate, Office');
    expect(missingText({ status: 'MISSED', missing })).toBe('Missing: Main gate, Office');
    expect(missingText({ status: 'COMPLETED', missing: [] })).toBeNull();
  });

  it('describes a schedule, or says the route is on demand', () => {
    expect(scheduleText(null)).toBe('On demand');
    expect(scheduleText({ intervalMinutes: 60, firstRunOffsetMinutes: 0, completionWindowMinutes: 30 })).toBe(
      'Every 60 min, 30 min to complete, first at start + 0 min',
    );
  });

  it("marks each of a round's checkpoints: verified, QR only, missing, or not yet", () => {
    expect(stopState('VERIFIED', true, 'COMPLETED').label).toBe('✓ Verified');
    expect(stopState('QR_ONLY', true, 'IN_PROGRESS').label).toBe('QR only');
    expect(stopState(null, true, 'MISSED').label).toBe('Missing');
    expect(stopState(null, true, 'INCOMPLETE').label).toBe('Missing');
    expect(stopState(null, false, 'INCOMPLETE').label).toBe('Not scanned');
    expect(stopState(null, true, 'PENDING').label).toBe('Not yet');
    expect(stopState(null, true, 'CANCELLED').label).toBe('Not scanned');
  });

  it("shows a round's window and its scans in the site's time zone", () => {
    const run = { dueAt: '2026-10-20T16:00:00Z', windowEndsAt: '2026-10-20T16:30:00Z', site: KARACHI };
    expect(runWindow(run)).toBe('21:00–21:30 GMT+5');
    expect(runWindow(run, true)).toBe('20 Oct 2026, 21:00–21:30 GMT+5');
    expect(scanTime('2026-10-20T16:05:09Z', 'Asia/Karachi')).toBe('21:05:09');
  });
});
