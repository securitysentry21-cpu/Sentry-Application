// Request context (ARCH §4.1, INV-01, INV-17):
//   authenticate → load the user's ACTIVE memberships → choose the organization (X-Organization-Id,
//   or the only membership) → permissions for the role → authorize.
// The organization never comes from a body or query string.
import { ROLE_PERMISSIONS, type Permission, type Role, type RoutePolicy } from '@sentryops/contracts';
import type { FastifyRequest } from 'fastify';

import { withTenantTransaction } from '@sentryops/db';

import { enforceAppVersion } from './app-version.ts';
import { parseDeviceSignature, verifyDeviceSignature } from './auth/device-signature.ts';
import { readSessionCookie } from './cookies.ts';
import type { AppDeps } from './deps.ts';
import { AppError, forbidden } from './errors.ts';
import type { AuditActor } from './repositories/audit.ts';
import {
  deviceForSignature,
  guardOnDevice,
  loadSession,
  sessionIdByAccess,
  touchDevice,
} from './repositories/guards.ts';
import { userMemberships } from './repositories/memberships.ts';
import { resolveSession } from './repositories/sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The SOS routes' JSON body exactly as received (app.ts keeps it), for the device-key signature (ADV-S11). */
    rawBody?: string;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UserActor = {
  readonly kind: 'user';
  readonly userId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly email: string | null;
};

/** A guard's phone, authenticated by our device-bound session (D-30). */
export type GuardActor = {
  readonly kind: 'guard';
  readonly userId: string | null;
  readonly guardId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly preferredLocale: 'en' | 'ur';
  /** Set while a phone REPLACED by a new one drains its queue: only data captured before this. */
  readonly replacedAt: Date | null;
  /** How this request proved the phone: its session, or its device key (SOS only, INV-15). */
  readonly auth: 'SESSION' | 'DEVICE_SIGNATURE';
};

/** ARCH §5.4: a replaced phone's pre-replacement uploads are accepted for 72 hours. */
export const REPLACED_DRAIN_MS = 72 * 3_600_000;

export type OrgContext = {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  /** The dashboard member seat; empty for guards, who act through their guard record. */
  readonly memberId: string;
  readonly permissions: ReadonlySet<Permission>;
};

export type RequestContext = {
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly actor: UserActor | GuardActor | null;
  readonly org: OrgContext | null;
};

const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Please sign in.');
const ACCESS_TOKEN = /^sa_[A-Za-z0-9_-]{43}$/;

/**
 * The guard app's path: a Bearer access token → its session → the guard, the device and the
 * organization. Every request is checked against X-Device-Id and the device's current status, so a
 * revoked phone is refused on its next request (SEC §5, ADV-A08).
 */
