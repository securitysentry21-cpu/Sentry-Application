import type { SessionTokens } from '@sentryops/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError, NetworkError, SignedOutError, type SignedOutReason } from '../src/core/api/errors.ts';
import { SessionManager, type SessionStore, type StoredSession } from '../src/core/api/session.ts';
import { silentLogger } from '../src/core/log.ts';

const T0 = Date.parse('2026-10-08T15:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A refresh endpoint that rotates the refresh token on every use and refuses reuse. */
class RefreshServer {
  current = 'refresh-0-aaaaaaaaaaaaaaaaaaaa';
  used = new Set<string>();
  calls: string[] = [];
  failures: Error[] = [];
  hold: Promise<void> | null = null;
  n = 0;
  now = T0;

  readonly refresh = async (refreshToken: string): Promise<SessionTokens> => {
    this.calls.push(refreshToken);
    if (this.hold) await this.hold;
    const failure = this.failures.shift();
    if (failure) throw failure;
    if (this.used.has(refreshToken) || refreshToken !== this.current)
      throw new ApiError(401, 'UNAUTHENTICATED', null, null);
    this.used.add(refreshToken);
    this.n++;
    this.current = `refresh-${this.n}-aaaaaaaaaaaaaaaaaaaa`;
    return {
      accessToken: `access-${this.n}`,
      accessTokenExpiresAt: iso(this.now + 15 * 60_000),
      refreshToken: this.current,
      refreshTokenExpiresAt: iso(this.now + 14 * 86_400_000),
    };
  };
}

class Store implements SessionStore {
  saved: StoredSession | null = null;
  log: string[] = [];
  load = () => Promise.resolve(this.saved);
  save = (s: StoredSession) => {
    this.saved = s;
    this.log.push(`save:${s.refreshToken}`);
    return Promise.resolve();
  };
  clear = () => {
    this.saved = null;
    this.log.push('clear');
    return Promise.resolve();
  };
}

const initial = (now: number): StoredSession => ({
  v: 1,
  deviceId: 'device-1',
  guardId: 'guard-1',
  organizationId: 'org-1',
  accessToken: 'access-0',
  accessTokenExpiresAtMs: now + 15 * 60_000,
  refreshToken: 'refresh-0-aaaaaaaaaaaaaaaaaaaa',
  refreshTokenExpiresAtMs: now + 14 * 86_400_000,
});

let now: number;
let server: RefreshServer;
let store: Store;
let signedOut: SignedOutReason[];
let session: SessionManager;

beforeEach(async () => {
  now = T0;
  server = new RefreshServer();
  store = new Store();
  signedOut = [];
  session = new SessionManager({
    store,
    refresh: server.refresh,
    now: () => now,
    logger: silentLogger,
    onSignedOut: (reason) => {
      signedOut.push(reason);
    },
  });
  await session.establish(initial(T0));
});

describe('device-bound session (ARCH §5.3, D-30)', () => {
  it('uses the access token until shortly before it expires, then renews it', async () => {
    expect(await session.accessToken()).toBe('access-0');
    now = T0 + 14 * 60_000 + 1; // inside the one-minute renewal margin
    server.now = now;
    expect(await session.accessToken()).toBe('access-1');
    expect(server.calls).toHaveLength(1);
  });

  it('renews single-flight: ten callers with an expired token cause one refresh', async () => {
    now = T0 + 20 * 60_000;
    server.now = now;
    let release: () => void = () => undefined;
    server.hold = new Promise((r) => (release = r));
    const tokens = Array.from({ length: 10 }, () => session.accessToken());
    release();
    expect(new Set(await Promise.all(tokens))).toEqual(new Set(['access-1']));
    expect(server.calls).toEqual(['refresh-0-aaaaaaaaaaaaaaaaaaaa']);
  });

  it('stores the rotated refresh token before using the new access token, and uses it next time', async () => {
    const order: string[] = [];
    const original = store.save;
    store.save = (s) => {
      order.push(`saved:${s.accessToken}`);
      return original(s);
    };
    now = T0 + 20 * 60_000;
    server.now = now;
    await session.withAuth((token) => {
      order.push(`used:${token}`);
      return Promise.resolve();
    });
    expect(order).toEqual(['saved:access-1', 'used:access-1']);
    expect(store.saved?.refreshToken).toBe('refresh-1-aaaaaaaaaaaaaaaaaaaa');
    now = T0 + 40 * 60_000;
    server.now = now;
    await session.accessToken();
    expect(server.calls).toEqual(['refresh-0-aaaaaaaaaaaaaaaaaaaa', 'refresh-1-aaaaaaaaaaaaaaaaaaaa']);
  });

  it('on a 401 renews once and retries the call with the new token', async () => {
    const seen: string[] = [];
    const result = await session.withAuth((token) => {
      seen.push(token);
      if (token === 'access-0') return Promise.reject(new ApiError(401, 'UNAUTHENTICATED', null, null));
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['access-0', 'access-1']);
  });

  it('keeps the session when renewal fails for a network error, 5xx or 429', async () => {
    now = T0 + 20 * 60_000;
    server.now = now;
    server.failures = [
      new NetworkError('NETWORK'),
      new ApiError(503, 'NOT_READY', null, null),
      new ApiError(429, 'RATE_LIMITED', null, 1_000),
    ];
    for (let i = 0; i < 3; i++)
      await expect(session.accessToken()).rejects.not.toBeInstanceOf(SignedOutError);
    expect(signedOut).toEqual([]);
    expect(session.current).not.toBeNull();
    expect(await session.accessToken()).toBe('access-1');
  });

  it('signs out when renewal is refused (revoked, reused, disabled) — tokens deleted, reason kept', async () => {
    now = T0 + 20 * 60_000;
    server.now = now;
    server.failures = [new ApiError(401, 'UNAUTHENTICATED', null, null)];
    await expect(session.accessToken()).rejects.toBeInstanceOf(SignedOutError);
    expect(signedOut).toEqual(['REVOKED']);
    expect(session.current).toBeNull();
    expect(store.saved).toBeNull();
    await expect(session.withAuth(() => Promise.resolve(1))).rejects.toMatchObject({ reason: 'REVOKED' });
  });

  it('signs out as DEVICE_REVOKED when the server says the device was revoked', async () => {
    await expect(
      session.withAuth(() => Promise.reject(new ApiError(403, 'DEVICE_REVOKED', null, null))),
    ).rejects.toMatchObject({ reason: 'DEVICE_REVOKED' });
    expect(signedOut).toEqual(['DEVICE_REVOKED']);
  });

  it('signs out as EXPIRED when the refresh token itself has expired (long offline)', async () => {
    now = T0 + 15 * 86_400_000;
    await expect(session.accessToken()).rejects.toMatchObject({ reason: 'EXPIRED' });
    expect(server.calls).toEqual([]);
    expect(signedOut).toEqual(['EXPIRED']);
  });
});
