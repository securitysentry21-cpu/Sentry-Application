// All server code reads time from an injected Clock (ARCH §3). This file is the only place in
// packages/domain allowed to read the wall clock; lint bans it everywhere else.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock tests can move by hand. */
export class FakeClock implements Clock {
  #ms: number;

  constructor(start: Date | string | number) {
    this.#ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#ms);
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError('a FakeClock only moves forward');
    this.#ms += ms;
  }

  set(to: Date | string | number): void {
    this.#ms = new Date(to).getTime();
  }
}
