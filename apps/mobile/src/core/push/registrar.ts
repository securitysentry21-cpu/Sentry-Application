// Telling the server this phone's Firebase token (D-26), so "SOS acknowledged" and shift notices can
// reach the phone. The token is an address, not a credential, but it is still not kept in the open:
// the phone remembers only a hash of the token it last registered, with the device it was registered
// for and when, so it registers again when:
//   - the system hands out a new token,
//   - the phone was enrolled again (a new device on the server has no token yet),
//   - the server's copy may be stale (once a day while the app is used).
// A failure is quietly retried the next time the app comes to the front. Nothing here can block the
// shift, the tracking or the SOS (INV-15).
import { sha256 } from '@noble/hashes/sha2.js';

import { base64UrlEncode } from '../encoding.ts';
import type { Logger } from '../log.ts';
import { errorKind } from '../log.ts';
import type { PushPort } from '../ports.ts';
import { META_KEYS, type MetaStore } from '../storage/meta.ts';
import { HOUR, type WallClock } from '../time.ts';

/** Register again at least this often while the app is used, in case the server lost the token. */
export const REREGISTER_AFTER_MS = 24 * HOUR;

type Registered = { deviceId: string; hash: string; atMs: number };
export type PushSyncResult = 'REGISTERED' | 'UNCHANGED' | 'NO_TOKEN' | 'NO_DEVICE' | 'FAILED';

export type PushRegistrarDeps = {
  readonly port: PushPort;
  readonly meta: MetaStore;
  readonly wall: WallClock;
  /** The device this phone is on the server, or null before enrollment. */
  readonly deviceId: () => string | null;
  /** Sends the token to the server; throws when it cannot (no network, no session, refused). */
  readonly register: (token: string) => Promise<void>;
  readonly logger: Logger;
};

export function tokenHash(token: string): string {
  return base64UrlEncode(sha256(new TextEncoder().encode(token)));
}

export class PushRegistrar {
  readonly #deps: PushRegistrarDeps;
  #running: Promise<PushSyncResult> | null = null;
  #stopListening: (() => void) | null = null;

  constructor(deps: PushRegistrarDeps) {
    this.#deps = deps;
  }

  /** Starts listening for new tokens. */
  start(): void {
    this.#stopListening ??= this.#deps.port.onTokenChange((token) => void this.sync(token));
  }

  stop(): void {
    this.#stopListening?.();
    this.#stopListening = null;
  }

  /** Registers the token if the server may not have it. Never throws; one run at a time. */
  sync(knownToken?: string): Promise<PushSyncResult> {
    this.#running ??= this.#sync(knownToken).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #sync(knownToken: string | undefined): Promise<PushSyncResult> {
    const { port, meta, wall, logger } = this.#deps;
    try {
      const deviceId = this.#deps.deviceId();
      if (!deviceId) return 'NO_DEVICE';
      const token = knownToken ?? (await port.getToken());
      if (!token) {
        logger.info('push.no-token');
        return 'NO_TOKEN';
      }
      const hash = tokenHash(token);
      const now = wall.nowMs();
      const last = await meta.getJson<Registered>(META_KEYS.pushRegistered);
      if (
        last &&
        last.deviceId === deviceId &&
        last.hash === hash &&
        now >= last.atMs &&
        now - last.atMs < REREGISTER_AFTER_MS
      ) {
        return 'UNCHANGED';
      }
      await this.#deps.register(token);
      await meta.setJson(META_KEYS.pushRegistered, { deviceId, hash, atMs: now } satisfies Registered);
      logger.info('push.registered', { deviceId });
      return 'REGISTERED';
    } catch (error) {
      logger.info('push.register-failed', { errorKind: errorKind(error) });
      return 'FAILED';
    }
  }
}
