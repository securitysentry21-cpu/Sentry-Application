import { alertRoutes } from './alerts.ts';
import { auditLogRoutes } from './audit-logs.ts';
import { authRoutes } from './auth.ts';
import { enrollmentRoutes } from './enrollment.ts';
import { guardRoutes } from './guards.ts';
import { healthRoutes } from './health.ts';
import { incidentRoutes } from './incidents.ts';
import { invitationRoutes } from './invitations.ts';
import { liveRoutes } from './live.ts';
import { meRoutes } from './me.ts';
import { memberRoutes } from './members.ts';
import { mobileRoutes } from './mobile.ts';
import { notificationRoutes } from './notifications.ts';
import { objectRoutes } from './objects.ts';
import { patrolRoutes } from './patrols.ts';
import type { RouteDefinition } from './registry.ts';
import { reportRoutes } from './reports.ts';
import { settingsRoutes } from './settings.ts';
import { shiftRoutes } from './shifts.ts';
import { siteRoutes } from './sites.ts';
import { sosRoutes } from './sos.ts';
import { syncRoutes } from './sync.ts';

/** Every route the API serves. A route that is not listed here cannot be mounted. */
export const ROUTES: readonly RouteDefinition[] = [
  ...healthRoutes,
  ...authRoutes,
  ...meRoutes,
  ...memberRoutes,
  ...invitationRoutes,
  ...settingsRoutes,
  ...auditLogRoutes,
  ...guardRoutes,
  ...enrollmentRoutes,
  ...mobileRoutes,
  ...siteRoutes,
  ...patrolRoutes,
  ...shiftRoutes,
  ...syncRoutes,
  ...liveRoutes,
  ...alertRoutes,
  ...reportRoutes,
  ...incidentRoutes,
  ...sosRoutes,
  ...notificationRoutes,
  ...objectRoutes,
];
