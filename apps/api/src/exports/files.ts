// The file for each kind of export (PROD §15.2): CSV, UTF-8 with a BOM, every cell formula-safe
// (SEC §8, ADV-W02); a ZIP of CSVs for a guard's data (SEC §16.6). Built by the export runner in the
// organization's own transaction, so it can only ever read that organization's data (ADV-T03).
import { incidentReference, type ExportRequest } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import { csvDocument, localDate, localToUtc, addDays } from '@sentryops/domain';

import { getGuard } from '../repositories/guards.ts';
import { getOrganization } from '../repositories/organizations.ts';
import { trackForExport } from '../repositories/reports.ts';
import { getShift, listShifts } from '../repositories/shifts.ts';
import {
  attendanceReport,
  incidentReport,
  LOCATION_REPORT_EXPORT_SHIFTS,
  locationReport,
  patrolReport,
  reportScope,
  siteActivityReport,
} from '../services/reports.ts';
import { zip } from './zip.ts';

export type ExportFile = {
  readonly body: Buffer;
  readonly contentType: string;
  readonly fileName: string;
  readonly rowCount: number;
};

/** A shift's points run from start − 60 s to end + 60 s (ARCH §9.2). */
const SHIFT_WINDOW_MS = 60_000;
const TRACK_EXPORT_LIMIT = 1_000_000;
const GUARD_SHIFT_LIMIT = 50_000;
const EPOCH = new Date('2020-01-01T00:00:00.000Z');

/** "2026-10-08 20:05" in the zone: what a spreadsheet user reads. */
export function localTime(at: Date | string | null, timeZone: string): string {
  if (at === null) return '';
  const d = typeof at === 'string' ? new Date(at) : at;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return `${localDate(d, timeZone)} ${time}`;
}

const minutes = (seconds: number | null) => (seconds === null ? null : Math.round(seconds / 60));
const csv = (header: readonly string[], rows: readonly (readonly (string | number | null)[])[]) =>
  Buffer.from(csvDocument(header, rows), 'utf8');
const csvFile = (
  name: string,
  header: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
) => ({
  body: csv(header, rows),
  contentType: 'text/csv; charset=utf-8',
  fileName: name,
  rowCount: rows.length,
});
const safeName = (value: string) =>
  value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'file';

