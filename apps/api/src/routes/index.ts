import { healthRoutes } from './health.ts';
import type { RouteDefinition } from './registry.ts';

/** Every route the API serves. A route that is not listed here cannot be mounted. */
export const ROUTES: readonly RouteDefinition[] = [...healthRoutes];
