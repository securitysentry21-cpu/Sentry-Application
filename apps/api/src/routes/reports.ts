// Reports (PROD §15). The attendance report holds no coordinates, so it is not location-history
// access; its CSV export is permission-checked and audited (PROD §15.2), small enough to build in
// the request, UTF-8 with a BOM for Excel and Urdu, and protected against formula injection (SEC §8).
import {
  attendanceQuerySchema,
  attendanceResponseSchema,
  errorEnvelopeSchema,
  REPORT_MAX_DAYS,
  type AttendanceRow,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { addDays, attendance, csvCell, localDate, localToUtc } from '@sentryops/domain';
import { z } from 'zod';

import { auditActor, orgOf, type RequestContext } from '../context.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, notFound } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import { getOrganization } from '../repositories/organizations.ts';
import { listShifts } from '../repositories/shifts.ts';
import { getSite } from '../repositories/sites.ts';
import { defineRoute } from './registry.ts';

const MAX_ROWS = 10_000;
/** Excel reads UTF-8 (and so Urdu) correctly only with a byte-order mark (PROD §15.2). */
const BOM = String.fromCharCode(0xfeff);
const DAY_MS = 86_400_000;

type Query = z.infer<typeof attendanceQuerySchema>;

async function attendanceReport(deps: AppDeps, ctx: RequestContext, q: Query) {
  const org = orgOf(ctx);
  const days = Math.round((Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days < 1) throw new AppError('VALIDATION_FAILED', '"to" must not be before "from".');
  if (days > REPORT_MAX_DAYS) {
    throw new AppError('EXPORT_RANGE_TOO_LARGE', `At most ${REPORT_MAX_DAYS} days per report.`);
  }
  return withTenantTransaction(deps.db, org.id, async (trx) => {
    let timezone: string;
    if (q.siteId) {
      const site = await getSite(trx, org.id, q.siteId);
      if (!site) throw notFound();
      timezone = site.timezone;
    } else {
      timezone = (await getOrganization(trx, org.id))?.timezone ?? 'Asia/Karachi';
    }
    const from = localToUtc(q.from, '00:00', timezone);
    const to = localToUtc(addDays(q.to, 1), '00:00', timezone);
    const shifts = await listShifts(trx, org.id, {
      from,
      to,
      ...(q.siteId ? { siteId: q.siteId } : {}),
      limit: MAX_ROWS + 1,
      startsWithin: true,
    });
    const rows: AttendanceRow[] = shifts.slice(0, MAX_ROWS).map((s) => {
      const a = attendance(s);
      return {
        shiftId: s.id,
        guard: { id: s.guardId, displayName: s.guardName, employeeNumber: s.employeeNumber },
        site: { id: s.siteId, name: s.siteName },
        scheduledStart: s.startsAt.toISOString(),
        scheduledEnd: s.endsAt.toISOString(),
        actualStart: s.actualStartedAt?.toISOString() ?? null,
        actualEnd: s.actualEndedAt?.toISOString() ?? null,
        status: s.status,
        lateMinutes: a.lateMinutes,
        earlyLeaveMinutes: a.earlyLeaveMinutes,
        workedMinutes: a.workedMinutes,
        flags: a.flags,
      };
    });
    return { timezone, from: q.from, to: q.to, rows, truncated: shifts.length > MAX_ROWS };
  });
}

const local = (iso: string | null, timeZone: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return `${localDate(d, timeZone)} ${time}`;
};

export const reportRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/reports/attendance',
    summary: 'Attendance per shift (PROD §6.8) for inclusive local dates, at most 92 days.',
    policy: {
      access: { kind: 'permission', permission: 'reports.read' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: null,
    },
    query: attendanceQuerySchema,
    responses: { 200: attendanceResponseSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema },
    handler: ({ deps, ctx, query }) => attendanceReport(deps, ctx, query),
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/reports/attendance/export',
    summary: 'The attendance report as CSV (UTF-8 with BOM, formula-safe). Audited.',
    policy: {
      access: { kind: 'permission', permission: 'exports.create' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'EXPORT_REQUESTED',
    },
    query: attendanceQuerySchema,
    responses: { 200: z.string(), 404: errorEnvelopeSchema, 422: errorEnvelopeSchema },
    handler: async ({ deps, ctx, query, reply }) => {
      const org = orgOf(ctx);
      const report = await attendanceReport(deps, ctx, query);
      await withTenantTransaction(deps.db, org.id, (trx) =>
        recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'EXPORT_REQUESTED',
          resourceType: 'report',
          resourceId: null,
          metadata: {
            report: 'attendance',
            from: query.from,
            to: query.to,
            siteId: query.siteId ?? null,
            rows: report.rows.length,
          },
        }),
      );
      const tz = report.timezone;
      const header = [
        'Guard',
        'Employee number',
        'Site',
        'Scheduled start',
        'Scheduled end',
        'Actual start',
        'Actual end',
        'Status',
        'Late (min)',
        'Early leave (min)',
        'Worked (min)',
        'Flags',
      ];
      const lines = [header.map(csvCell).join(',')];
      for (const r of report.rows) {
        lines.push(
          [
            r.guard.displayName,
            r.guard.employeeNumber,
            r.site.name,
            local(r.scheduledStart, tz),
            local(r.scheduledEnd, tz),
            local(r.actualStart, tz),
            local(r.actualEnd, tz),
            r.status,
            r.lateMinutes,
            r.earlyLeaveMinutes,
            r.workedMinutes,
            r.flags.join(' '),
          ]
            .map(csvCell)
            .join(','),
        );
      }
      void reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="attendance-${query.from}-to-${query.to}.csv"`);
      return `${BOM}${lines.join('\r\n')}\r\n`;
    },
  }),
];
