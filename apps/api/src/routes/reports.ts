// Reports (PROD §15.1): inclusive local dates, at most 92 days (ADV-TM02). Their CSVs are exports,
// built in the background (routes/exports.ts). The location report reads location history: it
// needs location-history access, asks for the reason when the organization requires one, and is
// audited before any point is read (SEC §16.4, INV-14).
import {
  attendanceQuerySchema,
  attendanceResponseSchema,
  errorEnvelopeSchema,
  incidentReportQuerySchema,
  incidentReportResponseSchema,
  locationReportQuerySchema,
  locationReportResponseSchema,
  patrolReportQuerySchema,
  patrolReportResponseSchema,
  siteActivityQuerySchema,
  siteActivityResponseSchema,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';

import { auditActor, can, orgOf } from '../context.ts';
import { AppError, forbidden } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import { organizationSettings } from '../repositories/organizations.ts';
import {
  attendanceReport,
  incidentReport,
  LOCATION_REPORT_PAGE_SHIFTS,
  locationReport,
  patrolReport,
  reportScope,
  siteActivityReport,
} from '../services/reports.ts';
import { defineRoute } from './registry.ts';

const READ = { kind: 'permission', permission: 'reports.read' } as const;
const ERRORS = { 400: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema } as const;

export const reportRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/reports/attendance',
    summary: 'Attendance per shift (PROD §6.8) for inclusive local dates, at most 92 days.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    query: attendanceQuerySchema,
    responses: { 200: attendanceResponseSchema, ...ERRORS },
    handler: ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) =>
        attendanceReport(trx, org.id, await reportScope(trx, org.id, query)),
      );
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/reports/patrols',
    summary:
      'Patrol rounds with required, verified, QR-only and missed checkpoints and completion (PROD §15.1).',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    query: patrolReportQuerySchema,
    responses: { 200: patrolReportResponseSchema, ...ERRORS },
    handler: ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) =>
        patrolReport(trx, org.id, await reportScope(trx, org.id, query)),
      );
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/reports/incidents',
    summary: 'Incidents with times to acknowledge and resolve (PROD §15.1); drills only when asked for.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    query: incidentReportQuerySchema,
    responses: { 200: incidentReportResponseSchema, ...ERRORS },
    handler: ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) =>
        incidentReport(trx, org.id, await reportScope(trx, org.id, query), query.drills === 'include'),
      );
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/reports/site-activity',
    summary:
      'Proof of service per site and local date: shifts covered, attendance, patrols, incidents (PROD §15.1).',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    query: siteActivityQuerySchema,
    responses: { 200: siteActivityResponseSchema, ...ERRORS },
    handler: ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      return withTenantTransaction(deps.db, org.id, async (trx) =>
        siteActivityReport(
          trx,
          org.id,
          await reportScope(trx, org.id, query),
          await organizationSettings(trx, org.id),
        ),
      );
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/reports/locations',
    summary:
      'Per shift: time inside, outside and unknown, excursions, gaps, distance (PROD §15.1). Location-history access: audited first, with the reason (INV-14).',
    policy: {
      access: { kind: 'permission', permission: 'location.history.read' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'LOCATION_REPORT_VIEWED',
    },
    query: locationReportQuerySchema,
    responses: { 200: locationReportResponseSchema, 403: errorEnvelopeSchema, ...ERRORS },
    handler: ({ deps, ctx, query }) => {
      if (!can(ctx, 'reports.read')) throw forbidden();
      const org = orgOf(ctx);
      const now = deps.clock.now();
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const scope = await reportScope(trx, org.id, query);
        const settings = await organizationSettings(trx, org.id);
        // D-21: the reason field is always offered; the organization may make it mandatory.
        const reason = query.reason?.trim() || null;
        if (settings['privacy.require_history_access_reason'] === true && !reason) {
          throw new AppError(
            'VALIDATION_FAILED',
            'Your organization asks for a reason to view location history.',
            [{ path: 'reason', issue: 'required' }],
          );
        }
        // INV-14: the audit row comes first; if it can't be written, no point is read.
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'LOCATION_REPORT_VIEWED',
          resourceType: 'report',
          resourceId: null,
          reason,
          metadata: {
            from: query.from,
            to: query.to,
            siteId: query.siteId ?? null,
            guardId: query.guardId ?? null,
          },
        });
        return locationReport(trx, org.id, scope, settings, now, LOCATION_REPORT_PAGE_SHIFTS);
      });
    },
  }),
];