async function resolveGuard(
  request: FastifyRequest,
  policy: RoutePolicy,
  deps: AppDeps,
  base: Pick<RequestContext, 'requestId' | 'ip' | 'userAgent'>,
  token: string,
): Promise<RequestContext> {
  // An SOS whose session can't be used falls back to the device-key signature when it carries one.
  const fallback = () =>
    policy.sos && request.headers['x-device-signature'] !== undefined
      ? resolveSignedDevice(request, policy, deps, base)
      : Promise.reject(unauthenticated());
  if (!ACCESS_TOKEN.test(token)) return fallback();
  const found = await sessionIdByAccess(deps.db, token);
  if (!found) return fallback();
  const now = deps.clock.now();
  const session = await withTenantTransaction(deps.db, found.organization_id, async (trx) => {
    const row = await loadSession(trx, found.organization_id, found.id);
    if (row && row.device_status === 'ACTIVE')
      await touchDevice(trx, found.organization_id, row.device_id, now);
    return row;
  });
  if (!session) throw unauthenticated();
  if (request.headers['x-device-id'] !== session.device_id) {
    throw new AppError('DEVICE_NOT_REGISTERED', 'This phone is not registered for this session.');
  }
  const replacedInGrace =
    session.device_status === 'REVOKED' &&
    session.device_revoked_reason === 'REPLACED' &&
    session.device_revoked_at !== null &&
    now.getTime() - session.device_revoked_at.getTime() <= REPLACED_DRAIN_MS;
  // ARCH §5.3, §5.4: a replaced phone may drain its queue, and may still send an SOS, for 72 hours.
  const draining = replacedInGrace && (policy.replacedDeviceDrain === true || policy.sos === true);
  if (session.device_status !== 'ACTIVE' && !draining) {
    throw new AppError('DEVICE_REVOKED', 'This phone was signed out by your organization.');
  }
  if (session.revoked_at || session.access_expires_at <= now) return fallback();
  if (session.guard_status !== 'ACTIVE') throw unauthenticated();
  // INV-15: an SOS is accepted from a suspended organization.
  if (session.organization_status === 'SUSPENDED' && !policy.sos) {
    throw new AppError('ORG_SUSPENDED', 'This organization is suspended.');
  }
  if (session.organization_status !== 'ACTIVE' && session.organization_status !== 'SUSPENDED') {
    throw forbidden();
  }
  const permissions = ROLE_PERMISSIONS.GUARD;
  if (policy.access.kind === 'permission' && !permissions.has(policy.access.permission)) throw forbidden();
  enforceAppVersion(request.headers['x-app-version'], policy, deps.config);
  return {
    ...base,
    actor: {
      kind: 'guard',
      userId: session.user_id,
      guardId: session.guard_id,
      deviceId: session.device_id,
      sessionId: session.id,
      name: session.display_name,
      preferredLocale: session.preferred_locale === 'ur' ? 'ur' : 'en',
      replacedAt: draining ? session.device_revoked_at : null,
      auth: 'SESSION',
    },
    org: {
      id: found.organization_id,
      name: session.organization_name,
      role: 'GUARD',
      memberId: '',
      permissions,
    },
  };
}

/**
 * An SOS route with no usable session (INV-15, ADV-S11): the request is signed with the phone's
 * device key. Accepted from an ACTIVE phone, or one REPLACED within its 72 hours, whatever the
 * organization's status; anything else is refused.
 */
async function resolveSignedDevice(
  request: FastifyRequest,
  policy: RoutePolicy,
  deps: AppDeps,
  base: Pick<RequestContext, 'requestId' | 'ip' | 'userAgent'>,
): Promise<RequestContext> {
  if (!policy.sos) throw unauthenticated();
  const header = request.headers['x-device-id'];
  const signature = parseDeviceSignature(request.headers['x-device-signature']);
  if (typeof header !== 'string' || !UUID.test(header) || !signature) throw unauthenticated();
  const deviceId = header.toLowerCase();
  const device = await deviceForSignature(deps.db, deviceId);
  if (!device) throw unauthenticated();
  const now = deps.clock.now();
  const valid = verifyDeviceSignature({
    publicKeySpki: device.public_key,
    method: request.method,
    path: request.url.split('?')[0] ?? '',
    body: Buffer.from(request.rawBody ?? '', 'utf8'),
    signature,
    nowMs: now.getTime(),
  });
  if (!valid) throw unauthenticated();
  const replacedInGrace =
    device.status === 'REVOKED' &&
    device.revoked_reason === 'REPLACED' &&
    device.revoked_at !== null &&
    now.getTime() - device.revoked_at.getTime() <= REPLACED_DRAIN_MS;
  if (device.status !== 'ACTIVE' && !replacedInGrace) {
    throw new AppError('DEVICE_REVOKED', 'This phone was signed out by your organization.');
  }
  const guard = await withTenantTransaction(deps.db, device.organization_id, (trx) =>
    guardOnDevice(trx, device.organization_id, deviceId),
  );
  if (!guard || guard.guard_status !== 'ACTIVE') throw unauthenticated();
  if (guard.organization_status !== 'ACTIVE' && guard.organization_status !== 'SUSPENDED') throw forbidden();
  const permissions = ROLE_PERMISSIONS.GUARD;
  if (policy.access.kind === 'permission' && !permissions.has(policy.access.permission)) throw forbidden();
  enforceAppVersion(request.headers['x-app-version'], policy, deps.config);
  return {
    ...base,
    actor: {
      kind: 'guard',
      userId: guard.user_id,
      guardId: guard.guard_id,
      deviceId,
      sessionId: '',
      name: guard.display_name,
      preferredLocale: guard.preferred_locale === 'ur' ? 'ur' : 'en',
      replacedAt: replacedInGrace ? device.revoked_at : null,
      auth: 'DEVICE_SIGNATURE',
    },
    org: {
      id: device.organization_id,
      name: guard.organization_name,
      role: 'GUARD',
      memberId: '',
      permissions,
    },
  };
}

