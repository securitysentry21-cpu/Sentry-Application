import { describe, expect, it } from 'vitest';

import {
  fullJitterDelayMs,
  MAIN_LANE_BACKOFF,
  parseRetryAfterMs,
  SOS_LANE_BACKOFF,
} from '../src/core/sync/backoff.ts';

describe('backoff (ARCH §8.5)', () => {
  it('is full jitter: uniform in [0, min(cap, 5 s · 2^(n-1))]', () => {
    expect(fullJitterDelayMs(1, () => 0.999_999, MAIN_LANE_BACKOFF)).toBe(4_999);
    expect(fullJitterDelayMs(2, () => 0.999_999, MAIN_LANE_BACKOFF)).toBe(9_999);
    expect(fullJitterDelayMs(4, () => 0.5, MAIN_LANE_BACKOFF)).toBe(20_000);
    expect(fullJitterDelayMs(1, () => 0, MAIN_LANE_BACKOFF)).toBe(0);
  });

  it('never exceeds the 5-minute cap, however many failures', () => {
    for (const n of [7, 8, 20, 100, 10_000]) {
      expect(fullJitterDelayMs(n, () => 0.999_999, MAIN_LANE_BACKOFF)).toBeLessThan(300_000);
    }
    expect(fullJitterDelayMs(50, () => 0.999_999, SOS_LANE_BACKOFF)).toBeLessThan(30_000);
  });

  it('survives a broken random source', () => {
    expect(fullJitterDelayMs(3, () => Number.NaN, MAIN_LANE_BACKOFF)).toBe(0);
    expect(fullJitterDelayMs(3, () => 7, MAIN_LANE_BACKOFF)).toBe(20_000);
  });

  it('ADV-L12 reads Retry-After as seconds or as an HTTP date', () => {
    const now = Date.parse('2026-10-08T15:00:00.000Z');
    expect(parseRetryAfterMs('30', now)).toBe(30_000);
    expect(parseRetryAfterMs(' 0 ', now)).toBe(0);
    expect(parseRetryAfterMs('Thu, 08 Oct 2026 15:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfterMs('Thu, 08 Oct 2026 14:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs('soon', now)).toBeNull();
    expect(parseRetryAfterMs('999999999', now)).toBe(86_400_000);
  });
});
