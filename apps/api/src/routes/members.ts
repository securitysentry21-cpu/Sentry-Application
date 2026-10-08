// Members (PROD §3, SEC §6 rule 3, INV-03). The rules live in packages/domain (decideMemberChange):
//   1. nobody changes their own role or status (SELF_ROLE_CHANGE, ADV-A02);
//   2. owners and administrators are managed only by an active owner (ADV-A05);
//   3. optimistic concurrency on `version` (VERSION_CONFLICT);
//   4. the last ACTIVE owner can't be demoted, disabled or removed (LAST_OWNER, ADV-A06).
// The owner rows are locked first and the caller's own authority is re-read under that lock, so a
// request carrying a context from before a concurrent demotion can't act on it.
// Changes take effect on the member's next request (SEC §6 rule 7).
import {
  errorEnvelopeSchema,
  memberListResponseSchema,
  memberPatchRequestSchema,
  memberSchema,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { decideMemberChange } from '@sentryops/domain';
import { z } from 'zod';

import { auditActor, orgOf, userOf } from '../context.ts';
import { AppError, notFound } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  getMember,
  listMembers,
  lockActiveOwners,
  updateMember,
  type MemberRow,
} from '../repositories/memberships.ts';
import { defineRoute } from './registry.ts';

export function memberDto(m: MemberRow) {
  return {
    id: m.id,
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
    status: m.status,
    version: m.version,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

const MESSAGES = {
  SELF_ROLE_CHANGE: 'You cannot change your own role or status.',
  FORBIDDEN: 'Only an owner can manage owners and administrators.',
  VERSION_CONFLICT: 'This member was changed by someone else.',
  LAST_OWNER: 'The organization must keep at least one active owner.',
} as const;

export const memberRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/members',
    summary: 'Staff members of the current organization.',
    policy: {
      access: { kind: 'permission', permission: 'members.manage' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: null,
    },
    responses: { 200: memberListResponseSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const members = await withTenantTransaction(deps.db, org.id, (trx) => listMembers(trx, org.id));
      return { members: members.map(memberDto) };
    },
  }),

  defineRoute({
    method: 'PATCH',
    url: '/api/v1/members/:id',
    summary: "Changes a member's role or status.",
    policy: {
      access: { kind: 'permission', permission: 'members.manage' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'ROLE_CHANGED',
    },
    params: z.object({ id: z.uuid() }),
    body: memberPatchRequestSchema,
    responses: {
      200: memberSchema,
      403: errorEnvelopeSchema,
      404: errorEnvelopeSchema,
      409: errorEnvelopeSchema,
    },
    handler: async ({ deps, ctx, params, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const activeOwners = await lockActiveOwners(trx, org.id);
        const target = await getMember(trx, org.id, params.id, { forUpdate: true });
        if (!target || target.status === 'REMOVED' || target.role === 'GUARD') throw notFound();
        const decision = decideMemberChange({
          actorUserId: actor.userId,
          actorIsActiveOwner: activeOwners.includes(org.memberId),
          target: {
            memberId: target.id,
            userId: target.userId,
            role: target.role,
            status: target.status,
            version: target.version,
          },
          change: {
            ...(body.role ? { role: body.role } : {}),
            ...(body.status ? { status: body.status } : {}),
            version: body.version,
          },
          activeOwnerMemberIds: activeOwners,
        });
        if (!decision.ok) {
          throw new AppError(
            decision.code,
            MESSAGES[decision.code],
            undefined,
            undefined,
            decision.code === 'VERSION_CONFLICT' ? memberDto(target) : undefined,
          );
        }
        const { role, status } = decision;
        const now = deps.clock.now();
        await updateMember(trx, {
          organizationId: org.id,
          memberId: target.id,
          version: target.version,
          role,
          status,
          now,
        });
        const actorInfo = auditActor(ctx);
        if (role !== target.role) {
          await recordAudit(trx, deps.clock, org.id, actorInfo, {
            action: 'ROLE_CHANGED',
            resourceType: 'member',
            resourceId: target.id,
            metadata: { from: target.role, to: role },
          });
        }
        if (status !== target.status) {
          await recordAudit(trx, deps.clock, org.id, actorInfo, {
            action:
              status === 'REMOVED'
                ? 'MEMBER_REMOVED'
                : status === 'ACTIVE'
                  ? 'MEMBER_ENABLED'
                  : 'MEMBER_DISABLED',
            resourceType: 'member',
            resourceId: target.id,
            metadata: { from: target.status, to: status },
          });
        }
        const updated = await getMember(trx, org.id, target.id);
        if (!updated) throw notFound();
        return memberDto(updated);
      });
    },
  }),
];
