// GET /me (ARCH §15.3): the signed-in user, their ACTIVE dashboard memberships and the
// permissions each role grants. The dashboard uses it to build its navigation; the server still
// checks every permission on every request (INV-12).
import { meResponseSchema, ROLE_PERMISSIONS } from '@sentryops/contracts';

import { userOf } from '../context.ts';
import { notFound } from '../errors.ts';
import { userMemberships } from '../repositories/memberships.ts';
import { findUserById } from '../repositories/users.ts';
import { defineRoute } from './registry.ts';

export const meRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/me',
    summary: 'The signed-in user, memberships and permissions.',
    policy: { access: { kind: 'authenticated' }, ownership: 'none', rateLimit: 'default', audit: null },
    responses: { 200: meResponseSchema },
    handler: async ({ deps, ctx }) => {
      const actor = userOf(ctx);
      const user = await findUserById(deps.db, actor.userId);
      if (!user) throw notFound();
      const memberships = (await userMemberships(deps.db, actor.userId)).filter((m) => m.role !== 'GUARD');
      return {
        user: { id: user.id, name: user.name, email: user.email, locale: user.locale },
        memberships: memberships.map((m) => ({
          organizationId: m.organizationId,
          organizationName: m.organizationName,
          organizationStatus: m.organizationStatus,
          organizationTimezone: m.organizationTimezone,
          memberId: m.memberId,
          role: m.role,
          permissions: [...ROLE_PERMISSIONS[m.role]].sort(),
        })),
        serverTime: deps.clock.now().toISOString(),
      };
    },
  }),
];
