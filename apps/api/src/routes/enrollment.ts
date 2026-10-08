// Guard enrollment, mobile sessions and devices (D-02, D-30, D-31, SEC §5).
//
// A supervisor (or above) issues a code from the dashboard and hands it to the guard. The guard app
// redeems it with the guard's own phone number and the phone's public key. The code alone is not
// enough, and an SMS to the number alone is never enough (ADV-A11, ADV-A12): redemption needs a code
// that is unused, unexpired, under its attempt limit, and issued for exactly this phone number.
import { createPublicKey } from 'node:crypto';

import {
  deviceListResponseSchema,
  deviceRevokeRequestSchema,
  deviceSchema,
  enrollmentCodeResponseSchema,
  enrollmentRedeemRequestSchema,
  enrollmentRedeemResponseSchema,
  errorEnvelopeSchema,
  sessionRefreshRequestSchema,
  sessionRefreshResponseSchema,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { z } from 'zod';

import {
  ENROLLMENT_QR_PREFIX,
  enrollmentCodeHash,
  newEnrollmentCode,
  normalizeEnrollmentCode,
} from '../auth/codes.ts';
import { issueSession, refreshSession } from '../auth/mobile.ts';
import { auditActor, orgOf, userOf } from '../context.ts';
import { AppError, notFound } from '../errors.ts';
import { randomToken, uuidv7 } from '../ids.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  activeDevice,
  findDeviceByInstallation,
  getDevice,
  getGuard,
  insertDevice,
  listDevices,
  reactivateDevice,
  linkGuardUser,
  revokeDevice,
  type DeviceRow,
} from '../repositories/guards.ts';
import {
  codesIssuedSince,
  countEnrollmentAttempt,
  createEnrollmentCode,
  enrollmentOrganizationByCode,
  lockEnrollmentCode,
  markInvitationAccepted,
  revokePendingCodes,
} from '../repositories/invitations.ts';
import { findMemberByUser, insertMember } from '../repositories/memberships.ts';
import { getOrganization } from '../repositories/organizations.ts';
import { ensurePhoneUser } from '../repositories/users.ts';
import { defineRoute } from './registry.ts';

const MAX_ATTEMPTS = 5;
const CODES_PER_DAY = 3;

