import { randomUUID } from 'node:crypto';

import { MAX_ATTACHMENT_BYTES } from '@sentryops/contracts';

import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { AppDeps } from './deps.ts';
import { envelope, errorHandler } from './errors.ts';
import { SECURITY_HEADERS } from './headers.ts';
import { loggerOptions } from './logger.ts';
import { RealtimeHub, type HubTimings } from './realtime/hub.ts';
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

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const INCOMING_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export type BuildOptions = {
  logger?: FastifyServerOptions['logger'];
  /** Test seam: routes added after the real ones. They still go through the policy check. */
  extraRoutes?: readonly RouteDefinition[];
  /** Test seam: the realtime stream's timers, shortened so tests don't wait 30 s. */
  realtime?: Partial<HubTimings>;
};

export function buildApp(deps: AppDeps, options: BuildOptions = {}): FastifyInstance {
  const catalog: MountedRoute[] = [];
  const app = Fastify({
    logger: options.logger ?? loggerOptions(deps.config.LOG_LEVEL),
    // SEC §15: every log line carries `request_id` (Fastify's default name is reqId).
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    exposeHeadRoutes: false,
    // Behind the AWS load balancer the client address comes from X-Forwarded-For; only then.
    trustProxy: deps.config.TRUST_PROXY,
    // The local object store's signed tokens are path parameters (routes/objects.ts); every other
    // parameter is a UUID its route validates.
    routerOptions: { maxParamLength: 600 },
    // A full sync batch (500 items) fits comfortably; anything larger is refused before parsing.
    bodyLimit: 2 * 1024 * 1024,
    // ARCH §15.1: honour a well-formed X-Request-Id, otherwise generate one.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && INCOMING_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.decorate('routeCatalog', catalog);
  const hub = new RealtimeHub(deps, app.log, options.realtime);
  app.decorate('realtime', hub);
  // Streams end first, so the pool can close once they have recorded their departure.
  app.addHook('preClose', async () => {
    await hub.close();
  });
  enforceRoutePolicies(app, catalog);

  // ARCH §15.1 response headers. Phones compare X-Server-Time with their own clock (ARCH §8.7).
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-server-time', deps.clock.now().toISOString());
    reply.headers(SECURITY_HEADERS);
    // Responses hold one user's data, so no cache keeps them unless a route explicitly opts in.
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  // A request signed with the device key is checked over its exact bytes (INV-15, ADV-S11), so the
  // SOS routes keep their JSON as received; parsing is Fastify's own, poisoning checks included.
  const json = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (request.url.startsWith('/api/v1/sos')) request.rawBody = body as string;
    void json(request, body as string, done);
  });
  // Photo uploads to the local object store (development and tests); S3 takes them in AWS.
  app.addContentTypeParser(
    IMAGE_TYPES,
    { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(envelope('NOT_FOUND', 'Not found.', request.id)),
  );

  mountRoutes(app, [...ROUTES, ...(options.extraRoutes ?? [])], deps);
  return app;
}
