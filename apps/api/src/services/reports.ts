// Reports (PROD §15.1): the figures for the dashboard's report pages and for exports. One scope
// check for all of them: inclusive local dates in the site's zone (the organization's for several
// sites, ADV-TM02), at most 92 days, and site and guard IDs that belong to this organization
// (anything else is not found, ADV-T03).
import {
  incidentReference,
  REPORT_MAX_DAYS,
  type AttendanceRow,
  type IncidentReportRow,
  type LocationReportRow,
  type PatrolReportRow,
  type SiteActivityRow,
} from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import {
  attendance,
  emptySiteDay,
  incidentTimings,
  localDate,
  localRange,
  locationSummary,
  patrolCompletionPct,
  patrolFigures,
  type SiteDayFacts,
} from '@sentryops/domain';

import { AppError, notFound } from '../errors.ts';
import { getGuard } from '../repositories/guards.ts';
import { getOrganization, numberSetting } from '../repositories/organizations.ts';
import { listRuns, visitsForRuns } from '../repositories/patrols.ts';
import { incidentsForReport, shiftTrack } from '../repositories/reports.ts';
import { listShifts, type ShiftRow } from '../repositories/shifts.ts';
import { getSite } from '../repositories/sites.ts';
import { geofenceSettingsFrom } from './geofence.ts';

/** One report (or export) holds at most this many rows; the response says when there were more. */
export const REPORT_ROW_LIMIT = 10_000;
/** The location report reads every point of every shift: the page shows fewer than an export. */
export const LOCATION_REPORT_PAGE_SHIFTS = 200;
export const LOCATION_REPORT_EXPORT_SHIFTS = 5_000;
const TRACK_LIMIT = 50_000;
/** An excursion confirmed by a fix that arrived this long after it was taken was detected late. */
const DETECTED_LATE_S = 300;
const DAY_MS = 86_400_000;

export type ReportQuery = {
  readonly from: string;
  readonly to: string;
  readonly siteId?: string | undefined;
  readonly guardId?: string | undefined;
};

export type ReportScope = ReportQuery & {
  readonly timezone: string;
  readonly start: Date;
  readonly end: Date;
};

export type Report<Row> = {
  timezone: string;
  from: string;
  to: string;
  rows: Row[];
  truncated: boolean;
};

export async function reportScope(
  trx: Database,
  organizationId: string,
  q: ReportQuery,
): Promise<ReportScope> {
  let timezone: string;
  if (q.siteId) {
    const site = await getSite(trx, organizationId, q.siteId);
    if (!site) throw notFound();
    timezone = site.timezone;
  } else {
    timezone = (await getOrganization(trx, organizationId))?.timezone ?? 'Asia/Karachi';
  }
  if (q.guardId && !(await getGuard(trx, organizationId, q.guardId))) throw notFound();
  const range = localRange(q.from, q.to, timezone);
  if (!Number.isFinite(range.days) || range.days < 1) {
    throw new AppError('VALIDATION_FAILED', '"to" must not be before "from".');
  }
  if (range.days > REPORT_MAX_DAYS) {
    throw new AppError('EXPORT_RANGE_TOO_LARGE', `At most ${REPORT_MAX_DAYS} days per report or export.`);
  }
  return { ...q, timezone, start: range.start, end: range.end };
}

const report = <Row>(scope: ReportScope, rows: Row[], truncated: boolean): Report<Row> => ({
  timezone: scope.timezone,
  from: scope.from,
  to: scope.to,
  rows,
  truncated,
});

const guardRef = (s: Pick<ShiftRow, 'guardId' | 'guardName' | 'employeeNumber'>) => ({
  id: s.guardId,
  displayName: s.guardName,
  employeeNumber: s.employeeNumber,
});

async function shiftsInScope(trx: Database, organizationId: string, scope: ReportScope, limit: number) {
  const shifts = await listShifts(trx, organizationId, {
    from: scope.start,
    to: scope.end,
    ...(scope.siteId ? { siteId: scope.siteId } : {}),
    ...(scope.guardId ? { guardId: scope.guardId } : {}),
    limit: limit + 1,
    // A report counts a shift on the day it was scheduled to start.
    startsWithin: true,
  });
  return { shifts: shifts.slice(0, limit), truncated: shifts.length > limit };
}

// ── Attendance ──────────────────────────────────────────────────────────────────────────────

