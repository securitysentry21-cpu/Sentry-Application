// The server's clock as seen from the phone (ARCH §8.7, §15.1). Every response carries
// X-Server-Time; the phone keeps the offset to its own clock and warns the guard when its clock is
// more than 2 minutes off (PROD §7.6). The offset corrects local decisions that compare against
// server instants (the end-of-shift failsafe, token expiry). It never rewrites what the phone
// records: `recordedAt` stays the phone's own clock, as evidence (INV-07).

export const CLOCK_SKEW_WARNING_MS = 2 * 60_000;

export class ServerTime {
  #offsetMs: number | null;
  #observedAtMs: number | null = null;

  constructor(initialOffsetMs: number | null = null) {
    this.#offsetMs = initialOffsetMs;
  }

  /** Restores the offset saved by an earlier run, unless this run has already measured one. */
  restore(offsetMs: number): void {
    if (this.#offsetMs === null && Number.isFinite(offsetMs)) this.#offsetMs = offsetMs;
  }

  /**
   * Records one response. The server stamped the time somewhere between sending and receiving, so
   * the midpoint of the round trip is the best estimate of the phone's clock at that moment.
   */
  observe(serverTimeIso: string | null, sentAtMs: number, receivedAtMs: number): void {
    if (!serverTimeIso) return;
    const serverMs = Date.parse(serverTimeIso);
    if (Number.isNaN(serverMs)) return;
    const midpoint = sentAtMs + Math.max(0, receivedAtMs - sentAtMs) / 2;
    this.#offsetMs = Math.round(serverMs - midpoint);
    this.#observedAtMs = receivedAtMs;
  }

  /** Server time minus phone time, in ms; null until the first response. */
  get offsetMs(): number | null {
    return this.#offsetMs;
  }

  get observedAtMs(): number | null {
    return this.#observedAtMs;
  }

  /** The phone's clock corrected by the last known offset. */
  correct(wallMs: number): number {
    return wallMs + (this.#offsetMs ?? 0);
  }

  /** True when the phone's clock is more than 2 minutes away from the server's. */
  get skewed(): boolean {
    return this.#offsetMs !== null && Math.abs(this.#offsetMs) > CLOCK_SKEW_WARNING_MS;
  }
}
