// Sites (D-38: circle or drawn polygon) and checkpoints with QR labels (ARCH §11.1). Boundary
// changes are audited as GEOFENCE_CHANGED as well as SITE_UPDATED. QR tokens are derived from the
// server secret on demand; only their hashes are stored, and printing is audited.
import {
  checkpointCreateRequestSchema,
  checkpointListResponseSchema,
  checkpointPatchRequestSchema,
  checkpointSchema,
  errorEnvelopeSchema,
  POLYGON_MAX_AREA_KM2,
  printSheetResponseSchema,
  siteCreateRequestSchema,
  siteListResponseSchema,
  sitePatchRequestSchema,
  siteSchema,
  type SiteBoundary,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { centroid, isSimplePolygon, polygonAreaKm2 } from '@sentryops/domain';
import { z } from 'zod';

import { checkpointQrContent, checkpointToken, checkpointTokenHash } from '../auth/codes.ts';
import { auditActor, orgOf, userOf } from '../context.ts';
import { AppError, notFound } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  getCheckpoint,
  getSite,
  insertCheckpoint,
  insertSite,
  listCheckpoints,
  listSites,
  updateCheckpoint,
  updateSite,
  type CheckpointRow,
  type SiteRow,
} from '../repositories/sites.ts';
import { defineRoute } from './registry.ts';

const READ = { kind: 'permission', permission: 'sites.read' } as const;
const WRITE = { kind: 'permission', permission: 'sites.write' } as const;
const CHECKPOINTS = { kind: 'permission', permission: 'checkpoints.write' } as const;

