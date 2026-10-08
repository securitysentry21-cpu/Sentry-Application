// Dashboard sessions (ARCH §5.2) and OIDC sign-in state. Both store only SHA-256 hashes of the
// random values the browser holds.
import type { Database } from '@sentryops/db';

import { sha256 } from '../ids.ts';

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** last_seen_at is refreshed at most this often, so reads don't turn every request into a write. */
const TOUCH_EVERY_MS = 60 * 1000;
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type ResolvedSession = {
  readonly sessionId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string | null;
  readonly userStatus: string;
};

export async function createSession(
  db: Database,
  input: {
    id: string;
    token: string;
    userId: string;
    now: Date;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  const absolute = new Date(input.now.getTime() + SESSION_ABSOLUTE_MS);
  await db
    .insertInto('dashboard_sessions')
    .values({
      id: input.id,
      user_id: input.userId,
      token_hash: sha256(input.token),
      created_at: input.now,
      last_seen_at: input.now,
      idle_expires_at: new Date(Math.min(input.now.getTime() + SESSION_IDLE_MS, absolute.getTime())),
      absolute_expires_at: absolute,
      ip_address: input.ip,
      user_agent: input.userAgent?.slice(0, 500) ?? null,
    })
    .execute();
}

/** A live session for an ACTIVE user, or null. A disabled user's sessions are revoked on sight. */
export async function resolveSession(
  db: Database,
  token: string,
  now: Date,
): Promise<ResolvedSession | null> {
  const row = await db
    .selectFrom('dashboard_sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select([
      's.id',
      's.user_id',
      's.last_seen_at',
      's.idle_expires_at',
      's.absolute_expires_at',
      's.revoked_at',
      'u.name',
      'u.email',
      'u.status',
    ])
    .where('s.token_hash', '=', sha256(token))
    .executeTakeFirst();
  if (!row || row.revoked_at) return null;
  if (row.idle_expires_at <= now || row.absolute_expires_at <= now) return null;
  if (row.status !== 'ACTIVE') {
    await revokeSession(db, row.id, 'USER_DISABLED', now);
    return null;
  }
  if (now.getTime() - row.last_seen_at.getTime() >= TOUCH_EVERY_MS) {
    const idle = Math.min(now.getTime() + SESSION_IDLE_MS, row.absolute_expires_at.getTime());
    await db
      .updateTable('dashboard_sessions')
      .set({ last_seen_at: now, idle_expires_at: new Date(idle) })
      .where('id', '=', row.id)
      .execute();
  }
  return { sessionId: row.id, userId: row.user_id, name: row.name, email: row.email, userStatus: row.status };
}

export async function revokeSession(
  db: Database,
  sessionId: string,
  reason: 'SIGNED_OUT' | 'USER_DISABLED' | 'ADMIN',
  now: Date,
): Promise<void> {
  await db
    .updateTable('dashboard_sessions')
    .set({ revoked_at: now, revoked_reason: reason })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}

export async function saveAuthState(
  db: Database,
  input: { id: string; state: string; nonce: string; codeVerifier: string; returnTo: string; now: Date },
): Promise<void> {
  await db
    .insertInto('auth_states')
    .values({
      id: input.id,
      state_hash: sha256(input.state),
      nonce: input.nonce,
      code_verifier: input.codeVerifier,
      return_to: input.returnTo,
      expires_at: new Date(input.now.getTime() + AUTH_STATE_TTL_MS),
      created_at: input.now,
    })
    .execute();
  // Expired states are only clutter; clearing them on write needs no job.
  await db.deleteFrom('auth_states').where('expires_at', '<', input.now).execute();
}

/** Single use: the state is marked used in the same statement that reads it. */
export async function consumeAuthState(
  db: Database,
  state: string,
  now: Date,
): Promise<{ nonce: string; codeVerifier: string; returnTo: string } | null> {
  const row = await db
    .updateTable('auth_states')
    .set({ used_at: now })
    .where('state_hash', '=', sha256(state))
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .returning(['nonce', 'code_verifier', 'return_to'])
    .executeTakeFirst();
  return row ? { nonce: row.nonce, codeVerifier: row.code_verifier, returnTo: row.return_to } : null;
}
