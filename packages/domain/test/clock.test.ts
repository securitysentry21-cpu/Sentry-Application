import { describe, expect, it } from 'vitest';

import { FakeClock } from '../src/clock.ts';

describe('FakeClock', () => {
  it('returns the time it was set to and moves only when told', () => {
    const clock = new FakeClock('2026-10-08T19:57:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-10-08T19:57:00.000Z');
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-10-08T19:58:00.000Z');
  });

  it('refuses to go backwards', () => {
    expect(() => new FakeClock(0).advance(-1)).toThrow(RangeError);
  });

  it('hands out copies, so callers cannot change its time', () => {
    const clock = new FakeClock('2026-10-08T00:00:00.000Z');
    clock.now().setUTCFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
