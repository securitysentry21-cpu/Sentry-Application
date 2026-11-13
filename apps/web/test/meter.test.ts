import { describe, expect, it } from 'vitest';

import { allocateTicks } from '../lib/meter';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('tick meters (components/meter.tsx)', () => {
  it('fill each part in proportion to the whole', () => {
    expect(allocateTicks([21], 24, 24)).toEqual([21]);
    expect(allocateTicks([3], 5, 24)).toEqual([14]);
    // Four live and one offline out of five, on 36 ticks: the rounding goes to the larger remainder.
    expect(allocateTicks([4, 0, 1], 5, 36)).toEqual([29, 0, 7]);
  });

  it('light at least one tick for any part above zero, so one offline guard among a thousand shows', () => {
    expect(allocateTicks([1], 1000, 24)).toEqual([1]);
    const split = allocateTicks([998, 1, 1], 1000, 24);
    expect(split).toEqual([22, 1, 1]);
    expect(sum(split)).toBe(24);
  });

  it('light nothing for zero, an empty whole or values that are not counts', () => {
    expect(allocateTicks([0], 24, 24)).toEqual([0]);
    expect(allocateTicks([5, 3], 0, 24)).toEqual([0, 0]);
    expect(allocateTicks([-2, Number.NaN, 4], 8, 16)).toEqual([0, 0, 8]);
  });

  it('never fill more ticks than the meter has', () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const total = 1 + random(1500);
      const parts = [random(total + 1), random(total + 1), random(total + 1)];
      const ticks = 8 + random(40);
      const filled = allocateTicks(parts, total, ticks);
      expect(sum(filled)).toBeLessThanOrEqual(ticks);
      parts.forEach((p, k) => expect(filled[k]! > 0).toBe(p > 0));
    }
  });
});
