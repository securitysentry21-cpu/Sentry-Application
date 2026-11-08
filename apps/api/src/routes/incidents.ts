// Incidents and photos (PROD §10, ARCH §12, §15.3). Dashboard users list, read and manage them;
// guards file theirs through the sync queue, see their own, add notes, and upload photos to their
// own reports. Status changes are audited; another organization's incident is a 404.
import {
  attachmentCompleteRequestSchema,
  attachmentCompleteResponseSchema,
  attachmentSlotRequestSchema,
  attachmentSlotResponseSchema,
  attachmentUrlResponseSchema,
  errorEnvelopeSchema,
  guardIncidentsResponseSchema,
  incidentCreateRequestSchema,
  incidentListQuerySchema,
  incidentListResponseSchema,
  incidentNoteRequestSchema,
  incidentPatchRequestSchema,
  incidentReference,
  incidentReopenRequestSchema,
  incidentResolveRequestSchema,
  incidentResponseSchema,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { z } from 'zod';

import { auditActor, guardOf, orgOf, userOf } from '../context.ts';
import { notFound } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  attachmentsFor,
  getIncident,
  guardIncidents,
  incidentEvents,
  listIncidents,
} from '../repositories/incidents.ts';
import { completeUpload, originalLink, requestUploadSlot, viewLink } from '../services/attachments.ts';
import {
  addNoteByUser,
  changeIncident,
  changeIncidentStatus,
  createIncidentByUser,
  incidentDetail,
  incidentSummary,
} from '../services/incidents.ts';
import { defineRoute } from './registry.ts';

const READ = { kind: 'permission', permission: 'incidents.read' } as const;
const CREATE = { kind: 'permission', permission: 'incidents.create' } as const;
const MANAGE = { kind: 'permission', permission: 'incidents.manage' } as const;
const ACK = { kind: 'permission', permission: 'incidents.acknowledge' } as const;
const NOTES = { kind: 'permission', permission: 'incidents.notes' } as const;
const OWN = { kind: 'permission', permission: 'incidents.read.own' } as const;
const ORIGINAL = { kind: 'permission', permission: 'incidents.attachments.original' } as const;
const params = z.object({ id: z.uuid() });

/** The guard's own reports, this many days back (GET /me/incidents). */
const GUARD_INCIDENT_DAYS = 14;

async function detailResponse(deps: Parameters<typeof withTenantTransaction>[0], orgId: string, id: string) {
  return withTenantTransaction(deps, orgId, async (trx) => {
    const incident = await getIncident(trx, orgId, id);
    if (!incident) throw notFound();
    return { incident: await incidentDetail(trx, orgId, incident) };
  });
}

