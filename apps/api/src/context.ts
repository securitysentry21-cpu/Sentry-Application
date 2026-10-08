// Request context (ARCH §4.1, INV-01, INV-17):
//   authenticate → load the user's ACTIVE memberships → choose the organization (X-Organization-Id,
//   or the only membership) → permissions for the role → authorize.
// The organization never comes from a body or query string.
import { ROLE_PERMISSIONS, type Permission, type Role, type RoutePolicy } from '@sentryops/contracts';
import type { FastifyRequest } from 'fastify';

import { readSessionCookie } from './cookies.ts';
import type { AppDeps } from './deps.ts';
import { AppError, forbidden } from './errors.ts';
import type { AuditActor } from './repositories/audit.ts';
import { userMemberships } from './repositories/memberships.ts';
import { resolveSession } from './repositories/sessions.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UserActor = {
  readonly kind: 'user';
  readonly userId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly email: string | null;
};

export type OrgContext = {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly memberId: string;
  readonly permissions: ReadonlySet<Permission>;
};

export type RequestContext = {
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly actor: UserActor | null;
  readonly org: OrgContext | null;
};

const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Please sign in.');

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

export function userOf(ctx: RequestContext): UserActor {
  if (!ctx.actor) throw unauthenticated();
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
