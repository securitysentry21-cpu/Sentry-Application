// Our own device-bound mobile session (D-30, ARCH §5.3). Access tokens last 15 minutes; refresh
// tokens last 30 days (sliding), rotate on every use and are stored only as SHA-256 hashes.
// Presenting a refresh token that was already rotated revokes the whole family, with one exception:
// within 30 seconds of the rotation it is treated as the phone retrying a request whose response it
// never received (mobile networks drop responses), so a new session is issued and the one minted by
// the lost response is revoked. Only ever one live session per family.
import type { SessionTokens } from '@sentryops/contracts';
import { withTenantTransaction, type Database } from '@sentryops/db';

import { REPLACED_DRAIN_MS } from '../context.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../errors.ts';
import { randomToken, uuidv7 } from '../ids.ts';
import {
  insertSession,
  loadSession,
  markRotated,
  revokeFamily,
  revokeUnrotatedInFamily,
  sessionIdByRefresh,
} from '../repositories/guards.ts';

export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ROTATION_GRACE_MS = 30 * 1000;
const REFRESH_TOKEN = /^sr_[A-Za-z0-9_-]{43}$/;

export async function issueSession(
  trx: Database,
  deps: AppDeps,
  input: { organizationId: string; guardId: string; deviceId: string; familyId: string },
): Promise<SessionTokens> {
  const now = deps.clock.now();
  const accessToken = `sa_${randomToken(32)}`;
  const refreshToken = `sr_${randomToken(32)}`;
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TTL_MS);
  const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
  await insertSession(trx, {
    id: uuidv7(deps.clock),
    ...input,
    accessToken,
    accessExpiresAt,
    refreshToken,
    expiresAt,
    now,
  });
  return {
    accessToken,
    accessTokenExpiresAt: accessExpiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: expiresAt.toISOString(),
  };
}

export async function refreshSession(deps: AppDeps, refreshToken: string): Promise<SessionTokens> {
  const signedOut = () => new AppError('UNAUTHENTICATED', 'Signed out by your organization.');
  if (!REFRESH_TOKEN.test(refreshToken)) throw signedOut();
  const found = await sessionIdByRefresh(deps.db, refreshToken);
  if (!found) throw signedOut();
  const now = deps.clock.now();
  const outcome = await withTenantTransaction(deps.db, found.organization_id, async (trx) => {
    const session = await loadSession(trx, found.organization_id, found.id, true);
    if (!session || session.revoked_at || session.expires_at <= now) return { ok: false as const };
    if (session.rotated_at) {
      if (now.getTime() - session.rotated_at.getTime() > ROTATION_GRACE_MS) {
        // Reuse of a rotated token: someone else may hold it. Everything in the family goes.
        await revokeFamily(trx, found.organization_id, session.family_id, 'ROTATION_REUSE', now);
        return { ok: false as const, reuse: true };
      }
      await revokeUnrotatedInFamily(trx, found.organization_id, session.family_id, now);
    }
    // A replaced phone may keep refreshing while it drains (ARCH §5.4); the API still limits it to
    // uploads captured before the replacement.
    const draining =
      session.device_status === 'REVOKED' &&
      session.device_revoked_reason === 'REPLACED' &&
      session.device_revoked_at !== null &&
      now.getTime() - session.device_revoked_at.getTime() <= REPLACED_DRAIN_MS;
    if ((session.device_status !== 'ACTIVE' && !draining) || session.guard_status !== 'ACTIVE')
      return { ok: false as const };
    await markRotated(trx, found.organization_id, session.id, now);
    const tokens = await issueSession(trx, deps, {
      organizationId: found.organization_id,
      guardId: session.guard_id,
      deviceId: session.device_id,
      familyId: session.family_id,
    });
    return { ok: true as const, tokens };
  });
  if (!outcome.ok) throw signedOut();
  return outcome.tokens;
}