export async function resolveContext(
  request: FastifyRequest,
  policy: RoutePolicy,
  deps: AppDeps,
): Promise<RequestContext> {
  const base = {
    requestId: request.id,
    ip: request.ip || null,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
  if (policy.access.kind === 'public') {
    return { ...base, actor: null, org: null };
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return resolveGuard(request, policy, deps, base, authorization.slice('Bearer '.length).trim());
  }
  if (policy.sos && request.headers['x-device-signature'] !== undefined) {
    return resolveSignedDevice(request, policy, deps, base);
  }

  const token = readSessionCookie(request, deps.config);
  if (!token) throw unauthenticated();
  const session = await resolveSession(deps.db, token, deps.clock.now());
  if (!session) throw unauthenticated();
  const actor: UserActor = {
    kind: 'user',
    userId: session.userId,
    sessionId: session.sessionId,
    name: session.name,
    email: session.email,
  };
  if (policy.access.kind === 'authenticated') return { ...base, actor, org: null };

  // Guards use the guard app, never the dashboard (D-02): GUARD memberships don't count here.
  const memberships = (await userMemberships(deps.db, actor.userId)).filter((m) => m.role !== 'GUARD');
  const header = request.headers['x-organization-id'];
  let membership;
  if (typeof header === 'string' && header.length > 0) {
    if (!UUID.test(header)) throw forbidden();
    membership = memberships.find((m) => m.organizationId === header.toLowerCase());
    // No ACTIVE membership in that organization: refused, whether or not it exists (ADV-T09).
    if (!membership) throw forbidden();
  } else if (memberships.length === 1) {
    membership = memberships[0];
  } else if (memberships.length === 0) {
    throw forbidden();
  } else {
    throw new AppError('ORG_CONTEXT_REQUIRED', 'Choose an organization (X-Organization-Id).');
  }
  if (!membership) throw forbidden();
  if (membership.organizationStatus === 'SUSPENDED') {
    throw new AppError('ORG_SUSPENDED', 'This organization is suspended.');
  }
  if (membership.organizationStatus !== 'ACTIVE') throw forbidden();

  const permissions = ROLE_PERMISSIONS[membership.role];
  if (!permissions.has(policy.access.permission)) throw forbidden();

  return {
    ...base,
    actor,
    org: {
      id: membership.organizationId,
      name: membership.organizationName,
      role: membership.role,
      memberId: membership.memberId,
      permissions,
    },
  };
}

/** The dashboard user. Guard sessions never reach dashboard handlers through this. */
export function userOf(ctx: RequestContext): UserActor {
  if (!ctx.actor || ctx.actor.kind !== 'user') throw unauthenticated();
  return ctx.actor;
}

/** The guard behind a guard-app request. */
export function guardOf(ctx: RequestContext): GuardActor {
  if (!ctx.actor || ctx.actor.kind !== 'guard') throw forbidden();
  return ctx.actor;
}

export function orgOf(ctx: RequestContext): OrgContext {
  if (!ctx.org) throw forbidden();
  return ctx.org;
}

export function can(ctx: RequestContext, permission: Permission): boolean {
  return ctx.org?.permissions.has(permission) ?? false;
}

export function auditActor(ctx: RequestContext): AuditActor {
  return {
    type: 'USER',
    userId: ctx.actor?.userId ?? null,
    requestId: ctx.requestId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  };
}
