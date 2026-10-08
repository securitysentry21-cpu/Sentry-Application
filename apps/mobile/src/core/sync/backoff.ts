// Retry timing (ARCH §8.5): exponential backoff with full jitter, base 5 s, cap 5 min, and the
// server's Retry-After on 429/503 (SEC §9, ADV-L12).

export type BackoffPolicy = { baseMs: number; capMs: number };

/** Main lane (ARCH §8.5). */
export const MAIN_LANE_BACKOFF: BackoffPolicy = { baseMs: 5_000, capMs: 300_000 };

/**
 * SOS lane (agent decision): the spec fixes no SOS retry cadence, and a 5-minute cap could leave an
 * emergency waiting minutes after the network returns. The server never rate-limits SOS (INV-15),
 * so the SOS lane retries quickly: base 2 s, cap 30 s. A regained network also retries at once.
 */
export const SOS_LANE_BACKOFF: BackoffPolicy = { baseMs: 2_000, capMs: 30_000 };

/**
 * Full jitter ("Exponential Backoff And Jitter", AWS): a uniform random delay in [0, min(cap, base·2^n)].
 * `failures` counts consecutive failures (1 for the first retry). `random01` returns [0, 1).
 */
export function fullJitterDelayMs(failures: number, random01: () => number, policy: BackoffPolicy): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** exponent);
  const r = random01();
  const unit = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
  return Math.floor(unit * ceiling);
}

/**
 * Retry-After (RFC 9110 §10.2.3): delay-seconds or an HTTP date. Returns milliseconds to wait, or
 * null when absent or unreadable. A date in the past means "now" (0).
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number.parseInt(text, 10);
    return Number.isSafeInteger(seconds) ? Math.min(seconds, 24 * 3_600) * 1_000 : null;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - nowMs, 0), 24 * 3_600 * 1_000);
}