export async function buildExportFile(
  trx: Database,
  organizationId: string,
  request: ExportRequest,
  settings: Record<string, unknown>,
  now: Date,
): Promise<ExportFile> {
  switch (request.kind) {
    case 'ATTENDANCE': {
      const scope = await reportScope(trx, organizationId, request);
      const r = await attendanceReport(trx, organizationId, scope);
      const tz = r.timezone;
      return csvFile(
        `attendance-${r.from}-to-${r.to}.csv`,
        [
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
        ],
        r.rows.map((x) => [
          x.guard.displayName,
          x.guard.employeeNumber,
          x.site.name,
          localTime(x.scheduledStart, tz),
          localTime(x.scheduledEnd, tz),
          localTime(x.actualStart, tz),
          localTime(x.actualEnd, tz),
          x.status,
          x.lateMinutes,
          x.earlyLeaveMinutes,
          x.workedMinutes,
          x.flags.join(' '),
        ]),
      );
    }
    case 'PATROLS': {
      const scope = await reportScope(trx, organizationId, request);
      const r = await patrolReport(trx, organizationId, scope);
      const tz = r.timezone;
      return csvFile(
        `patrols-${r.from}-to-${r.to}.csv`,
        [
          'Guard',
          'Employee number',
          'Site',
          'Route',
          'Round',
          'Due',
          'Window ends',
          'Status',
          'Required',
          'Verified',
          'QR only',
          'Missed',
          'Completion (%)',
          'Flags',
        ],
        r.rows.map((x) => [
          x.guard.displayName,
          x.guard.employeeNumber,
          x.site.name,
          x.route.name,
          x.sequenceNo,
          localTime(x.dueAt, tz),
          localTime(x.windowEndsAt, tz),
          x.status,
          x.required,
          x.verified,
          x.qrOnly,
          x.missed,
          x.completionPct,
          x.flags.join(' '),
        ]),
      );
    }
    case 'INCIDENTS': {
      const scope = await reportScope(trx, organizationId, request);
      const r = await incidentReport(trx, organizationId, scope, request.drills === 'include');
      const tz = r.timezone;
      return csvFile(
        `incidents-${r.from}-to-${r.to}.csv`,
        [
          'Reference',
          'Type',
          'Severity',
          'Site',
          'Guard',
          'Employee number',
          'Occurred',
          'Reported',
          'Status',
          'To acknowledge (min)',
          'To resolve (min)',
          'Drill',
        ],
        r.rows.map((x) => [
          x.referenceNumber,
          x.type,
          x.severity,
          x.site?.name ?? '',
          x.guard?.displayName ?? '',
          x.guard?.employeeNumber ?? '',
          localTime(x.occurredAt, tz),
          localTime(x.reportedAt, tz),
          x.status,
          minutes(x.secondsToAcknowledge),
          minutes(x.secondsToResolve),
          x.isDrill ? 'yes' : 'no',
        ]),
      );
    }
    case 'SITE_ACTIVITY': {
      const scope = await reportScope(trx, organizationId, request);
      const r = await siteActivityReport(trx, organizationId, scope, settings);
      return csvFile(
        `site-activity-${r.from}-to-${r.to}.csv`,
        [
          'Site',
          'Date',
          'Shifts scheduled',
          'Shifts covered',
          'Shifts missed',
          'Late starts',
          'Worked (min)',
          'Checkpoints required',
          'Checkpoints done',
          'Patrol completion (%)',
          'Incidents',
          'High or critical',
        ],
        r.rows.map((x) => [
          x.site.name,
          x.date,
          x.shiftsScheduled,
          x.shiftsCovered,
          x.shiftsMissed,
          x.lateStarts,
          x.workedMinutes,
          x.patrolRequired,
          x.patrolCounted,
          x.patrolCompletionPct,
          x.incidents,
          x.incidentsHighOrCritical,
        ]),
      );
    }
    case 'LOCATION_REPORT': {
      const scope = await reportScope(trx, organizationId, request);
      const r = await locationReport(
        trx,
        organizationId,
        scope,
        settings,
        now,
        LOCATION_REPORT_EXPORT_SHIFTS,
      );
      const tz = r.timezone;
      return csvFile(
        `location-report-${r.from}-to-${r.to}.csv`,
        [
          'Guard',
          'Employee number',
          'Site',
          'Scheduled start',
          'First fix',
          'Last fix',
          'Inside (min)',
          'Outside (min)',
          'Unknown (min)',
          'Excursions',
          'Longest excursion (min)',
          'Longest gap (min)',
          'Distance (km)',
          'Points',
          'Track deleted',
        ],
        r.rows.map((x) => [
          x.guard.displayName,
          x.guard.employeeNumber,
          x.site.name,
          localTime(x.scheduledStart, tz),
          localTime(x.firstFixAt, tz),
          localTime(x.lastFixAt, tz),
          minutes(x.insideSeconds),
          minutes(x.outsideSeconds),
          minutes(x.unknownSeconds),
          x.excursions.length,
          minutes(Math.max(0, ...x.excursions.map((e) => e.seconds))),
          minutes(x.longestGapSeconds),
          Math.round(x.distanceM / 100) / 10,
          x.points,
          x.trackDeleted ? 'yes' : 'no',
        ]),
      );
    }
    case 'LOCATION_HISTORY': {
      const guard = await getGuard(trx, organizationId, request.guardId);
      if (!guard) throw new Error('export guard vanished');
      const timezone = (await getOrganization(trx, organizationId))?.timezone ?? 'Asia/Karachi';
      let from: Date;
      let to: Date;
      let label: string;
      if (request.shiftId) {
        const shift = await getShift(trx, organizationId, request.shiftId);
        if (!shift || shift.guardId !== guard.id) throw new Error('export shift vanished');
        from = new Date((shift.actualStartedAt ?? shift.startsAt).getTime() - SHIFT_WINDOW_MS);
        to = new Date((shift.actualEndedAt ?? now).getTime() + SHIFT_WINDOW_MS);
        label = localDate(shift.startsAt, shift.siteTimezone);
      } else {
        from = localToUtc(request.from ?? '', '00:00', timezone);
        to = localToUtc(addDays(request.to ?? '', 1), '00:00', timezone);
        label = `${request.from}-to-${request.to}`;
      }
      const points = await trackForExport(
        trx,
        organizationId,
        { guardId: guard.id, shiftId: request.shiftId, from, to },
        TRACK_EXPORT_LIMIT,
      );
      return csvFile(
        `location-${safeName(guard.employeeNumber)}-${label}.csv`,
        LOCATION_HEADER,
        points.map((p) => locationLine(p, timezone)),
      );
    }
    case 'GUARD_DATA':
      return guardData(trx, organizationId, request.guardId, now);
  }
}

