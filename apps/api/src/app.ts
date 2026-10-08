import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { AppDeps } from './deps.ts';
import { envelope, errorHandler } from './errors.ts';
import { loggerOptions } from './logger.ts';
import { ROUTES } from './routes/index.ts';
import {
  enforceRoutePolicies,
  mountRoutes,
  type MountedRoute,
  type RouteDefinition,
} from './routes/registry.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route that was mounted, with its policy (ADV-A09 meta-test). */
    routeCatalog: readonly MountedRoute[];
  }
}

const INCOMING_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

// SEC §10 baseline. In AWS the load balancer sends /api/* straight to the API (ARCH §2), so API
// responses can't rely on the dashboard's headers. JSON is never a page: it may not be framed,
// sniffed as HTML, or run anything.
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'referrer-policy': 'no-referrer',
} as const;

export type BuildOptions = {
  logger?: FastifyServerOptions['logger'];
  /** Test seam: routes added after the real ones. They still go through the policy check. */
  extraRoutes?: readonly RouteDefinition[];
};

export function buildApp(deps: AppDeps, options: BuildOptions = {}): FastifyInstance {
  const catalog: MountedRoute[] = [];
  const app = Fastify({
    logger: options.logger ?? loggerOptions(deps.config.LOG_LEVEL),
    // SEC §15: every log line carries `request_id` (Fastify's default name is reqId).
    requestIdLogLabel: 'request_id',
    exposeHeadRoutes: false,
    // Behind the AWS load balancer the client address comes from X-Forwarded-For; only then.
    trustProxy: deps.config.TRUST_PROXY,
    // A full sync batch (500 items) fits comfortably; anything larger is refused before parsing.
    bodyLimit: 2 * 1024 * 1024,
    // ARCH §15.1: honour a well-formed X-Request-Id, otherwise generate one.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && INCOMING_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.decorate('routeCatalog', catalog);
  enforceRoutePolicies(app, catalog);

  // ARCH §15.1 response headers. Phones compare X-Server-Time with their own clock (ARCH §8.7).
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-server-time', deps.clock.now().toISOString());
    reply.headers(SECURITY_HEADERS);
    // Responses hold one user's data, so no cache keeps them unless a route explicitly opts in.
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(envelope('NOT_FOUND', 'Not found.', request.id)),
  );

  mountRoutes(app, [...ROUTES, ...(options.extraRoutes ?? [])], deps);
  return app;
}
