// Exports (PROD §15.2): requested here, built in the background by the worker, downloaded through a
// 15-minute link. Each kind keeps its own permission (services/exports.ts mayUseExport); the route
// itself needs the export permission, which everyone who may export anything has.
import {
  errorEnvelopeSchema,
  exportDownloadRequestSchema,
  exportDownloadResponseSchema,
  exportListResponseSchema,
  exportRequestSchema,
  exportResponseSchema,
} from '@sentryops/contracts';
import { z } from 'zod';

import { downloadLink, exportFor, exportsFor, requestExport } from '../services/exports.ts';
import { defineRoute } from './registry.ts';

const EXPORT = { kind: 'permission', permission: 'exports.create' } as const;
const params = z.object({ id: z.uuid() });

export const exportRoutes = [
  defineRoute({
    method: 'POST',
    url: '/api/v1/exports',
    summary:
      'Queues an export (one at a time per person). Audited; an export with location counts as location-history access.',
    policy: { access: EXPORT, ownership: 'organization', rateLimit: 'default', audit: 'EXPORT_REQUESTED' },
    body: exportRequestSchema,
    responses: {
      202: exportResponseSchema,
      400: errorEnvelopeSchema,
      403: errorEnvelopeSchema,
      404: errorEnvelopeSchema,
      409: errorEnvelopeSchema,
      422: errorEnvelopeSchema,
    },
    handler: async ({ deps, ctx, body, reply }) => {
      const job = await requestExport(deps, ctx, body);
      void reply.code(202);
      return { export: job };
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/exports',
    summary: "The organization's exports this person may see, newest first.",
    policy: { access: EXPORT, ownership: 'organization', rateLimit: 'default', audit: null },
    responses: { 200: exportListResponseSchema },
    handler: async ({ deps, ctx }) => ({ exports: await exportsFor(deps, ctx) }),
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/exports/:id',
    summary: 'One export and its status.',
    policy: { access: EXPORT, ownership: 'organization', rateLimit: 'default', audit: null },
    params,
    responses: { 200: exportResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p }) => ({ export: await exportFor(deps, ctx, p.id) }),
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/exports/:id/download',
    summary: 'A download link valid 15 minutes. Audited; an export with location asks for the reason again.',
    policy: { access: EXPORT, ownership: 'organization', rateLimit: 'default', audit: 'EXPORT_DOWNLOADED' },
    params,
    body: exportDownloadRequestSchema,
    responses: {
      200: exportDownloadResponseSchema,
      400: errorEnvelopeSchema,
      404: errorEnvelopeSchema,
      409: errorEnvelopeSchema,
      410: errorEnvelopeSchema,
    },
    handler: async ({ deps, ctx, params: p, body }) => downloadLink(deps, ctx, p.id, body.reason),
  }),
];
