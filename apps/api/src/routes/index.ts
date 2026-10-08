import { auditLogRoutes } from './audit-logs.ts';
import { authRoutes } from './auth.ts';
import { healthRoutes } from './health.ts';
import { invitationRoutes } from './invitations.ts';
import { meRoutes } from './me.ts';
import { memberRoutes } from './members.ts';
import type { RouteDefinition } from './registry.ts';
import { settingsRoutes } from './settings.ts';

/** Every route the API serves. A route that is not listed here cannot be mounted. */
export const ROUTES: readonly RouteDefinition[] = [
  ...healthRoutes,
  ...authRoutes,
  ...meRoutes,
  ...memberRoutes,
  ...invitationRoutes,
  ...settingsRoutes,
  ...auditLogRoutes,
];