export function deviceDto(d: DeviceRow) {
  return {
    id: d.id,
    platform: d.platform,
    manufacturer: d.manufacturer,
    model: d.model,
    osVersion: d.osVersion,
    appVersion: d.appVersion,
    status: d.status,
    revokedReason: d.revokedReason,
    revokedAt: d.revokedAt?.toISOString() ?? null,
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

/** A P-256 public key in SPKI DER, or null. The algorithm must match what the app declares. */
function parsePublicKey(base64: string): Buffer | null {
  try {
    const der = Buffer.from(base64, 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') return null;
    return der;
  } catch {
    return null;
  }
}

export const enrollmentRoutes = [
  defineRoute({
    method: 'POST',
    url: '/api/v1/guards/:id/enrollment-codes',
    summary: "Issues a single-use code that enrolls the guard's phone (or moves them to a new one).",
    policy: {
      access: { kind: 'permission', permission: 'devices.enroll' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'DEVICE_ENROLLMENT_CODE_ISSUED',
    },
    params: z.object({ id: z.uuid() }),
    responses: { 201: enrollmentCodeResponseSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, params }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const now = deps.clock.now();
      const issued = await withTenantTransaction(deps.db, org.id, async (trx) => {
        const guard = await getGuard(trx, org.id, params.id, { forUpdate: true });
        if (!guard || guard.status === 'TERMINATED') throw notFound();
        if (guard.status !== 'ACTIVE') {
          throw new AppError('VALIDATION_FAILED', 'Reactivate the guard before enrolling a phone.');
        }
        if (!deps.config.ALLOW_FOREIGN_GUARD_PHONES && !guard.phone.startsWith('+92')) {
          throw new AppError('VALIDATION_FAILED', 'Enrollment codes go only to +92 numbers (SEC §9).', [
            { path: 'phone', issue: 'not a Pakistani number' },
          ]);
        }
        const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        if ((await codesIssuedSince(trx, org.id, guard.id, since)) >= CODES_PER_DAY) {
          throw new AppError('RATE_LIMITED', 'At most 3 codes per guard per day.', undefined, 3600);
        }
        const purpose = (await activeDevice(trx, org.id, guard.id)) ? 'NEW_DEVICE' : 'GUARD_ENROLLMENT';
        await revokePendingCodes(trx, org.id, guard.id, actor.userId, now);
        const code = newEnrollmentCode();
        const id = uuidv7(deps.clock);
        const expiresAt = await createEnrollmentCode(trx, {
          id,
          organizationId: org.id,
          purpose,
          guardId: guard.id,
          phone: guard.phone,
          codeHash: enrollmentCodeHash(normalizeEnrollmentCode(code) ?? ''),
          linkToken: randomToken(32),
          createdByUserId: actor.userId,
          now,
        });
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'DEVICE_ENROLLMENT_CODE_ISSUED',
          resourceType: 'guard',
          resourceId: guard.id,
          metadata: { purpose },
        });
        return { purpose, code, expiresAt };
      });
      void reply.code(201);
      return {
        purpose: issued.purpose,
        code: issued.code,
        qrPayload: `${ENROLLMENT_QR_PREFIX}${issued.code.replace('-', '')}`,
        expiresAt: issued.expiresAt.toISOString(),
      };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/enrollments/redeem',
    summary: "Enrolls a guard's phone with a dashboard-issued code; returns our own session.",
    policy: {
      access: { kind: 'public' },
      ownership: 'none',
      rateLimit: 'enrollment',
      audit: 'DEVICE_REGISTERED',
    },
    body: enrollmentRedeemRequestSchema,
    responses: { 200: enrollmentRedeemResponseSchema, 410: errorEnvelopeSchema, 422: errorEnvelopeSchema },
    handler: async ({ request, deps, ctx, body }) => {
      deps.rateLimiter.hit('enrollment', 'ip', request.ip);
      deps.rateLimiter.hit('enrollment', 'phone', body.phone);
      const invalid = () => new AppError('ENROLLMENT_CODE_INVALID', 'The code or phone number is not right.');
      const normalized = normalizeEnrollmentCode(body.code);
      if (!normalized) throw invalid();
      const publicKey = parsePublicKey(body.publicKey);
      if (!publicKey) throw new AppError('VALIDATION_FAILED', 'The device key is not a P-256 public key.');
      const found = await enrollmentOrganizationByCode(deps.db, enrollmentCodeHash(normalized));
      if (!found) throw invalid();
      // Per-code attempts are counted in the database (invitations.attempts), which survives
      // restarts and holds across API instances.
      const now = deps.clock.now();
      const outcome = await withTenantTransaction(deps.db, found.organizationId, async (trx) => {
        const code = await lockEnrollmentCode(trx, found.organizationId, found.id);
        if (
          !code ||
          code.accepted_at ||
          code.revoked_at ||
          code.expires_at <= now ||
          code.attempts >= MAX_ATTEMPTS
        ) {
          return { error: 'expired' as const };
        }
        if (code.phone !== body.phone) {
          // A wrong number counts against the code; five strikes and it is spent.
          await countEnrollmentAttempt(trx, found.organizationId, code.id);
          return { error: 'invalid' as const };
        }
        const guard = code.guard_id
          ? await getGuard(trx, found.organizationId, code.guard_id, { forUpdate: true })
          : null;
        if (!guard || guard.status !== 'ACTIVE') return { error: 'expired' as const };

        // The guard's user record: phone only, no identity-provider account (D-02).
        let userId = guard.userId;
        if (!userId) {
          userId = await ensurePhoneUser(trx, {
            id: uuidv7(deps.clock),
            phone: guard.phone,
            name: guard.displayName,
            locale: guard.preferredLocale,
            now,
          });
          // A-04: the number's user may still be a guard in another organization.
          if (!(await linkGuardUser(trx, found.organizationId, guard.id, userId)))
            return { error: 'in-use' as const };
        }
        if (!(await findMemberByUser(trx, found.organizationId, userId))) {
          await insertMember(trx, {
            id: uuidv7(deps.clock),
            organizationId: found.organizationId,
            userId,
            role: 'GUARD',
            now,
          });
        }

        // One active device per guard (D-05): the previous phone is retired as REPLACED (D-31).
        const previous = await activeDevice(trx, found.organizationId, guard.id);
        const sameInstallation = await findDeviceByInstallation(
          trx,
          found.organizationId,
          body.installationId,
        );
        if (previous && previous.id !== sameInstallation?.id) {
          await revokeDevice(trx, {
            organizationId: found.organizationId,
            deviceId: previous.id,
            reason: 'REPLACED',
            userId: null,
            now,
            drain: true,
          });
        }
        const deviceInput = {
          installationId: body.installationId,
          publicKey,
          platform: body.platform,
          manufacturer: body.manufacturer ?? null,
          model: body.model ?? null,
          osVersion: body.osVersion,
          appVersion: body.appVersion,
        };
        let deviceId: string;
        if (sameInstallation) {
          deviceId = sameInstallation.id;
          if (sameInstallation.status === 'ACTIVE') {
            await revokeDevice(trx, {
              organizationId: found.organizationId,
              deviceId,
              reason: 'REPLACED',
              userId: null,
              now,
            });
          }
          await reactivateDevice(trx, {
            ...deviceInput,
            id: deviceId,
            organizationId: found.organizationId,
            guardId: guard.id,
            now,
          });
        } else {
          deviceId = uuidv7(deps.clock);
          await insertDevice(trx, {
            ...deviceInput,
            id: deviceId,
            organizationId: found.organizationId,
            guardId: guard.id,
            now,
          });
        }
        await markInvitationAccepted(trx, found.organizationId, code.id, userId, now);
        await recordAudit(
          trx,
          deps.clock,
          found.organizationId,
          { ...auditActor(ctx), userId },
          {
            action: 'DEVICE_REGISTERED',
            resourceType: 'device',
            resourceId: deviceId,
            metadata: { guardId: guard.id, purpose: code.purpose, replaced: previous?.id ?? null },
          },
        );
        const session = await issueSession(trx, deps, {
          organizationId: found.organizationId,
          guardId: guard.id,
          deviceId,
          familyId: uuidv7(deps.clock),
        });
        const organization = await getOrganization(trx, found.organizationId);
        return {
          deviceId,
          guard: { id: guard.id, displayName: guard.displayName, preferredLocale: guard.preferredLocale },
          organization: { id: found.organizationId, name: organization?.name ?? '' },
          session,
        };
      });
      if ('error' in outcome) {
        if (outcome.error === 'invalid') throw invalid();
        if (outcome.error === 'in-use') {
          throw new AppError(
            'FORBIDDEN',
            'This phone number is enrolled with another organization. It must be released there first.',
          );
        }
        throw new AppError(
          'INVITATION_EXPIRED',
          'This code has expired or was already used. Ask your supervisor for a new one.',
        );
      }
      return outcome;
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/sessions/refresh',
    summary: 'Rotates the mobile refresh token and returns a new session.',
    policy: { access: { kind: 'public' }, ownership: 'none', rateLimit: 'default', audit: null },
    body: sessionRefreshRequestSchema,
    responses: { 200: sessionRefreshResponseSchema, 401: errorEnvelopeSchema },
    handler: async ({ deps, body }) => ({ session: await refreshSession(deps, body.refreshToken) }),
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/guards/:id/devices',
    summary: "A guard's phones, current and revoked.",
    policy: {
      access: { kind: 'permission', permission: 'devices.read' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: null,
    },
    params: z.object({ id: z.uuid() }),
    responses: { 200: deviceListResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        if (!(await getGuard(trx, org.id, params.id))) throw notFound();
        return { devices: (await listDevices(trx, org.id, params.id)).map(deviceDto) };
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/devices/:id/revoke',
    summary: 'Revokes a phone (lost, compromised or by an administrator); its sessions end at once.',
    policy: {
      access: { kind: 'permission', permission: 'devices.revoke' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'DEVICE_REVOKED',
    },
    params: z.object({ id: z.uuid() }),
    body: deviceRevokeRequestSchema,
    responses: { 200: deviceSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const now = deps.clock.now();
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const device = await getDevice(trx, org.id, params.id);
        if (!device) throw notFound();
        if (device.status === 'ACTIVE') {
          await revokeDevice(trx, {
            organizationId: org.id,
            deviceId: device.id,
            reason: body.reason,
            userId: actor.userId,
            now,
          });
          await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
            action: 'DEVICE_REVOKED',
            resourceType: 'device',
            resourceId: device.id,
            metadata: { reason: body.reason, guardId: device.guardId },
          });
        }
        const updated = await getDevice(trx, org.id, device.id);
        if (!updated) throw notFound();
        return deviceDto(updated);
      });
    },
  }),
];
