// OpenAPI 3.1 generated from the route registry and its zod schemas (ARCH §15.1). The committed
// docs/generated/openapi.json is checked against this in CI, so the contract cannot drift.
import { errorEnvelopeSchema } from '@sentryops/contracts';
import { z } from 'zod';

import type { RouteDefinition } from './routes/registry.ts';

export function buildOpenApi(routes: readonly RouteDefinition[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of [...routes].sort((a, b) =>
    `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`),
  )) {
    const responses: Record<string, unknown> = {};
    for (const [status, schema] of Object.entries(route.responses)) {
      responses[status] = {
        description: status.startsWith('2') ? 'Success' : 'Error',
        content: { 'application/json': { schema: z.toJSONSchema(schema) } },
      };
    }
    paths[route.url] = {
      ...paths[route.url],
      [route.method.toLowerCase()]: {
        summary: route.summary,
        'x-policy': route.policy,
        responses,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'SENTRY API', version: 'v1' },
    servers: [{ url: '/' }],
    paths,
    components: { schemas: { ErrorEnvelope: z.toJSONSchema(errorEnvelopeSchema) } },
  };
}