export async function attendanceReport(
  trx: Database,
  organizationId: string,
  scope: ReportScope,
  limit = REPORT_ROW_LIMIT,
): Promise<Report<AttendanceRow>> {
  const { shifts, truncated } = await shiftsInScope(trx, organizationId, scope, limit);
  const rows = shifts.map((s): AttendanceRow => {
    const a = attendance(s);
    return {
      shiftId: s.id,
      guard: guardRef(s),
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
  return report(scope, rows, truncated);
}

// ── Patrols ─────────────────────────────────────────────────────────────────────────────────

async function guardRefs(trx: Database, organizationId: string, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, { id: string; displayName: string; employeeNumber: string }>();
  const rows = await trx
    .selectFrom('guards')
    .select(['id', 'display_name', 'employee_number'])
    .where('organization_id', '=', organizationId)
    .where('id', 'in', [...new Set(ids)])
    .execute();
  return new Map(
    rows.map((r) => [r.id, { id: r.id, displayName: r.display_name, employeeNumber: r.employee_number }]),
  );
}

export async function patrolReport(
  trx: Database,
  organizationId: string,
  scope: ReportScope,
  limit = REPORT_ROW_LIMIT,
): Promise<Report<PatrolReportRow>> {
  const runs = await listRuns(trx, organizationId, {
    from: scope.start,
    to: scope.end,
    siteId: scope.siteId,
    guardId: scope.guardId,
    limit: limit + 1,
  });
  const kept = runs.slice(0, limit).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  const visits = await visitsForRuns(
    trx,
    organizationId,
    kept.map((r) => r.id),
  );
  const guards = await guardRefs(
    trx,
    organizationId,
    kept.map((r) => r.guardId),
  );
  const rows = kept.map((r): PatrolReportRow => {
    const figures = patrolFigures(
      { status: r.status, requiredCount: r.requiredCount, countedCount: r.countedCount },
      visits
        .filter((v) => v.runId === r.id)
        .map((v) => ({
          checkpointId: v.checkpointId,
          verificationStatus: v.outcome,
          counted: v.counted,
          flags: v.flags,
          scannedAt: v.scannedAt,
          receivedAt: v.receivedAt,
        })),
    );
    return {
      runId: r.id,
      shiftId: r.shiftId,
      guard: guards.get(r.guardId) ?? { id: r.guardId, displayName: r.guardName, employeeNumber: '' },
      site: { id: r.siteId, name: r.siteName },
      route: { id: r.routeId, name: r.routeName },
      sequenceNo: r.sequenceNo,
      dueAt: r.dueAt.toISOString(),
      windowEndsAt: r.windowEndsAt.toISOString(),
      status: r.status,
      required: r.requiredCount,
      verified: figures.verified,
      qrOnly: figures.qrOnly,
      missed: figures.missed,
      completionPct: figures.completionPct,
      flags: figures.flags,
    };
  });
  return report(scope, rows, runs.length > limit);
}

// ── Incidents ───────────────────────────────────────────────────────────────────────────────

export async function incidentReport(
  trx: Database,
  organizationId: string,
  scope: ReportScope,
  includeDrills: boolean,
  limit = REPORT_ROW_LIMIT,
): Promise<Report<IncidentReportRow>> {
  const found = await incidentsForReport(trx, organizationId, {
    from: scope.start,
    to: scope.end,
    siteId: scope.siteId,
    guardId: scope.guardId,
    includeDrills,
    limit: limit + 1,
  });
  const rows = found.slice(0, limit).map((i): IncidentReportRow => ({
    incidentId: i.id,
    referenceNumber: incidentReference(i.referenceNumber),
    type: i.type as IncidentReportRow['type'],
    severity: i.severity as IncidentReportRow['severity'],
    site: i.siteId ? { id: i.siteId, name: i.siteName ?? '' } : null,
    guard: i.guardId
      ? { id: i.guardId, displayName: i.guardName ?? '', employeeNumber: i.employeeNumber ?? '' }
      : null,
    occurredAt: i.occurredAt.toISOString(),
    reportedAt: i.reportedAt.toISOString(),
    status: i.status as IncidentReportRow['status'],
    ...incidentTimings(i),
    isDrill: i.isDrill,
  }));
  return report(scope, rows, found.length > limit);
}

// ── Location ────────────────────────────────────────────────────────────────────────────────

/**
 * Per shift, from its track (PROD §15.1). The caller has audited the read (LOCATION_REPORT_VIEWED
 * or LOCATION_HISTORY_EXPORTED) before calling this (INV-14).
 */
export async function locationReport(
  trx: Database,
  organizationId: string,
  scope: ReportScope,
  settings: Record<string, unknown>,
  now: Date,
  maxShifts: number,
): Promise<Report<LocationReportRow>> {
  const { shifts, truncated } = await shiftsInScope(trx, organizationId, scope, maxShifts);
  const geofence = geofenceSettingsFrom(settings);
  const staleAfterS = numberSetting(settings, 'freshness.location_stale_after_s', 420);
  const locationCutoff = now.getTime() - numberSetting(settings, 'retention.location_days', 90) * DAY_MS;
  const rows: LocationReportRow[] = [];
  for (const s of shifts) {
    const end = s.actualEndedAt ?? (s.status === 'ACTIVE' ? now : null);
    const window = s.actualStartedAt && end ? { start: s.actualStartedAt, end } : null;
    const fixes = await shiftTrack(trx, organizationId, s.id, TRACK_LIMIT);
    const summary = locationSummary({
      window,
      fixes,
      boundary: s.siteBoundary,
      geofence,
      staleAfterS,
      lateAfterS: DETECTED_LATE_S,
    });
    const ended = (s.actualEndedAt ?? s.endsAt).getTime();
    const trackDeleted = fixes.length === 0 && window !== null && ended < locationCutoff;
    rows.push({
      shiftId: s.id,
      guard: guardRef(s),
      site: { id: s.siteId, name: s.siteName },
      scheduledStart: s.startsAt.toISOString(),
      scheduledEnd: s.endsAt.toISOString(),
      firstFixAt: summary.firstFixAt?.toISOString() ?? null,
      lastFixAt: summary.lastFixAt?.toISOString() ?? null,
      // Without its track a shift's split can't be known: all of it is unknown, said plainly.
      insideSeconds: summary.insideSeconds,
      outsideSeconds: summary.outsideSeconds,
      unknownSeconds: summary.unknownSeconds,
      excursions: summary.excursions.map((e) => ({
        from: e.from.toISOString(),
        to: e.to?.toISOString() ?? null,
        seconds: e.seconds,
        detectedLate: e.detectedLate,
      })),
      longestGapSeconds: summary.longestGapSeconds,
      distanceM: summary.distanceM,
      points: summary.points,
      trackDeleted,
    });
  }
  return report(scope, rows, truncated);
}

// ── Site activity (R2) ──────────────────────────────────────────────────────────────────────

export async function siteActivityReport(
  trx: Database,
  organizationId: string,
  scope: ReportScope,
  settings: Record<string, unknown>,
  limit = REPORT_ROW_LIMIT,
): Promise<Report<SiteActivityRow>> {
  const lateAfter = numberSetting(settings, 'shift.late_alert_after_minutes', 10);
  const { shifts, truncated } = await shiftsInScope(trx, organizationId, scope, limit);
  const runs = await listRuns(trx, organizationId, {
    from: scope.start,
    to: scope.end,
    siteId: scope.siteId,
    guardId: scope.guardId,
    limit,
  });
  const incidents = await incidentsForReport(trx, organizationId, {
    from: scope.start,
    to: scope.end,
    siteId: scope.siteId,
    guardId: scope.guardId,
    includeDrills: false,
    limit,
  });
  // Each site's days are its own local dates; a site seen only through incidents uses the report's zone.
  const sites = new Map<string, { name: string; timezone: string }>();
  for (const s of shifts) sites.set(s.siteId, { name: s.siteName, timezone: s.siteTimezone });
  for (const r of runs)
    if (!sites.has(r.siteId)) sites.set(r.siteId, { name: r.siteName, timezone: r.siteTimezone });
  const days = new Map<string, SiteDayFacts>();
  const day = (siteId: string, at: Date) => {
    const zone = sites.get(siteId)?.timezone ?? scope.timezone;
    const key = `${siteId}|${localDate(at, zone)}`;
    let facts = days.get(key);
    if (!facts) {
      facts = emptySiteDay();
      days.set(key, facts);
    }
    return facts;
  };
  for (const s of shifts) {
    const d = day(s.siteId, s.startsAt);
    if (s.status === 'CANCELLED') continue;
    d.shiftsScheduled++;
    if (s.status === 'MISSED') d.shiftsMissed++;
    if (s.actualStartedAt) d.shiftsCovered++;
    const a = attendance(s);
    if (a.lateMinutes !== null && a.lateMinutes > lateAfter) d.lateStarts++;
    d.workedMinutes += a.workedMinutes ?? 0;
  }
  for (const r of runs) {
    if (r.status === 'CANCELLED') continue;
    const d = day(r.siteId, r.dueAt);
    d.patrolRequired += r.requiredCount;
    d.patrolCounted += Math.min(r.countedCount, r.requiredCount);
  }
  for (const i of incidents) {
    if (!i.siteId) continue;
    if (!sites.has(i.siteId)) sites.set(i.siteId, { name: i.siteName ?? '', timezone: scope.timezone });
    const d = day(i.siteId, i.occurredAt);
    d.incidents++;
    if (i.severity === 'HIGH' || i.severity === 'CRITICAL') d.incidentsHighOrCritical++;
  }
  const rows = [...days.entries()]
    .map(([key, facts]): SiteActivityRow => {
      const [siteId = '', date = ''] = key.split('|');
      return {
        site: { id: siteId, name: sites.get(siteId)?.name ?? '' },
        date,
        ...facts,
        patrolCompletionPct: patrolCompletionPct(facts.patrolRequired, facts.patrolCounted),
      };
    })
    .sort((a, b) => a.site.name.localeCompare(b.site.name) || a.date.localeCompare(b.date));
  return report(scope, rows, truncated);
}
