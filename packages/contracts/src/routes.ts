// Route policies (ARCH §4.6, SEC §6). Every route declares one; the API refuses to mount a route
// without it, and a meta-test (ADV-A09) checks every mounted route.
import type { AuditAction } from './audit.ts';
import type { Permission } from './permissions.ts';

// SEC §9 rate-limit classes. `sos` is never rejected (INV-15); `none` is for health probes only.
export const RATE_LIMIT_CLASSES = [
  'none',
  'default',
  'signin',
  'sync',
  'sos',
  'scan',
  'incident',
  'attachment',
  'enrollment',
  'invitation',
  'report',
  'export',
] as const;
export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

export type RouteAccess =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'permission'; readonly permission: Permission };

/** How the resource is tied to the caller, checked after the permission. */
export type RouteOwnership = 'none' | 'organization' | 'guard-self';

export type RoutePolicy = {
  readonly access: RouteAccess;
  readonly ownership: RouteOwnership;
  readonly rateLimit: RateLimitClass;
  /** Audit action written in the same transaction (INV-14), or null if the route changes nothing auditable. */
  readonly audit: AuditAction | null;
};
