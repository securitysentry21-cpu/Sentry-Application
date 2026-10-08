// Route registry (ARCH §4.6, SEC §6, INV-12). Every route is declared with defineRoute() and a
// policy; an onRoute hook refuses to mount anything without one, so a handler can never be added
// outside the registry. The hook also records every mounted route for the meta-test (ADV-A09).
import type { RoutePolicy } from '@sentryops/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AppDeps } from '../deps.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    policy?: RoutePolicy;
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type RouteDefinition = {
  readonly method: HttpMethod;
  readonly url: `/api/v1/${string}`;
  readonly summary: string;
  readonly policy: RoutePolicy;
  /** Response schemas by status code; also the source of the generated OpenAPI document. */
  readonly responses: Readonly<Record<number, z.ZodType>>;
  readonly handler: (request: FastifyRequest, reply: FastifyReply, deps: AppDeps) => Promise<unknown>;
};

export type MountedRoute = {
  readonly method: string;
  readonly url: string;
  readonly policy: RoutePolicy | undefined;
};

export function defineRoute(definition: RouteDefinition): RouteDefinition {
  if (!(definition as Partial<RouteDefinition>).policy) {
    throw new TypeError(`route ${definition.method} ${definition.url} has no policy (ARCH §4.6)`);
  }
  return definition;
}

/** Must run before any route is added. */
export function enforceRoutePolicies(app: FastifyInstance, catalog: MountedRoute[]): void {
  app.addHook('onRoute', (options) => {
    const methods = Array.isArray(options.method) ? options.method : [options.method];
    const policy = options.config?.policy;
    for (const method of methods) catalog.push({ method: String(method), url: options.url, policy });
    if (!policy) {
      throw new Error(
        `refusing to mount ${methods.join(',')} ${options.url}: it has no route policy (ARCH §4.6)`,
      );
    }
  });
}

export function mountRoutes(app: FastifyInstance, routes: readonly RouteDefinition[], deps: AppDeps): void {
  for (const route of routes) {
    app.route({
      method: route.method,
      url: route.url,
      config: { policy: route.policy },
      handler: (request, reply) => route.handler(request, reply, deps),
    });
  }
}
