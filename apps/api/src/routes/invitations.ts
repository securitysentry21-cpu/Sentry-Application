// Member invitations (PROD §4, SEC §5). The link token is ≥ 256 random bits, stored only as a
// hash, single use, valid 7 days and bound to the organization, role and email. Until an email
// provider exists the dashboard shows the link once, to be sent by hand (round 6). The token sits
// in the URL fragment, so it never reaches server logs or Referer headers.
import {
  errorEnvelopeSchema,
  invitationAcceptRequestSchema,
  invitationAcceptResponseSchema,
  invitationCreateRequestSchema,
  invitationCreateResponseSchema,
  invitationListResponseSchema,
  invitationSchema,
  type StaffRole,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { z } from 'zod';

import { auditActor, can, orgOf, userOf } from '../context.ts';
import { AppError, forbidden, notFound } from '../errors.ts';
import { randomToken, uuidv7 } from '../ids.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  createMemberInvitation,
  getInvitation,
  invitationOrganizationByToken,
  listInvitations,
  lockMemberInvitation,
  markInvitationAccepted,
  revokeInvitation,
  type InvitationRow,
} from '../repositories/invitations.ts';
import { findMemberByUser, insertMember, updateMember } from '../repositories/memberships.ts';
import { getOrganization } from '../repositories/organizations.ts';
import { findUserById } from '../repositories/users.ts';
import { defineRoute } from './registry.ts';

const PRIVILEGED: ReadonlySet<StaffRole> = new Set(['OWNER', 'ADMIN']);
const MANAGE = { kind: 'permission', permission: 'members.manage' } as const;

function invitationDto(i: InvitationRow) {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    status: i.status,
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
    createdByName: i.createdByName,
  };
}

export function acceptUrl(publicOrigin: string, token: string): string {
  return `${new URL(publicOrigin).origin}/invite#token=${token}`;
}

export const invitationRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/invitations',
    summary: 'Member invitations of the current organization.',
    policy: { access: MANAGE, ownership: 'organization', rateLimit: 'default', audit: null },
    responses: { 200: invitationListResponseSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const rows = await withTenantTransaction(deps.db, org.id, (trx) =>
        listInvitations(trx, org.id, deps.clock.now()),
      );
      return { invitations: rows.map(invitationDto) };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/invitations',
    summary: 'Invites a person by email to a staff role. Returns the link once.',
    policy: { access: MANAGE, ownership: 'organization', rateLimit: 'invitation', audit: 'MEMBER_INVITED' },
    body: invitationCreateRequestSchema,
    responses: { 201: invitationCreateResponseSchema, 403: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      if (PRIVILEGED.has(body.role) && !can(ctx, 'owners.manage')) throw forbidden();
      deps.rateLimiter.hit('invitation', 'organization', org.id);
      const token = randomToken(32);
      const id = uuidv7(deps.clock);
      const now = deps.clock.now();
      const invitation = await withTenantTransaction(deps.db, org.id, async (trx) => {
        await createMemberInvitation(trx, {
          id,
          organizationId: org.id,
          email: body.email,
          role: body.role,
          token,
          createdByUserId: actor.userId,
          now,
        });
        // IDs and the role only: the email is personal data and stays on the invitation (SEC §17.2).
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'MEMBER_INVITED',
          resourceType: 'invitation',
          resourceId: id,
          metadata: { role: body.role },
        });
        return getInvitation(trx, org.id, id, now);
      });
      if (!invitation) throw notFound();
      void reply.code(201);
      return {
        invitation: invitationDto(invitation),
        acceptUrl: acceptUrl(deps.config.PUBLIC_ORIGIN, token),
      };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/invitations/:id/revoke',
    summary: 'Revokes a pending invitation.',
    policy: { access: MANAGE, ownership: 'organization', rateLimit: 'default', audit: 'INVITATION_REVOKED' },
    params: z.object({ id: z.uuid() }),
    responses: { 200: invitationSchema, 404: errorEnvelopeSchema, 410: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const now = deps.clock.now();
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const invitation = await getInvitation(trx, org.id, params.id, now);
        if (!invitation) throw notFound();
        if (PRIVILEGED.has(invitation.role) && !can(ctx, 'owners.manage')) throw forbidden();
        if (invitation.status !== 'PENDING') {
          throw new AppError('INVITATION_EXPIRED', 'This invitation is no longer pending.');
        }
        await revokeInvitation(trx, org.id, invitation.id, actor.userId, now);
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'INVITATION_REVOKED',
          resourceType: 'invitation',
          resourceId: invitation.id,
        });
        const updated = await getInvitation(trx, org.id, invitation.id, now);
        if (!updated) throw notFound();
        return invitationDto(updated);
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/invitations/accept',
    summary: 'Accepts an invitation as the signed-in user; the invitation email must match.',
    policy: {
      access: { kind: 'authenticated' },
      ownership: 'none',
      rateLimit: 'default',
      audit: 'INVITATION_ACCEPTED',
    },
    body: invitationAcceptRequestSchema,
    responses: { 200: invitationAcceptResponseSchema, 403: errorEnvelopeSchema, 410: errorEnvelopeSchema },
    handler: async ({ deps, ctx, body }) => {
      const actor = userOf(ctx);
      const expired = () =>
        new AppError('INVITATION_EXPIRED', 'This invitation has expired or was already used.');
      const found = await invitationOrganizationByToken(deps.db, body.token);
      if (!found) throw expired();
      const user = await findUserById(deps.db, actor.userId);
      if (!user) throw notFound();
      const now = deps.clock.now();
      return withTenantTransaction(deps.db, found.organizationId, async (trx) => {
        const invitation = await lockMemberInvitation(trx, found.organizationId, found.id);
        if (
          !invitation ||
          invitation.purpose !== 'MEMBER' ||
          invitation.accepted_at ||
          invitation.revoked_at ||
          invitation.expires_at <= now
        ) {
          throw expired();
        }
        if (!user.email || invitation.email?.toLowerCase() !== user.email.toLowerCase()) {
          throw new AppError('FORBIDDEN', 'This invitation was sent to a different email address.');
        }
        const role = invitation.role as StaffRole;
        const existing = await findMemberByUser(trx, found.organizationId, user.id);
        if (existing) {
          await updateMember(trx, {
            organizationId: found.organizationId,
            memberId: existing.id,
            version: existing.version,
            role,
            status: 'ACTIVE',
            now,
          });
        } else {
          await insertMember(trx, {
            id: uuidv7(deps.clock),
            organizationId: found.organizationId,
            userId: user.id,
            role,
            now,
          });
        }
        await markInvitationAccepted(trx, found.organizationId, invitation.id, user.id, now);
        await recordAudit(trx, deps.clock, found.organizationId, auditActor(ctx), {
          action: 'INVITATION_ACCEPTED',
          resourceType: 'invitation',
          resourceId: invitation.id,
          metadata: { role },
        });
        const organization = await getOrganization(trx, found.organizationId);
        return { organizationId: found.organizationId, organizationName: organization?.name ?? '', role };
      });
    },
  }),
];
