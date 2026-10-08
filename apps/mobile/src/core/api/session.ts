// The guard's device-bound session (ARCH §5.3, D-30). The sync engine renews it itself, with no
// identity-provider SDK, so uploads keep working while the app's screens are closed.
//
// - The access token is short-lived; it is renewed shortly before it expires, or once after a 401.
// - Renewal is single-flight: however many requests find the token expired at once, one
//   POST /sessions/refresh goes out and everyone waits for it.
// - Refresh tokens rotate on every use and an already-used one revokes the whole session, so the new
//   pair is written to the secure store before anything uses it.
// - If renewal is refused (401, or the device is revoked) the phone is signed out: tracking stops,
//   the queue is kept, and the guard sees "Signed out by your organization — pending data cannot be
//   sent". Network errors, 5xx and 429 are not refusals: the session is kept and retried later.
import type { SessionTokens } from '@sentryops/contracts';

import type { Logger } from '../log.ts';
import { ApiError, SignedOutError, type SignedOutReason } from './errors.ts';

export type StoredSession = {
  readonly v: 1;
  readonly deviceId: string;
  readonly guardId: string;
  readonly organizationId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAtMs: number;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAtMs: number;
};

/** Backed by the secure store (Keychain / Android Keystore-encrypted storage), never plain storage. */
export interface SessionStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

export type SessionManagerDeps = {
  readonly store: SessionStore;
  /** POST /sessions/refresh. */
  readonly refresh: (refreshToken: string) => Promise<SessionTokens>;
  /** The phone's clock corrected to server time (token expiry is a server instant). */
  readonly now: () => number;
  readonly logger: Logger;
  readonly onSignedOut: (reason: SignedOutReason) => Promise<void> | void;
};

/** Renew this long before the access token's expiry, to absorb clock error and request time. */
export const ACCESS_TOKEN_RENEW_MARGIN_MS = 60_000;

export function sessionFromTokens(
  ids: { deviceId: string; guardId: string; organizationId: string },
  tokens: SessionTokens,
): StoredSession {
  return {
    v: 1,
    deviceId: ids.deviceId,
    guardId: ids.guardId,
    organizationId: ids.organizationId,
    accessToken: tokens.accessToken,
    accessTokenExpiresAtMs: Date.parse(tokens.accessTokenExpiresAt),
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAtMs: Date.parse(tokens.refreshTokenExpiresAt),
  };
}

export class SessionManager {
  readonly #deps: SessionManagerDeps;
  #session: StoredSession | null = null;
  #refreshing: Promise<StoredSession> | null = null;
  #signedOut: SignedOutReason | null = null;

  constructor(deps: SessionManagerDeps) {
    this.#deps = deps;
  }

  async load(): Promise<StoredSession | null> {
    this.#session = await this.#deps.store.load();
    return this.#session;
  }

  /** After enrollment: the new session replaces any previous one. */
  async establish(session: StoredSession): Promise<void> {
    await this.#deps.store.save(session);
    this.#session = session;
    this.#signedOut = null;
  }

  get current(): StoredSession | null {
    return this.#session;
  }

  /** Set when the session was ended in this run (revoked, expired, device revoked). */
  get signedOutReason(): SignedOutReason | null {
    return this.#signedOut;
  }

  /** A usable access token, renewing it first if it is about to expire. */
  async accessToken(): Promise<string> {
    const session = this.#session;
    if (!session) throw new SignedOutError(this.#signedOut ?? 'NO_SESSION');
    if (this.#deps.now() < session.accessTokenExpiresAtMs - ACCESS_TOKEN_RENEW_MARGIN_MS) {
      return session.accessToken;
    }
    return (await this.refresh()).accessToken;
  }

  /** Renews the session. Concurrent callers share one request. */
  refresh(): Promise<StoredSession> {
    if (this.#refreshing) return this.#refreshing;
    const run = this.#doRefresh().finally(() => {
      if (this.#refreshing === run) this.#refreshing = null;
    });
    this.#refreshing = run;
    return run;
  }

  async #doRefresh(): Promise<StoredSession> {
    const session = this.#session;
    if (!session) throw new SignedOutError(this.#signedOut ?? 'NO_SESSION');
    if (this.#deps.now() >= session.refreshTokenExpiresAtMs) {
      await this.signOut('EXPIRED');
      throw new SignedOutError('EXPIRED');
    }
    let tokens: SessionTokens;
    try {
      tokens = await this.#deps.refresh(session.refreshToken);
    } catch (error) {
      const reason = refusalReason(error);
      if (reason) {
        await this.signOut(reason);
        throw new SignedOutError(reason);
      }
      throw error; // transient: keep the session, try again later
    }
    const next = sessionFromTokens(
      { deviceId: session.deviceId, guardId: session.guardId, organizationId: session.organizationId },
      tokens,
    );
    // The old refresh token died on the server the moment it was used: persist the new pair first.
    await this.#persist(next);
    this.#session = next;
    this.#deps.logger.info('session.renewed', { deviceId: session.deviceId });
    return next;
  }

  async #persist(next: StoredSession): Promise<void> {
    try {
      await this.#deps.store.save(next);
    } catch {
      try {
        await this.#deps.store.save(next);
      } catch {
        // Keep working with the new tokens in memory; if the app dies before the next successful
        // save, the stored (rotated) refresh token will be refused and the guard signed out.
        this.#deps.logger.error('session.persist-failed');
      }
    }
  }

  /**
   * Runs an authenticated call. A 401 renews the session once and retries; a second 401 is
   * returned to the caller (the lane backs off) rather than signing the guard out on a fresh token.
   */
  async withAuth<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken();
    try {
      return await call(token);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const current = this.#session;
        const fresh = current && current.accessToken !== token ? current : await this.refresh();
        return await call(fresh.accessToken);
      }
      const reason = deviceRefusal(error);
      if (reason) {
        await this.signOut(reason);
        throw new SignedOutError(reason);
      }
      throw error;
    }
  }

  /** Ends the session: tokens are deleted; the queue and the device identity stay. */
  async signOut(reason: SignedOutReason): Promise<void> {
    this.#session = null;
    this.#signedOut = reason;
    try {
      await this.#deps.store.clear();
    } catch {
      this.#deps.logger.error('session.clear-failed');
    }
    this.#deps.logger.warn('session.signed-out', { reason });
    await this.#deps.onSignedOut(reason);
  }
}

function deviceRefusal(error: unknown): SignedOutReason | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null;
  return error.code === 'DEVICE_REVOKED' || error.code === 'DEVICE_NOT_REGISTERED' ? 'DEVICE_REVOKED' : null;
}

/** Refresh refused for good: 401 (revoked, reused, disabled guard) or the device revoked. */
function refusalReason(error: unknown): SignedOutReason | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 401) return 'REVOKED';
  return deviceRefusal(error);
}
