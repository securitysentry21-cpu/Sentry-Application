// POST /sync/batch (ARCH §9.1): the guard app's ordered upload.
import { errorEnvelopeSchema, syncBatchRequestSchema, syncBatchResponseSchema } from '@sentryops/contracts';

import { guardOf, orgOf } from '../context.ts';
import { processBatch } from '../services/sync.ts';
import { defineRoute } from './registry.ts';

export const syncRoutes = [
  defineRoute({
    method: 'POST',
    url: '/api/v1/sync/batch',
    summary: "The guard app's ordered upload: start, end, locations, heartbeats and device status.",
    policy: {
      access: { kind: 'permission', permission: 'shifts.self' },
      ownership: 'guard-self',
      rateLimit: 'sync',
      audit: null,
      replacedDeviceDrain: true,
    },
    body: syncBatchRequestSchema,
    responses: { 200: syncBatchResponseSchema, 429: errorEnvelopeSchema },
    handler: async ({ request, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      deps.rateLimiter.hit('sync', 'device', guard.deviceId);
      const appVersion =
        typeof request.headers['x-app-version'] === 'string'
          ? request.headers['x-app-version'].slice(0, 40)
          : null;
      return processBatch(
        deps,
        {
          organizationId: org.id,
          guardId: guard.guardId,
          deviceId: guard.deviceId,
          userId: guard.userId,
          appVersion,
          replacedAt: guard.replacedAt,
        },
        body,
      );
    },
  }),
];
