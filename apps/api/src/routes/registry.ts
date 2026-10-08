// Route registry (ARCH §4.6, SEC §6, INV-12). Every route is declared with defineRoute() and a
// policy; an onRoute hook refuses to mount anything without one, so a handler can never be added
// outside the registry. The hook also records every mounted route for the meta-test (ADV-A09).
//
// Every request then runs the same pipeline before its handler:
//   CSRF check → session → organization → permission (context.ts) → rate limit → input schemas.
import type { RoutePolicy } from '@sentryops/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { resolveContext, type RequestContext } from '../context.ts';
import { checkCsrf } from '../csrf.ts';
import type { AppDeps } from '../deps.ts';
import { notFound, validationError } from '../errors.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    policy?: RoutePolicy;
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type RouteInput<B, P, Q> = {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly deps: AppDeps;
  readonly ctx: RequestContext;
  readonly body: B;
  readonly params: P;
  readonly query: Q;
};

export type RouteDefinition<B = unknown, P = unknown, Q = unknown> = {
  readonly method: HttpMethod;
  readonly url: `/api/v1/${string}`;
  readonly summary: string;
  readonly policy: RoutePolicy;
  /** Strict request schemas. A malformed `:id` answers 404, like a missing resource. */
  readonly body?: z.ZodType<B>;
  readonly params?: z.ZodType<P>;
  readonly query?: z.ZodType<Q>;
  /** Response schemas by status code; also the source of the generated OpenAPI document. */
  readonly responses: Readonly<Record<number, z.ZodType>>;
  /** A method, so definitions with different input types share one array type. */
  handler(input: RouteInput<B, P, Q>): Promise<unknown>;
};

export type MountedRoute = {
  readonly method: string;
  readonly url: string;
  readonly policy: RoutePolicy | undefined;
};

export function defineRoute<B = undefined, P = Record<string, never>, Q = Record<string, never>>(
  definition: RouteDefinition<B, P, Q>,
): RouteDefinition {
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
      handler: async (request, reply) => {
        checkCsrf(request, deps.config);
        const ctx = await resolveContext(request, route.policy, deps);
        if (route.policy.rateLimit === 'default') {
          deps.rateLimiter.hit('default', 'user', ctx.actor?.userId ?? ctx.ip ?? 'unknown');
        }
        let params: unknown = request.params;
        if (route.params) {
          const parsed = route.params.safeParse(request.params);
          if (!parsed.success) throw notFound();
          params = parsed.data;
        }
        let query: unknown = request.query;
        if (route.query) {
          const parsed = route.query.safeParse(request.query ?? {});
          if (!parsed.success) throw validationError(parsed.error);
          query = parsed.data;
        }
        let body: unknown = undefined;
        if (route.body) {
          const parsed = route.body.safeParse(request.body ?? {});
          if (!parsed.success) throw validationError(parsed.error);
          body = parsed.data;
        }
        return route.handler({ request, reply, deps, ctx, body, params, query });
      },
    });
  }
}
