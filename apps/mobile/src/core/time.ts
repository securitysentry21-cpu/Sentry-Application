// Time sources (ARCH §8.7). Core logic never reads the clock itself: every module receives these
// interfaces, so tests drive time by hand.
//
// - WallClock: the phone's wall clock. Evidence, never authority (INV-07). It can be wrong or jump.
// - MonoClock: a monotonic millisecond counter for this process run (`monoMs`). Expo exposes no
//   SystemClock.elapsedRealtime / mach_continuous_time, so the app uses performance.now(). That
//   clock starts near 0 when the process starts and, on both platforms, may not advance while the
//   phone is in deep sleep. See apps/mobile/README.md, "Time and the monotonic clock".
// - bootId: a random ID for this process run. Two items share a bootId only if their monoMs values
//   come from the same counter, so the server uses the monotonic estimate only within one run.

export interface WallClock {
  /** Milliseconds since the Unix epoch, from the phone's clock. */
  nowMs(): number;
}

export interface MonoClock {
  /** Monotonic milliseconds since this process run started; never decreases, always an integer ≥ 0. */
  nowMs(): number;
}

export type Clocks = {
  readonly wall: WallClock;
  readonly mono: MonoClock;
  /** This process run's ID (the `bootId` the contract carries). */
  readonly bootId: string;
};

/** Wraps a raw source (e.g. performance.now) so readings are integers and never go backwards. */
export function monotonic(source: () => number): MonoClock {
  let last = 0;
  return {
    nowMs() {
      const raw = Math.floor(source());
      if (Number.isFinite(raw) && raw > last) last = raw;
      return last;
    },
  };
}

/**
 * A clock pair tests can move by hand. Real time, the phone's wall clock and the monotonic clock
 * advance together; `setWall` changes only the phone's wall clock (a guard changing the time).
 */
export class ManualClocks implements Clocks {
  #real: number;
  #wall: number;
  #mono: number;
  readonly bootId: string;

  constructor(startWallMs: number, bootId = 'test-boot', startMonoMs = 1_000) {
    this.#real = startWallMs;
    this.#wall = startWallMs;
    this.#mono = startMonoMs;
    this.bootId = bootId;
  }

  readonly wall: WallClock = { nowMs: () => this.#wall };
  readonly mono: MonoClock = { nowMs: () => this.#mono };

  /** The true time (what a correct server clock reads). */
  realMs(): number {
    return this.#real;
  }

  /** Real time passes: every clock moves. */
  advance(ms: number): void {
    if (ms < 0) throw new RangeError('time only moves forward');
    this.#real += ms;
    this.#wall += ms;
    this.#mono += ms;
  }

  /** The user changes the phone's clock: only the wall clock jumps. */
  setWall(ms: number): void {
    this.#wall = ms;
  }

  /** A new process run (app killed and reopened): new bootId, the monotonic clock restarts. */
  restart(bootId: string, startMonoMs = 1_000): ManualClocks {
    const next = new ManualClocks(this.#wall, bootId, startMonoMs);
    next.#real = this.#real;
    return next;
  }
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const isoFromMs = (ms: number): string => new Date(ms).toISOString();

export function msFromIso(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`not an ISO instant: ${iso}`);
  return ms;
}
