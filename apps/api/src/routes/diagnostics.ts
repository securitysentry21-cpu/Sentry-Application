// Crash reports from the guard app (ARCH §18.6; owner decision 2026-11-02: our own server only).
// Accepted reports go to the service log and nowhere else: not the product database (SEC §16.2) and
// not a third party. The log line carries IDs (organization, device) and the report's fields, which
// the contract holds to identifier-like patterns, so no message text, name, number, coordinate or
// incident text can ride along (SEC §11, §15). Operators read them in the log group (retained 30
// days); the alarm on a burst of them is in infra/terraform/cell/operations.tf.
import { appErrorsRequestSchema, errorEnvelopeSchema } from '@sentryops/contracts';
import { z } from 'zod';

import { guardOf, orgOf } from '../context.ts';
import { defineRoute } from './registry.ts';

const GUARD_SELF = { kind: 'permission', permission: 'shifts.self' } as const;

export const diagnosticsRoutes = [
  defineRoute({
    method: 'POST',
    url: '/api/v1/diagnostics/app-errors',
    summary: "The guard app's own error reports: error type and code location, never message text.",
    // Reports from an app below the minimum are the ones worth having; only a revoked one is refused.
    policy: {
      access: GUARD_SELF,
      ownership: 'guard-self',
      rateLimit: 'default',
      audit: null,
      appVersion: 'upload',
    },
    body: appErrorsRequestSchema,
    responses: { 204: z.null(), 400: errorEnvelopeSchema },
    handler: ({ request, reply, deps, ctx, body }) => {
      // The organization and device come from the device-bound session, never from the request.
      const org_id = orgOf(ctx).id;
      const device_id = guardOf(ctx).deviceId;
      for (const report of body.reports) {
        request.log.warn({ org_id, device_id, app_error: report }, 'app_error');
        deps.metrics.increment(`app_errors_${report.kind.toLowerCase()}`);
      }
      void reply.code(204);
      return Promise.resolve(null);
    },
  }),
];