export function siteDto(s: SiteRow) {
  return {
    id: s.id,
    name: s.name,
    clientName: s.clientName,
    addressLine1: s.addressLine1,
    city: s.city,
    country: s.country,
    timezone: s.timezone,
    boundary: s.boundary,
    center: s.center,
    status: s.status,
    notes: s.notes,
    checkpointCount: s.checkpointCount,
    version: s.version,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function checkpointDto(c: CheckpointRow) {
  return {
    id: c.id,
    siteId: c.siteId,
    name: c.name,
    description: c.description,
    location: c.location,
    verificationRadiusM: c.verificationRadiusM,
    qrVersion: c.qrVersion,
    qrRotatedAt: c.qrRotatedAt?.toISOString() ?? null,
    status: c.status,
    version: c.version,
  };
}

/** D-38 rules beyond the schema: a polygon must not cross itself and covers at most 100 km². */
export function checkBoundary(boundary: SiteBoundary): { lat: number; lng: number } {
  if (boundary.kind === 'CIRCLE') return boundary.center;
  if (!isSimplePolygon(boundary.points)) {
    throw new AppError('VALIDATION_FAILED', 'The boundary crosses itself.', [
      { path: 'boundary.points', issue: 'edges must not cross' },
    ]);
  }
  const area = polygonAreaKm2(boundary.points);
  if (area > POLYGON_MAX_AREA_KM2) {
    throw new AppError('VALIDATION_FAILED', `The boundary is larger than ${POLYGON_MAX_AREA_KM2} km².`, [
      { path: 'boundary.points', issue: `area ${area.toFixed(1)} km²` },
    ]);
  }
  return centroid(boundary.points);
}

function checkTimezone(timezone: string): void {
  if (!Intl.supportedValuesOf('timeZone').includes(timezone)) {
    throw new AppError('VALIDATION_FAILED', 'Unknown time zone.', [
      { path: 'timezone', issue: 'not an IANA zone' },
    ]);
  }
}

const siteParams = z.object({ id: z.uuid() });

export const siteRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/sites',
    summary: 'Sites of the current organization.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    responses: { 200: siteListResponseSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const sites = await withTenantTransaction(deps.db, org.id, (trx) => listSites(trx, org.id));
      return { sites: sites.map(siteDto) };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/sites',
    summary: 'Creates a site with a circle or polygon boundary.',
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'SITE_CREATED' },
    body: siteCreateRequestSchema,
    responses: { 201: siteSchema, 400: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      checkTimezone(body.timezone);
      const center = checkBoundary(body.boundary);
      const id = uuidv7(deps.clock);
      const site = await withTenantTransaction(deps.db, org.id, async (trx) => {
        await insertSite(trx, {
          id,
          organizationId: org.id,
          name: body.name,
          clientName: body.clientName ?? null,
          addressLine1: body.addressLine1 ?? null,
          city: body.city ?? null,
          country: body.country,
          timezone: body.timezone,
          boundary: body.boundary,
          center,
          notes: body.notes ?? null,
          userId: actor.userId,
          now: deps.clock.now(),
        });
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'SITE_CREATED',
          resourceType: 'site',
          resourceId: id,
          metadata: { boundary: body.boundary.kind },
        });
        return getSite(trx, org.id, id);
      });
      if (!site) throw notFound();
      void reply.code(201);
      return siteDto(site);
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/sites/:id',
    summary: 'One site.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    params: siteParams,
    responses: { 200: siteSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      const site = await withTenantTransaction(deps.db, org.id, (trx) => getSite(trx, org.id, params.id));
      if (!site) throw notFound();
      return siteDto(site);
    },
  }),

  defineRoute({
    method: 'PATCH',
    url: '/api/v1/sites/:id',
    summary: 'Edits a site; a boundary change is audited as a geofence change.',
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'SITE_UPDATED' },
    params: siteParams,
    body: sitePatchRequestSchema,
    responses: { 200: siteSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      if (body.timezone) checkTimezone(body.timezone);
      const center = body.boundary ? checkBoundary(body.boundary) : undefined;
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const site = await getSite(trx, org.id, params.id, true);
        if (!site) throw notFound();
        const { version, ...changes } = body;
        const ok = await updateSite(trx, {
          organizationId: org.id,
          id: site.id,
          version,
          userId: actor.userId,
          now: deps.clock.now(),
          changes: {
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.clientName !== undefined ? { clientName: changes.clientName } : {}),
            ...(changes.addressLine1 !== undefined ? { addressLine1: changes.addressLine1 } : {}),
            ...(changes.city !== undefined ? { city: changes.city } : {}),
            ...(changes.timezone !== undefined ? { timezone: changes.timezone } : {}),
            ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
            ...(changes.status !== undefined ? { status: changes.status } : {}),
            ...(changes.boundary && center ? { boundary: changes.boundary, center } : {}),
          },
        });
        if (!ok) {
          throw new AppError(
            'VERSION_CONFLICT',
            'This site was changed by someone else.',
            undefined,
            undefined,
            siteDto(site),
          );
        }
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'SITE_UPDATED',
          resourceType: 'site',
          resourceId: site.id,
          metadata: { fields: Object.keys(changes) },
        });
        if (changes.boundary) {
          // Coordinates stay out of the audit log; the change itself and its kind are recorded.
          await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
            action: 'GEOFENCE_CHANGED',
            resourceType: 'site',
            resourceId: site.id,
            metadata: { from: site.boundary.kind, to: changes.boundary.kind },
          });
        }
        const updated = await getSite(trx, org.id, site.id);
        if (!updated) throw notFound();
        return siteDto(updated);
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/sites/:id/checkpoints',
    summary: "A site's checkpoints (no QR data).",
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    params: siteParams,
    responses: { 200: checkpointListResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        if (!(await getSite(trx, org.id, params.id))) throw notFound();
        return { checkpoints: (await listCheckpoints(trx, org.id, params.id)).map(checkpointDto) };
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/sites/:id/checkpoints',
    summary: 'Adds a checkpoint to a site; its QR token is derived, never stored.',
    policy: {
      access: CHECKPOINTS,
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'CHECKPOINT_CREATED',
    },
    params: siteParams,
    body: checkpointCreateRequestSchema,
    responses: { 201: checkpointSchema, 404: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, params, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const checkpoint = await withTenantTransaction(deps.db, org.id, async (trx) => {
        // Another organization's site is "not found" (ADV-T04); the composite key would refuse it too.
        const site = await getSite(trx, org.id, params.id);
        if (!site || site.status === 'ARCHIVED') throw notFound();
        const id = uuidv7(deps.clock);
        const token = checkpointToken(deps.config.QR_TOKEN_SECRET, id, 1);
        await insertCheckpoint(trx, {
          id,
          organizationId: org.id,
          siteId: site.id,
          name: body.name,
          description: body.description ?? null,
          location: body.location ?? null,
          verificationRadiusM: body.verificationRadiusM,
          qrTokenHash: checkpointTokenHash(token),
          userId: actor.userId,
          now: deps.clock.now(),
        });
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'CHECKPOINT_CREATED',
          resourceType: 'checkpoint',
          resourceId: id,
          metadata: { siteId: site.id },
        });
        return getCheckpoint(trx, org.id, id);
      });
      if (!checkpoint) throw notFound();
      void reply.code(201);
      return checkpointDto(checkpoint);
    },
  }),

  defineRoute({
    method: 'PATCH',
    url: '/api/v1/checkpoints/:id',
    summary: 'Edits a checkpoint.',
    policy: {
      access: CHECKPOINTS,
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'CHECKPOINT_UPDATED',
    },
    params: z.object({ id: z.uuid() }),
    body: checkpointPatchRequestSchema,
    responses: { 200: checkpointSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const checkpoint = await getCheckpoint(trx, org.id, params.id, true);
        if (!checkpoint) throw notFound();
        const { version, ...changes } = body;
        const ok = await updateCheckpoint(trx, {
          organizationId: org.id,
          id: checkpoint.id,
          version,
          userId: actor.userId,
          now: deps.clock.now(),
          changes: {
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.description !== undefined ? { description: changes.description } : {}),
            ...(changes.location !== undefined ? { location: changes.location } : {}),
            ...(changes.verificationRadiusM !== undefined
              ? { verificationRadiusM: changes.verificationRadiusM }
              : {}),
            ...(changes.status !== undefined ? { status: changes.status } : {}),
          },
        });
        if (!ok) {
          throw new AppError(
            'VERSION_CONFLICT',
            'This checkpoint was changed by someone else.',
            undefined,
            undefined,
            checkpointDto(checkpoint),
          );
        }
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'CHECKPOINT_UPDATED',
          resourceType: 'checkpoint',
          resourceId: checkpoint.id,
          metadata: { fields: Object.keys(changes) },
        });
        const updated = await getCheckpoint(trx, org.id, checkpoint.id);
        if (!updated) throw notFound();
        return checkpointDto(updated);
      });
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/checkpoints/:id/rotate-qr',
    summary: 'Issues a new QR token; the old label stops working at once.',
    policy: {
      access: CHECKPOINTS,
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'CHECKPOINT_QR_ROTATED',
    },
    params: z.object({ id: z.uuid() }),
    responses: { 200: checkpointSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const checkpoint = await getCheckpoint(trx, org.id, params.id, true);
        if (!checkpoint) throw notFound();
        const next = checkpoint.qrVersion + 1;
        await updateCheckpoint(trx, {
          organizationId: org.id,
          id: checkpoint.id,
          version: checkpoint.version,
          userId: actor.userId,
          now: deps.clock.now(),
          changes: {
            qr: {
              hash: checkpointTokenHash(checkpointToken(deps.config.QR_TOKEN_SECRET, checkpoint.id, next)),
              version: next,
            },
          },
        });
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'CHECKPOINT_QR_ROTATED',
          resourceType: 'checkpoint',
          resourceId: checkpoint.id,
          metadata: { qrVersion: next },
        });
        const updated = await getCheckpoint(trx, org.id, checkpoint.id);
        if (!updated) throw notFound();
        return checkpointDto(updated);
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/sites/:id/checkpoints/print-sheet',
    summary: "QR label contents for a site's active checkpoints. Audited before they are returned.",
    policy: {
      access: { kind: 'permission', permission: 'checkpoints.qr.print' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'CHECKPOINT_QR_PRINTED',
    },
    params: siteParams,
    responses: { 200: printSheetResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const site = await getSite(trx, org.id, params.id);
        if (!site) throw notFound();
        const checkpoints = (await listCheckpoints(trx, org.id, site.id)).filter(
          (c) => c.status === 'ACTIVE',
        );
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'CHECKPOINT_QR_PRINTED',
          resourceType: 'site',
          resourceId: site.id,
          metadata: { checkpoints: checkpoints.length },
        });
        return {
          site: { id: site.id, name: site.name },
          labels: checkpoints.map((c) => ({
            checkpointId: c.id,
            name: c.name,
            qrContent: checkpointQrContent(checkpointToken(deps.config.QR_TOKEN_SECRET, c.id, c.qrVersion)),
            qrVersion: c.qrVersion,
          })),
        };
      });
    },
  }),
];
