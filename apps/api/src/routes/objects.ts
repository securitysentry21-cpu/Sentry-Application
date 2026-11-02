// The local object store's signed links (development and tests; production keeps photos in S3 and
// refuses this store, config.ts). A link is a token this API signed: key, method, expiry and, for an
// upload, the exact type and length. Anything else is a 404, like a missing object.
import { errorEnvelopeSchema, MAX_ATTACHMENT_BYTES } from '@sentryops/contracts';
import { z } from 'zod';

import { sniffImageType } from '../attachments/image.ts';
import { notFound } from '../errors.ts';
import { LocalObjectStore } from '../storage/local.ts';
import { defineRoute } from './registry.ts';

const PUBLIC = { kind: 'public' } as const;
const params = z.object({ token: z.string().min(20).max(2000) });

export const objectRoutes = [
  defineRoute({
    method: 'PUT',
    url: '/api/v1/local-objects/:token',
    summary:
      'Development only: an upload through a signed link, held to its type and exact length; never an overwrite.',
    policy: { access: PUBLIC, ownership: 'none', rateLimit: 'default', audit: null },
    params,
    responses: { 200: z.object({}), 404: errorEnvelopeSchema, 412: z.object({}) },
    handler: async ({ request, reply, deps, params: p }) => {
      const store = deps.objects;
      if (!(store instanceof LocalObjectStore)) throw notFound();
      const grant = store.verify(p.token, 'PUT');
      const body = request.body;
      if (
        !grant ||
        !Buffer.isBuffer(body) ||
        request.headers['content-type'] !== grant.contentType ||
        request.headers['if-none-match'] !== '*' ||
        body.length !== grant.contentLength
      ) {
        throw notFound();
      }
      // As S3 answers a conditional write onto an existing object: 412, and the original stays.
      if (!(await store.writeNew(grant.key, body))) return reply.code(412).send({});
      return {};
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/local-objects/:token',
    summary: 'Development only: a download through a signed link.',
    policy: { access: PUBLIC, ownership: 'none', rateLimit: 'default', audit: null },
    params,
    responses: { 200: z.unknown(), 404: errorEnvelopeSchema },
    handler: async ({ reply, deps, params: p }) => {
      const store = deps.objects;
      if (!(store instanceof LocalObjectStore)) throw notFound();
      const grant = store.verify(p.token, 'GET');
      if (!grant) throw notFound();
      const bytes = await store.read(grant.key, MAX_ATTACHMENT_BYTES);
      if (!bytes) throw notFound();
      void reply.header('content-type', sniffImageType(bytes.subarray(0, 32)) ?? 'application/octet-stream');
      void reply.header('cache-control', 'private, max-age=300');
      if (grant.downloadName) {
        void reply.header(
          'content-disposition',
          `attachment; filename="${grant.downloadName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        );
      }
      return reply.send(bytes);
    },
  }),
];
