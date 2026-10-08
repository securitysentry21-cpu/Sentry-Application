import { describe, expect, it } from 'vitest';

import { estimateCapture, inShiftWindow, locationAge, trackingHealth } from '../src/tracking.ts';

const S = { healthLiveMaxS: 90, offlineAfterS: 300, locationCurrentMaxS: 150 };
const T0 = new Date('2026-10-20T15:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('freshness (D-36, INV-09)', () => {
  it('ADV-U04 a stationary guard: health and location age are separate signals', () => {
    // Heartbeat 8 s ago, newest fix 4 minutes old: "LIVE · last update 8 s ago" and
    // "Last known location · 4 min ago" — never shown as a live location.
    const now = at(240);
    expect(trackingHealth(now, at(232), S)).toBe('LIVE');
    expect(locationAge(now, at(0), S)).toBe('LAST_KNOWN');
    // The phone then stops reporting: DELAYED, then OFFLINE, on time, with no new events.
    expect(trackingHealth(at(232 + 91), at(232), S)).toBe('DELAYED');
    expect(trackingHealth(at(232 + 301), at(232), S)).toBe('OFFLINE');
  });

  it('ADV-U01 with no events for 6 minutes after a current fix from a live phone: DELAYED, then OFFLINE, LAST KNOWN', () => {
    expect(trackingHealth(at(10), at(0), S)).toBe('LIVE');
    expect(locationAge(at(10), at(0), S)).toBe('CURRENT');
    expect(trackingHealth(at(120), at(0), S)).toBe('DELAYED');
    expect(trackingHealth(at(360), at(0), S)).toBe('OFFLINE');
    expect(locationAge(at(360), at(0), S)).toBe('LAST_KNOWN');
    expect(locationAge(at(360), null, S)).toBe('UNKNOWN');
  });
});

describe('capture time (ARCH §8.7, INV-07)', () => {
  const received = at(600);

  it('ADV-L10 a phone clock set 2 hours ahead: the monotonic estimate is right and the item is flagged', () => {
    const e = estimateCapture({
      receivedAt: received,
      recordedAt: new Date(at(570).getTime() + 2 * 3_600_000), // the phone thinks it is 2 h later
      itemMonoMs: 1_000_000,
      batchSentMonoMs: 1_030_000, // captured 30 s before sending
      sameBoot: true,
    });
    expect(e.capturedAt.toISOString()).toBe(at(570).toISOString());
    expect(e.clockStatus).toBe('VERIFIED_MONOTONIC');
    expect(e.flags).toContain('SKEWED_CLOCK');
  });

  it('ADV-L03 a capture time in the future is clamped to receipt and flagged, never stored as future', () => {
    const e = estimateCapture({
      receivedAt: received,
      recordedAt: at(900),
      itemMonoMs: 5,
      batchSentMonoMs: 1,
      sameBoot: false,
    });
    expect(e.capturedAt.toISOString()).toBe(received.toISOString());
    expect(e.flags).toContain('SKEWED_CLOCK');
    expect(e.clockStatus).toBe('SKEWED');
  });

  it('another boot falls back to the phone clock, unflagged when it is plausible', () => {
    const e = estimateCapture({
      receivedAt: received,
      recordedAt: at(590),
      itemMonoMs: 9_999_999,
      batchSentMonoMs: 1,
      sameBoot: false,
    });
    expect(e).toEqual({ capturedAt: at(590), clockStatus: 'DEVICE_CLOCK_ONLY', flags: [] });
  });

  it('the shift window is start − 60 s to (end or now) + 60 s', () => {
    expect(inShiftWindow(at(-59), at(0), null, at(100))).toBe(true);
    expect(inShiftWindow(at(-61), at(0), null, at(100))).toBe(false);
    expect(inShiftWindow(at(160), at(0), at(100), at(500))).toBe(true);
    expect(inShiftWindow(at(161), at(0), at(100), at(500))).toBe(false);
    expect(inShiftWindow(at(10), null, null, at(100))).toBe(false);
  });
});
