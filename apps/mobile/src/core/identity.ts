// This installation's identity (ARCH §5.4): a random installation ID and the P-256 device key, both
// in the secure store, plus the session (src/core/api/session.ts). Hardware identifiers are never
// used. A reinstall is a new installation: iOS keeps Keychain items across uninstall, so when the
// local database is brand new (first launch after an install) every secure item is wiped first.
import type { StoredSession, SessionStore } from './api/session.ts';
import { generateSecretKey, isValidSecretKey } from './device-key.ts';
import { hexDecode, hexEncode } from './encoding.ts';
import { type IdFactory, isUuidV4, type RandomBytes } from './ids.ts';
import type { SecureKV } from './ports.ts';

export const SECURE_KEYS = {
  installationId: 'sentry.installationId.v1',
  deviceKey: 'sentry.deviceKey.v1',
  session: 'sentry.session.v1',
} as const;

export type Installation = { readonly installationId: string; readonly secretKey: Uint8Array };

/** Wipes everything this app kept in the secure store (fresh install, see above). */
export async function wipeSecureStore(kv: SecureKV): Promise<void> {
  for (const key of Object.values(SECURE_KEYS)) await kv.delete(key);
}

/** Reads the installation ID and device key, creating them on first use. */
export async function loadOrCreateInstallation(
  kv: SecureKV,
  ids: IdFactory,
  random: RandomBytes,
): Promise<Installation> {
  let installationId = await kv.get(SECURE_KEYS.installationId);
  if (!installationId || !isUuidV4(installationId)) {
    installationId = ids.uuidv4();
    await kv.set(SECURE_KEYS.installationId, installationId);
  }
  let secretKey: Uint8Array | null = null;
  const stored = await kv.get(SECURE_KEYS.deviceKey);
  if (stored) {
    try {
      const decoded = hexDecode(stored);
      if (isValidSecretKey(decoded)) secretKey = decoded;
    } catch {
      secretKey = null;
    }
  }
  if (!secretKey) {
    secretKey = generateSecretKey(random);
    await kv.set(SECURE_KEYS.deviceKey, hexEncode(secretKey));
  }
  return { installationId, secretKey };
}

/** The session, as one secure-store value, so tokens are always replaced together. */
export function secureSessionStore(kv: SecureKV): SessionStore {
  return {
    async load() {
      const text = await kv.get(SECURE_KEYS.session);
      if (!text) return null;
      try {
        const value = JSON.parse(text) as Partial<StoredSession>;
        if (
          value.v === 1 &&
          typeof value.deviceId === 'string' &&
          typeof value.guardId === 'string' &&
          typeof value.organizationId === 'string' &&
          typeof value.accessToken === 'string' &&
          typeof value.refreshToken === 'string' &&
          typeof value.accessTokenExpiresAtMs === 'number' &&
          typeof value.refreshTokenExpiresAtMs === 'number'
        ) {
          return value as StoredSession;
        }
      } catch {
        // unreadable: treat as no session
      }
      return null;
    },
    save: (session) => kv.set(SECURE_KEYS.session, JSON.stringify(session)),
    clear: () => kv.delete(SECURE_KEYS.session),
  };
}
