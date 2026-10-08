// ARCH §15.3 Operations, §18.5: /health = the process is alive (no dependencies, no data);
// /ready = ready to serve (database reachable, schema at the expected migration).
import { errorEnvelopeSchema, type RoutePolicy } from '@sentryops/contracts';
import { checkReadiness } from '@sentryops/db';
import { z } from 'zod';

import { AppError } from '../errors.ts';
import { defineRoute } from './registry.ts';

const PROBE: RoutePolicy = { access: { kind: 'public' }, ownership: 'none', rateLimit: 'none', audit: null };

export const healthRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/health',
    summary: 'The process is alive.',
    policy: PROBE,
    responses: { 200: z.object({ status: z.literal('ok') }) },
    handler: () => Promise.resolve({ status: 'ok' as const }),
  }),
  defineRoute({
    method: 'GET',
    url: '/api/v1/ready',
    summary: 'The API can serve requests: the database answers and the schema is current.',
    policy: PROBE,
    responses: { 200: z.object({ status: z.literal('ready') }), 503: errorEnvelopeSchema },
    handler: async (request, _reply, deps) => {
      const readiness = await checkReadiness(deps.pool);
      if (!readiness.ok) {
        // Details go to the log, not to the anonymous caller.
        request.log.warn({ problems: readiness.problems }, 'not ready');
        throw new AppError('NOT_READY', 'The service is not ready.');
      }
      return { status: 'ready' as const };
    },
  }),
];