const LOCATION_HEADER = [
  'Shift',
  'Site',
  'Captured',
  'Latitude',
  'Longitude',
  'Accuracy (m)',
  'Speed (m/s)',
  'Source',
  'Provider',
  'Mock location',
  'Flags',
  'Received',
];

function locationLine(p: Awaited<ReturnType<typeof trackForExport>>[number], timezone: string) {
  return [
    p.shift_id ?? (p.sos_event_id ? 'SOS' : ''),
    p.site_name ?? '',
    localTime(p.captured_at, timezone),
    p.latitude,
    p.longitude,
    p.accuracy_m,
    p.speed_mps,
    p.source,
    p.provider,
    p.is_mock === null ? '' : p.is_mock ? 'yes' : 'no',
    p.flags.join(' '),
    localTime(p.received_at, timezone),
  ];
}

/** SEC §16.6: everything the organization still holds about one guard, in one ZIP. */
async function guardData(
  trx: Database,
  organizationId: string,
  guardId: string,
  now: Date,
): Promise<ExportFile> {
  const guard = await getGuard(trx, organizationId, guardId);
  if (!guard) throw new Error('export guard vanished');
  const timezone = (await getOrganization(trx, organizationId))?.timezone ?? 'Asia/Karachi';
  const shifts = await listShifts(trx, organizationId, {
    from: EPOCH,
    to: new Date(now.getTime() + 366 * 86_400_000),
    guardId: guard.id,
    limit: GUARD_SHIFT_LIMIT,
  });
  const points = await trackForExport(
    trx,
    organizationId,
    { guardId: guard.id, from: EPOCH, to: now },
    TRACK_EXPORT_LIMIT,
  );
  const incidents = await trx
    .selectFrom('incidents as i')
    .leftJoin('sites as s', (j) =>
      j.onRef('s.organization_id', '=', 'i.organization_id').onRef('s.id', '=', 'i.site_id'),
    )
    .select([
      'i.reference_number',
      'i.type',
      'i.severity',
      'i.status',
      'i.title',
      'i.description',
      's.name as site_name',
      'i.occurred_at',
      'i.reported_at',
      'i.latitude',
      'i.longitude',
      'i.accuracy_m',
    ])
    .where('i.organization_id', '=', organizationId)
    .where('i.guard_id', '=', guard.id)
    .orderBy('i.occurred_at')
    .execute();

  const files = [
    {
      name: 'profile.csv',
      data: csv(
        ['Name', 'Employee number', 'Phone', 'Status', 'Language', 'Added'],
        [
          [
            guard.displayName,
            guard.employeeNumber,
            guard.phone,
            guard.status,
            guard.preferredLocale,
            localTime(guard.createdAt, timezone),
          ],
        ],
      ),
    },
    {
      name: 'shifts.csv',
      data: csv(
        ['Site', 'Scheduled start', 'Scheduled end', 'Actual start', 'Actual end', 'Status'],
        shifts.map((s) => [
          s.siteName,
          localTime(s.startsAt, s.siteTimezone),
          localTime(s.endsAt, s.siteTimezone),
          localTime(s.actualStartedAt, s.siteTimezone),
          localTime(s.actualEndedAt, s.siteTimezone),
          s.status,
        ]),
      ),
    },
    {
      name: 'location.csv',
      data: csv(
        LOCATION_HEADER,
        points.map((p) => locationLine(p, timezone)),
      ),
    },
    {
      name: 'incidents.csv',
      data: csv(
        [
          'Reference',
          'Type',
          'Severity',
          'Status',
          'Title',
          'Description',
          'Site',
          'Occurred',
          'Reported',
          'Latitude',
          'Longitude',
          'Accuracy (m)',
        ],
        incidents.map((i) => [
          incidentReference(i.reference_number),
          i.type,
          i.severity,
          i.status,
          i.title,
          i.description,
          i.site_name ?? '',
          localTime(i.occurred_at, timezone),
          localTime(i.reported_at, timezone),
          i.latitude,
          i.longitude,
          i.accuracy_m,
        ]),
      ),
    },
  ];
  return {
    body: zip(files, now),
    contentType: 'application/zip',
    fileName: `guard-data-${safeName(guard.employeeNumber)}-${localDate(now, timezone)}.zip`,
    rowCount: 1 + shifts.length + points.length + incidents.length,
  };
}
