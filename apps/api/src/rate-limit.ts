// Rate limits (SEC §9), keyed by account, device, phone number or organization — never only by IP,
// because carriers put many guards behind one address. Per-instance fixed windows (D-11): with a
// few API instances the effective limit is at most a small multiple, which is acceptable for V1.
import type { RateLimitClass } from '@sentryops/contracts';
import type { Clock } from '@sentryops/domain';

import { AppError } from './errors.ts';

type Limit = { readonly max: number; readonly windowMs: number };

const MINUTE = 60_000;

/** Defaults per class and key kind. `sos` and `none` are never limited (INV-15). */
export const LIMITS: Readonly<Partial<Record<RateLimitClass, Readonly<Record<string, Limit>>>>> = {
  default: { user: { max: 600, windowMs: MINUTE } },
  signin: { account: { max: 10, windowMs: 15 * MINUTE }, ip: { max: 60, windowMs: 15 * MINUTE } },
  invitation: { organization: { max: 1000, windowMs: 24 * 60 * MINUTE } },
  enrollment: {
    // Per code: 5 attempts, counted durably on the code itself (invitations.attempts).
    phone: { max: 10, windowMs: 60 * MINUTE },
    // An onboarding session puts a room of guards behind one Wi-Fi address (round 6, SEC §9).
    ip: { max: 120, windowMs: 60 * MINUTE },
  },
  sync: { device: { max: 120, windowMs: MINUTE } },
  scan: { guard: { max: 60, windowMs: MINUTE } },
  incident: { guard: { max: 20, windowMs: 60 * MINUTE } },
  report: { user: { max: 30, windowMs: MINUTE } },
};

export class RateLimiter {
  readonly #clock: Clock;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Counts one attempt; throws RATE_LIMITED (429) with the seconds to wait once over the limit. */
  hit(rateClass: RateLimitClass, keyKind: string, key: string): void {
    const limit = LIMITS[rateClass]?.[keyKind];
    if (!limit) return;
    const now = this.#clock.now().getTime();
    const id = `${rateClass}:${keyKind}:${key}`;
    let window = this.#windows.get(id);
    if (!window || now - window.start >= limit.windowMs) {
      window = { start: now, count: 0 };
      this.#windows.set(id, window);
    }
    window.count += 1;
    if (window.count > limit.max) {
      const retryAfterS = Math.max(1, Math.ceil((window.start + limit.windowMs - now) / 1000));
      throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.', undefined, retryAfterS);
    }
    if (this.#windows.size > 50_000) this.#prune(now);
  }

  #prune(now: number): void {
    for (const [id, window] of this.#windows) {
      if (now - window.start > 24 * 60 * MINUTE) this.#windows.delete(id);
    }
  }
}