export const incidentRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/incidents',
    summary: 'Incidents, newest first: open (open or acknowledged), resolved, or all; with filters.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    query: incidentListQuerySchema,
    responses: { 200: incidentListResponseSchema },
    handler: async ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      const rows = await withTenantTransaction(deps.db, org.id, (trx) =>
        listIncidents(trx, org.id, {
          status: query.status,
          severity: query.severity,
          type: query.type,
          siteId: query.siteId,
          guardId: query.guardId,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
          limit: query.limit,
        }),
      );
      return { incidents: rows.map(incidentSummary) };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/incidents',
    summary: 'Records an incident from the dashboard (no location; photos come from the guard app).',
    policy: { access: CREATE, ownership: 'organization', rateLimit: 'incident', audit: 'INCIDENT_CREATED' },
    body: incidentCreateRequestSchema,
    responses: { 201: incidentResponseSchema, 400: errorEnvelopeSchema, 404: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const user = userOf(ctx);
      deps.rateLimiter.hit('incident', 'user', user.userId);
      const result = await withTenantTransaction(deps.db, org.id, async (trx) => {
        const incident = await createIncidentByUser(trx, deps, org.id, user, body);
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'INCIDENT_CREATED',
          resourceType: 'incident',
          resourceId: incident.id,
          metadata: {
            referenceNumber: incidentReference(incident.referenceNumber),
            type: body.type,
            severity: body.severity,
          },
        });
        return { incident: await incidentDetail(trx, org.id, incident) };
      });
      void reply.code(201);
      return result;
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/incidents/:id',
    summary: 'One incident: the submission, its location, history and photos.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    params,
    responses: { 200: incidentResponseSchema, 404: errorEnvelopeSchema },
    handler: ({ deps, ctx, params: p }) => detailResponse(deps.db, orgOf(ctx).id, p.id),
  }),

  defineRoute({
    method: 'PATCH',
    url: '/api/v1/incidents/:id',
    summary: 'Changes severity or type; the original submission is kept (PROD §10.2).',
    policy: { access: MANAGE, ownership: 'organization', rateLimit: 'default', audit: 'INCIDENT_UPDATED' },
    params,
    body: incidentPatchRequestSchema,
    responses: { 200: incidentResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      const user = userOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const { incident, changed } = await changeIncident(trx, deps, org.id, user, p.id, body);
        if (changed.length > 0) {
          await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
            action: 'INCIDENT_UPDATED',
            resourceType: 'incident',
            resourceId: incident.id,
            metadata: {
              changed,
              ...(body.severity ? { severity: body.severity } : {}),
              ...(body.type ? { type: body.type } : {}),
            },
          });
        }
        return { incident: await incidentDetail(trx, org.id, incident) };
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/incidents/:id/notes',
    summary: 'Adds a note. Descriptions are never overwritten; corrections are notes (PROD §10.2).',
    policy: { access: NOTES, ownership: 'organization', rateLimit: 'default', audit: null },
    params,
    body: incidentNoteRequestSchema,
    responses: { 201: incidentResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      await withTenantTransaction(deps.db, org.id, (trx) =>
        addNoteByUser(trx, deps, org.id, userOf(ctx), p.id, body.body),
      );
      void reply.code(201);
      return detailResponse(deps.db, org.id, p.id);
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/incidents/:id/acknowledge',
    summary: 'Acknowledges an incident. Idempotent: a second acknowledgement keeps the first person.',
    policy: {
      access: ACK,
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'INCIDENT_STATUS_CHANGED',
    },
    params,
    responses: { 200: incidentResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const { incident, changed } = await changeIncidentStatus(trx, deps, org.id, userOf(ctx), p.id, {
          kind: 'ACKNOWLEDGE',
        });
        if (changed) {
          await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
            action: 'INCIDENT_STATUS_CHANGED',
            resourceType: 'incident',
            resourceId: incident.id,
            metadata: { to: 'ACKNOWLEDGED' },
          });
        }
        return { incident: await incidentDetail(trx, org.id, incident) };
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/incidents/:id/resolve',
    summary: 'Resolves an incident with a resolution note (required).',
    policy: {
      access: MANAGE,
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'INCIDENT_STATUS_CHANGED',
    },
    params,
    body: incidentResolveRequestSchema,
    responses: { 200: incidentResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const { incident } = await changeIncidentStatus(trx, deps, org.id, userOf(ctx), p.id, {
          kind: 'RESOLVE',
          note: body.note,
        });
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'INCIDENT_STATUS_CHANGED',
          resourceType: 'incident',
          resourceId: incident.id,
          metadata: { to: 'RESOLVED' },
        });
        return { incident: await incidentDetail(trx, org.id, incident) };
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/incidents/:id/reopen',
    summary: 'Reopens a resolved incident, with a reason (Supervisor and above).',
    policy: {
      access: MANAGE,
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'INCIDENT_STATUS_CHANGED',
    },
    params,
    body: incidentReopenRequestSchema,
    responses: { 200: incidentResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const { incident } = await changeIncidentStatus(trx, deps, org.id, userOf(ctx), p.id, {
          kind: 'REOPEN',
          reason: body.reason,
        });
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'INCIDENT_STATUS_CHANGED',
          resourceType: 'incident',
          resourceId: incident.id,
          reason: body.reason,
          metadata: { to: 'OPEN' },
        });
        return { incident: await incidentDetail(trx, org.id, incident) };
      });
    },
  }),

  // ── Photos (ARCH §12) ──────────────────────────────────────────────────────────────────────

  defineRoute({
    method: 'POST',
    url: '/api/v1/incidents/:id/attachments',
    summary:
      "An upload slot for a photo on the guard's own report: a signed PUT for its exact type and size.",
    policy: {
      access: OWN,
      ownership: 'guard-self',
      rateLimit: 'attachment',
      audit: null,
      appVersion: 'upload',
    },
    params,
    body: attachmentSlotRequestSchema,
    responses: { 200: attachmentSlotResponseSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      deps.rateLimiter.hit('attachment', 'guard', guard.guardId);
      return withTenantTransaction(deps.db, org.id, (trx) =>
        requestUploadSlot(
          trx,
          deps,
          { organizationId: org.id, guardId: guard.guardId, deviceId: guard.deviceId },
          p.id,
          body,
        ),
      );
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/attachments/:id/complete',
    summary: 'The upload finished: the photo is checked and its view copy made (ARCH §12 step 5).',
    policy: {
      access: OWN,
      ownership: 'guard-self',
      rateLimit: 'default',
      audit: null,
      appVersion: 'upload',
    },
    params,
    body: attachmentCompleteRequestSchema,
    responses: { 200: attachmentCompleteResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      return withTenantTransaction(deps.db, org.id, (trx) =>
        completeUpload(trx, deps, { organizationId: org.id, guardId: guard.guardId }, p.id, body.sha256),
      );
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/attachments/:id/url',
    summary: 'A signed link to the photo’s view copy (metadata removed), valid 5 minutes.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    params,
    responses: { 200: attachmentUrlResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p }) => {
      const org = orgOf(ctx);
      const link = await withTenantTransaction(deps.db, org.id, (trx) => viewLink(trx, deps, org.id, p.id));
      return { url: link.url, expiresAt: link.expiresAt };
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/attachments/:id/original-url',
    summary: 'A signed link to the original photo, kept as evidence. Owners and Administrators; audited.',
    policy: {
      access: ORIGINAL,
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'ATTACHMENT_ORIGINAL_DOWNLOADED',
    },
    params,
    responses: { 200: attachmentUrlResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const link = await originalLink(trx, deps, org.id, p.id);
        // Written before the link is returned (INV-14).
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'ATTACHMENT_ORIGINAL_DOWNLOADED',
          resourceType: 'incident_attachment',
          resourceId: link.attachment.id,
          metadata: { incidentId: link.attachment.incidentId },
        });
        return { url: link.url, expiresAt: link.expiresAt };
      });
    },
  }),

  // ── The guard's own reports ────────────────────────────────────────────────────────────────

  defineRoute({
    method: 'GET',
    url: '/api/v1/me/incidents',
    summary: "The guard's own reports of the last two weeks: status, photos and notes.",
    policy: { access: OWN, ownership: 'guard-self', rateLimit: 'default', audit: null },
    responses: { 200: guardIncidentsResponseSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      const now = deps.clock.now();
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const rows = await guardIncidents(
          trx,
          org.id,
          guard.guardId,
          new Date(now.getTime() - GUARD_INCIDENT_DAYS * 86_400_000),
        );
        const ids = rows.map((r) => r.id);
        const events = await incidentEvents(trx, org.id, ids);
        const photos = await attachmentsFor(trx, org.id, ids);
        return {
          serverTime: now.toISOString(),
          incidents: rows.map((r) => ({
            id: r.id,
            clientEventId: r.clientEventId,
            referenceNumber: incidentReference(r.referenceNumber),
            type: r.type as never,
            severity: r.severity as never,
            status: r.status,
            title: r.title,
            occurredAt: r.occurredAt.toISOString(),
            receivedAt: r.receivedAt.toISOString(),
            photos: photos.filter((a) => a.incidentId === r.id).map((a) => ({ id: a.id, status: a.status })),
            // Only the guard's own notes: supervisors' notes stay in the dashboard (agent-decided).
            notes: events
              .filter(
                (e) =>
                  e.incident_id === r.id &&
                  e.type === 'NOTE_ADDED' &&
                  e.body &&
                  e.actor_type === 'GUARD' &&
                  e.actor_guard_id === guard.guardId,
              )
              .map((e) => ({ body: e.body ?? '', createdAt: e.created_at.toISOString() })),
          })),
        };
      });
    },
  }),
];
