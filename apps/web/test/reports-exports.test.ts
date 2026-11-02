// Reports and exports in the dashboard (PROD §15): which reports and export buttons each role sees,
// the filters kept in the address, the requests they become (checked against the contracts' own
// schemas), and how durations, sizes, percentages and statuses read. The server decides every
// permission and limit; these are the dashboard's early answers, so they must agree with it.
import {
  attendanceQuerySchema,
  EXPORT_FILE_DAYS as CONTRACT_FILE_DAYS,
  EXPORT_KINDS,
  EXPORT_LINK_TTL_S,
  EXPORT_STATUSES,
  exportJobSchema,
  exportRequestSchema,
  historyReasonSchema,
  incidentReportQuerySchema,
  locationReportQuerySchema,
  patrolReportQuerySchema,
  REPORT_MAX_DAYS as CONTRACT_MAX_DAYS,
  ROLE_PERMISSIONS,
  ROLES,
  siteActivityQuerySchema,
  type ExportJob,
  type LocationReportRow,
  type Permission,
  type Role,
} from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../lib/api';
import {
  canExport,
  describeExportError,
  EXPORT_FILE_DAYS,
  EXPORT_KIND_LABEL,
  EXPORT_LINK_MINUTES,
  EXPORT_STATUS_LABEL,
  formatBytes,
  guardDataExport,
  historyExport,
  isPending,
  isWebLink,
  mayOpenExports,
  newlyReady,
  readyMessage,
  statusDetail,
} from '../lib/exports';
import {
  attendanceFlagsText,
  dayCount,
  dayLabel,
  excursionsText,
  excursionText,
  exportRequest,
  filtersHref,
  filtersKey,
  formatKm,
  formatMinutes,
  formatPct,
  formatSeconds,
  patrolFlagsText,
  periodText,
  rangeProblem,
  readFilters,
  REASON_MAX,
  REPORT_MAX_DAYS,
  REPORT_TABS,
  reportQuery,
  reportStats,
  spanText,
  visibleTabs,
  type ReportFilters,
  type ReportTab,
} from '../lib/reports';

const id = (n: number) => `0190a0d2-7c5e-7000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(1);
const GUARD = id(2);
const USER = id(3);
const MEMBER = id(4);
const TODAY = '2026-11-02';
const ALL_TABS = REPORT_TABS.map((t) => t.id);

const canFor = (role: Role) => (p: Permission) => ROLE_PERMISSIONS[role].has(p);
const canWith =
  (...granted: Permission[]) =>
  (p: Permission) =>
    granted.includes(p);
const params = (query: string) => new URLSearchParams(query);

function job(overrides: Partial<ExportJob> = {}): ExportJob {
  return exportJobSchema.parse({
    id: id(10),
    kind: 'ATTENDANCE',
    status: 'RUNNING',
    title: 'Attendance · 2026-10-27 to 2026-11-02 · Main gate',
    requestedBy: { id: USER, name: 'Sarah K.' },
    containsLocation: false,
    rowCount: null,
    sizeBytes: null,
    fileName: null,
    createdAt: '2026-11-02T10:00:00Z',
    finishedAt: null,
    expiresAt: null,
    errorCode: null,
    ...overrides,
  });
}

describe('what each role sees (PROD §3.2, SEC §16.4, §16.6)', () => {
  it('shows every report to Owners, Administrators and Supervisors, and none to Dispatchers and guards', () => {
    const seen = Object.fromEntries(ROLES.map((role) => [role, visibleTabs(canFor(role))]));
    expect(seen).toEqual({
      OWNER: ALL_TABS,
      ADMIN: ALL_TABS,
      SUPERVISOR: ALL_TABS,
      DISPATCHER: [],
      GUARD: [],
    });
    // The location report needs location-history access on top of reports.
    expect(visibleTabs(canWith('reports.read'))).toEqual([
      'attendance',
      'patrols',
      'incidents',
      'site-activity',
    ]);
  });

  it("offers each export only with its permissions: location with location-history access, a guard's data to Owners and Administrators", () => {
    const offered = (can: (p: Permission) => boolean) => EXPORT_KINDS.filter((k) => canExport(k, can));
    const reportKinds = [
      'ATTENDANCE',
      'PATROLS',
      'INCIDENTS',
      'SITE_ACTIVITY',
      'LOCATION_REPORT',
      'LOCATION_HISTORY',
    ];
    expect(offered(canFor('OWNER'))).toEqual([...reportKinds, 'GUARD_DATA']);
    expect(offered(canFor('ADMIN'))).toEqual([...reportKinds, 'GUARD_DATA']);
    expect(offered(canFor('SUPERVISOR'))).toEqual(reportKinds);
    expect(offered(canFor('DISPATCHER'))).toEqual([]);
    expect(offered(canFor('GUARD'))).toEqual([]);
    expect(offered(canWith('exports.create'))).toEqual([
      'ATTENDANCE',
      'PATROLS',
      'INCIDENTS',
      'SITE_ACTIVITY',
    ]);
    expect(offered(canWith('location.history.read'))).toEqual([]);
    // The Exports page: anyone who may export something.
    expect(ROLES.filter((role) => mayOpenExports(canFor(role)))).toEqual(['OWNER', 'ADMIN', 'SUPERVISOR']);
    expect(mayOpenExports(canWith('exports.guard_data'))).toBe(true);
    expect(mayOpenExports(canWith('reports.read'))).toBe(false);
  });
});

describe('report filters in the address', () => {
  it('start from the last 7 local days, all sites and guards, drills left out', () => {
    expect(readFilters(params(''), TODAY, ALL_TABS)).toEqual({
      tab: 'attendance',
      from: '2026-10-27',
      to: TODAY,
      siteId: '',
      guardId: '',
      drills: 'exclude',
    });
  });

  it('keep what is valid, and fall back on anything else', () => {
    const kept = readFilters(
      params(`tab=incidents&from=2026-08-03&to=${TODAY}&siteId=${SITE}&guardId=${GUARD}&drills=include`),
      TODAY,
      ALL_TABS,
    );
    // 92 days, the most a report covers.
    expect(kept).toEqual({
      tab: 'incidents',
      from: '2026-08-03',
      to: TODAY,
      siteId: SITE,
      guardId: GUARD,
      drills: 'include',
    });
    const defaults = { from: '2026-10-27', to: TODAY };
    for (const range of [
      'from=2026-08-02&to=2026-11-02', // 93 days
      'from=2026-11-03&to=2026-11-02', // ends before it starts
      'from=2026-02-30&to=2026-03-02', // not a calendar date
      'from=2026-11-01', // half a range
      'from=yesterday&to=today',
    ]) {
      expect(readFilters(params(range), TODAY, ALL_TABS)).toMatchObject(defaults);
    }
    const odd = readFilters(params('tab=secret&siteId=1%20OR%201=1&guardId=x&drills=yes'), TODAY, ALL_TABS);
    expect(odd).toMatchObject({ tab: 'attendance', siteId: '', guardId: '', drills: 'exclude' });
    // A tab the role can't see opens the first one it can.
    const noLocation = ALL_TABS.filter((t) => t !== 'locations');
    expect(readFilters(params('tab=locations'), TODAY, noLocation).tab).toBe('attendance');
  });

  it('write only what differs from the defaults, and read back the same filters', () => {
    const base = readFilters(params(''), TODAY, ALL_TABS);
    expect(filtersHref('/reports', base, TODAY)).toBe('/reports');
    const chosen: ReportFilters = {
      tab: 'incidents',
      from: '2026-10-01',
      to: '2026-10-31',
      siteId: SITE,
      guardId: GUARD,
      drills: 'include',
    };
    const href = filtersHref('/reports', chosen, TODAY);
    expect(href).toBe(
      `/reports?tab=incidents&from=2026-10-01&to=2026-10-31&siteId=${SITE}&guardId=${GUARD}&drills=include`,
    );
    expect(readFilters(params(href.split('?')[1] ?? ''), TODAY, ALL_TABS)).toEqual(chosen);
  });

  it('tell reports apart by what they depend on', () => {
    const base = readFilters(params(''), TODAY, ALL_TABS);
    // Site activity is per site: the guard filter doesn't change it. Drills only change incidents.
    expect(filtersKey({ ...base, tab: 'site-activity', guardId: GUARD })).toBe(
      filtersKey({ ...base, tab: 'site-activity' }),
    );
    expect(filtersKey({ ...base, drills: 'include' })).toBe(filtersKey(base));
    expect(filtersKey({ ...base, tab: 'incidents', drills: 'include' })).not.toBe(
      filtersKey({ ...base, tab: 'incidents' }),
    );
    expect(filtersKey({ ...base, guardId: GUARD })).not.toBe(filtersKey(base));
  });

  it('refuse what the server refuses: at most 92 days, the start on or before the end', () => {
    expect(rangeProblem('2026-08-03', TODAY)).toBeNull();
    expect(rangeProblem(TODAY, TODAY)).toBeNull();
    expect(rangeProblem('2026-08-02', TODAY)).toBe('Choose at most 92 days.');
    expect(rangeProblem('2026-11-03', TODAY)).toBe('The start date must be on or before the end date.');
    expect(rangeProblem('', TODAY)).toBe('Enter both dates.');
    expect(dayCount('2026-10-27', TODAY)).toBe(7);
    expect(dayCount('2024-02-28', '2024-03-01')).toBe(3);
  });
});

describe('a report and its export ask for the same thing', () => {
  const filters = (tab: ReportTab): ReportFilters => ({
    tab,
    from: '2026-10-27',
    to: TODAY,
    siteId: SITE,
    guardId: GUARD,
    drills: 'include',
  });
  const query = (tab: ReportTab, reason = '') =>
    Object.fromEntries(new URLSearchParams(reportQuery(filters(tab), reason)));

  it("builds each report's query as the API reads it", () => {
    const range = { from: '2026-10-27', to: TODAY, siteId: SITE, guardId: GUARD };
    expect(attendanceQuerySchema.parse(query('attendance'))).toEqual(range);
    expect(patrolReportQuerySchema.parse(query('patrols'))).toEqual(range);
    expect(incidentReportQuerySchema.parse(query('incidents'))).toEqual({ ...range, drills: 'include' });
    // The reason only where it is read (D-21), trimmed; site activity is per site.
    expect(locationReportQuerySchema.parse(query('locations', '  client complaint '))).toEqual({
      ...range,
      reason: 'client complaint',
    });
    expect(query('locations')).not.toHaveProperty('reason');
    expect(query('attendance', 'a reason')).not.toHaveProperty('reason');
    expect(siteActivityQuerySchema.parse(query('site-activity'))).toEqual({
      from: '2026-10-27',
      to: TODAY,
      siteId: SITE,
    });
    expect(query('patrols')).not.toHaveProperty('drills');
  });

  it('exports the report on screen with the same filters, as the contract allows', () => {
    const range = { from: '2026-10-27', to: TODAY, siteId: SITE, guardId: GUARD };
    const requests = REPORT_TABS.map((t) => exportRequest(filters(t.id), ' viewed for the client '));
    for (const request of requests) expect(exportRequestSchema.parse(request)).toEqual(request);
    expect(requests).toEqual([
      { kind: 'ATTENDANCE', ...range },
      { kind: 'PATROLS', ...range },
      { kind: 'INCIDENTS', ...range, drills: 'include' },
      { kind: 'LOCATION_REPORT', ...range, reason: 'viewed for the client' },
      { kind: 'SITE_ACTIVITY', from: '2026-10-27', to: TODAY, siteId: SITE },
    ]);
    // Every site, every guard, no reason: nothing extra is sent.
    const plain = exportRequest({ ...filters('locations'), siteId: '', guardId: '' });
    expect(plain).toEqual({ kind: 'LOCATION_REPORT', from: '2026-10-27', to: TODAY });
    expect(exportRequestSchema.parse(plain)).toEqual(plain);
    expect(exportRequest({ ...filters('incidents'), drills: 'exclude' })).toMatchObject({
      drills: 'exclude',
    });
  });

  it("asks for a guard's own data with the reason when one is given (SEC §16.6)", () => {
    expect(guardDataExport(GUARD, '  their request ')).toEqual({
      kind: 'GUARD_DATA',
      guardId: GUARD,
      reason: 'their request',
    });
    expect(guardDataExport(GUARD, ' ')).toEqual({ kind: 'GUARD_DATA', guardId: GUARD });
    expect(exportRequestSchema.parse(guardDataExport(GUARD, 'x'))).toEqual(guardDataExport(GUARD, 'x'));
  });

  it("exports the viewer's shift, or the whole local days of its time range, with the viewing reason", () => {
    const shift = historyExport(GUARD, { shiftId: id(20) }, ' night shift ', 'Asia/Karachi');
    expect(shift).toEqual({
      request: { kind: 'LOCATION_HISTORY', guardId: GUARD, shiftId: id(20), reason: 'night shift' },
      days: null,
    });
    // 22:00 to 02:00 in Karachi: two local days, whatever the browser's own zone.
    const night = historyExport(
      GUARD,
      { fromMs: Date.parse('2026-11-01T17:00:00Z'), toMs: Date.parse('2026-11-01T21:00:00Z') },
      '',
      'Asia/Karachi',
    );
    expect(night).toEqual({
      request: { kind: 'LOCATION_HISTORY', guardId: GUARD, from: '2026-11-01', to: '2026-11-02' },
      days: { from: '2026-11-01', to: '2026-11-02' },
    });
    // A range ending at local midnight doesn't reach the next day.
    const evening = historyExport(
      GUARD,
      { fromMs: Date.parse('2026-11-01T13:00:00Z'), toMs: Date.parse('2026-11-01T19:00:00Z') },
      '',
      'Asia/Karachi',
    );
    expect('request' in evening && evening.request).toMatchObject({ from: '2026-11-01', to: '2026-11-01' });
    for (const built of [shift, night, evening]) {
      if ('request' in built) expect(exportRequestSchema.parse(built.request)).toEqual(built.request);
    }
    expect(historyExport(GUARD, { shiftId: '' }, '', 'Asia/Karachi')).toEqual({ problem: 'Choose a shift.' });
    const backwards = {
      fromMs: Date.parse('2026-11-02T00:00:00Z'),
      toMs: Date.parse('2026-11-01T00:00:00Z'),
    };
    expect(historyExport(GUARD, backwards, '', 'Asia/Karachi')).toHaveProperty('problem');
    expect(historyExport(GUARD, { fromMs: Number.NaN, toMs: 0 }, '', 'Asia/Karachi')).toHaveProperty(
      'problem',
    );
    const tooLong = { fromMs: Date.parse('2026-08-01T00:00:00Z'), toMs: Date.parse('2026-11-02T00:00:00Z') };
    expect(historyExport(GUARD, tooLong, '', 'Asia/Karachi')).toEqual({
      problem: 'An export covers at most 92 days.',
    });
  });

  it('keeps the limits the contracts set', () => {
    expect(REPORT_MAX_DAYS).toBe(CONTRACT_MAX_DAYS);
    expect(REASON_MAX).toBe(historyReasonSchema.maxLength);
    expect(EXPORT_FILE_DAYS).toBe(CONTRACT_FILE_DAYS);
    expect(EXPORT_LINK_MINUTES * 60).toBe(EXPORT_LINK_TTL_S);
  });
});

describe('reports in words and numbers', () => {
  it('reads durations as hours and minutes', () => {
    expect(formatSeconds(7500)).toBe('2 h 05 min');
    expect(formatSeconds(3600)).toBe('1 h 00 min');
    expect(formatSeconds(3599)).toBe('59 min');
    expect(formatSeconds(60)).toBe('1 min');
    expect(formatSeconds(45)).toBe('45 s');
    expect(formatSeconds(0)).toBe('0 min');
    expect(formatSeconds(90_000)).toBe('25 h 00 min');
    expect(formatSeconds(null)).toBe('—');
    expect(formatSeconds(Number.NaN)).toBe('—');
    expect(formatMinutes(125)).toBe('2 h 05 min');
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(null)).toBe('—');
  });

  it('reads completion, distance and dates', () => {
    expect(formatPct(83)).toBe('83%');
    expect(formatPct(null)).toBe('—');
    expect(formatKm(12_345)).toBe('12.3 km');
    expect(formatKm(0)).toBe('0.0 km');
    expect(formatKm(1_234_567)).toBe('1,234.6 km');
    expect(dayLabel(TODAY)).toBe('Mon, 02 Nov 2026');
    expect(periodText('2026-10-27', TODAY)).toBe('27 Oct 2026 to 02 Nov 2026');
    expect(periodText(TODAY, TODAY)).toBe('02 Nov 2026');
  });

  it("shows times in the report's own time zone, with both dates when a span runs past midnight", () => {
    expect(spanText('2026-11-02T16:00:00Z', '2026-11-02T18:00:00Z', 'Asia/Karachi')).toBe(
      '02 Nov 2026, 21:00–23:00',
    );
    expect(spanText('2026-11-02T16:00:00Z', '2026-11-03T02:00:00Z', 'Asia/Karachi')).toBe(
      '02 Nov 2026, 21:00 – 03 Nov 2026, 07:00',
    );
    expect(spanText('2026-11-02T16:00:00Z', '2026-11-02T18:00:00Z', 'Europe/London')).toBe(
      '02 Nov 2026, 16:00–18:00',
    );
  });

  it('says every flag in words, and a flag it does not know yet still reads as words', () => {
    expect(attendanceFlagsText(['OFFLINE_START', 'FORCE_ENDED', 'SOMETHING_NEW'])).toBe(
      'offline start · force-ended · something new',
    );
    expect(patrolFlagsText(['OUT_OF_ORDER', 'SENT_LATE', 'SUSPICIOUS'])).toBe(
      'out of order · sent late · suspicious (impossible travel or fake GPS)',
    );
  });

  it("counts a shift's excursions and names the longest; each one says when, how long, and whether it came late", () => {
    const out = (from: string, to: string | null, seconds: number, detectedLate = false) => ({
      from,
      to,
      seconds,
      detectedLate,
    });
    expect(excursionsText([])).toBe('None');
    const excursions = [
      out('2026-11-02T16:00:00Z', '2026-11-02T16:02:00Z', 120),
      out('2026-11-02T17:00:00Z', '2026-11-02T17:12:00Z', 720, true),
    ];
    expect(excursionsText(excursions)).toBe('2 · longest 12 min');
    expect(excursionText(excursions[1]!, 'Asia/Karachi')).toBe('22:00–22:12 · 12 min · detected late');
    expect(excursionText(out('2026-11-02T18:00:00Z', null, 300), 'Asia/Karachi')).toBe(
      'from 23:00, no return recorded · 5 min',
    );
  });

  it('sums a report up in three numbers, exceptions marked', () => {
    const row = (overrides: Partial<LocationReportRow>): LocationReportRow => ({
      shiftId: id(30),
      guard: { id: GUARD, displayName: 'Ahmed Khan', employeeNumber: 'E-1' },
      site: { id: SITE, name: 'ABC Warehouse' },
      scheduledStart: '2026-11-02T16:00:00Z',
      scheduledEnd: '2026-11-03T02:00:00Z',
      firstFixAt: null,
      lastFixAt: null,
      insideSeconds: 0,
      outsideSeconds: 0,
      unknownSeconds: 0,
      excursions: [],
      longestGapSeconds: 0,
      distanceM: 0,
      points: 0,
      trackDeleted: false,
      ...overrides,
    });
    const shown = (rows: LocationReportRow[]) =>
      reportStats({
        tab: 'locations',
        key: '',
        filters: readFilters(params(''), TODAY, ALL_TABS),
        reason: '',
        report: { timezone: 'Asia/Karachi', from: '2026-10-27', to: TODAY, rows, truncated: false },
      });
    expect(shown([row({}), row({ shiftId: id(31) })])).toEqual([
      { label: 'shifts', value: '2', tone: '' },
      { label: 'excursions', value: '0', tone: '' },
      { label: 'time outside', value: '0 min', tone: '' },
    ]);
    const away = row({
      outsideSeconds: 1500,
      excursions: [
        { from: '2026-11-02T17:00:00Z', to: '2026-11-02T17:25:00Z', seconds: 1500, detectedLate: false },
      ],
    });
    expect(shown([away])).toEqual([
      { label: 'shifts', value: '1', tone: '' },
      { label: 'excursions', value: '1', tone: 'warn' },
      { label: 'time outside', value: '25 min', tone: 'warn' },
    ]);
  });
});

describe('exports in words', () => {
  it('names every kind and status the contract has', () => {
    expect(Object.keys(EXPORT_KIND_LABEL).sort()).toEqual([...EXPORT_KINDS].sort());
    expect(EXPORT_STATUSES.map((s) => EXPORT_STATUS_LABEL[s])).toEqual([
      'Queued',
      'Running',
      'Ready',
      'Failed',
      'Expired',
    ]);
    expect(isPending(job({ status: 'QUEUED' }))).toBe(true);
    expect(isPending(job({ status: 'RUNNING' }))).toBe(true);
    expect(isPending(job({ status: 'READY' }))).toBe(false);
  });

  it('reads sizes and row counts, and says why one failed', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
    expect(formatBytes(null)).toBe('—');
    expect(statusDetail(job({ status: 'READY', rowCount: 1234, sizeBytes: 2048 }))).toBe(
      '1,234 rows · 2.0 KB',
    );
    expect(statusDetail(job({ status: 'EXPIRED', rowCount: 1, sizeBytes: 100 }))).toBe('1 row · 100 B');
    expect(statusDetail(job({ status: 'QUEUED' }))).toBe('Waiting to start');
    expect(statusDetail(job({ status: 'RUNNING' }))).toBe('Being prepared');
    expect(statusDetail(job({ status: 'FAILED', errorCode: 'EXPORT_RANGE_TOO_LARGE' }))).toBe(
      'The range is longer than 92 days',
    );
    expect(statusDetail(job({ status: 'FAILED', errorCode: 'SOMETHING_NEW' }))).toBe('Something new');
    expect(statusDetail(job({ status: 'FAILED' }))).toBe('No reason given');
  });

  it('says when one of my own exports has just become ready, and nothing about anyone else’s', () => {
    const mine = [USER, MEMBER];
    const running = job({ status: 'RUNNING' });
    const ready = job({ status: 'READY', rowCount: 3, sizeBytes: 300 });
    // The first list only shows what was there already.
    expect(newlyReady(null, [ready], mine)).toEqual([]);
    expect(newlyReady([running], [ready], mine)).toEqual([ready]);
    expect(newlyReady([ready], [ready], mine)).toEqual([]);
    // New since the last list and ready already (a quick export).
    expect(newlyReady([], [ready], mine)).toEqual([ready]);
    // Someone else's export.
    const theirs = job({ status: 'READY', requestedBy: { id: id(40), name: 'Bilal' } });
    expect(newlyReady([{ ...theirs, status: 'RUNNING' }], [theirs], mine)).toEqual([]);
    // Named by the membership rather than the user: still mine.
    const byMember = job({ id: id(11), status: 'READY', requestedBy: { id: MEMBER, name: 'Sarah K.' } });
    expect(newlyReady([{ ...byMember, status: 'QUEUED' }], [byMember], mine)).toEqual([byMember]);
    expect(newlyReady([running], [{ ...running, status: 'FAILED' }], mine)).toEqual([]);
    expect(readyMessage([ready])).toBe(
      'Your export is ready: Attendance · 2026-10-27 to 2026-11-02 · Main gate',
    );
    expect(readyMessage([ready, byMember])).toBe('2 of your exports are ready');
  });

  it('follows only a web link to download', () => {
    expect(isWebLink('https://objects.example/exports/x.csv?X-Amz-Signature=abc')).toBe(true);
    expect(isWebLink('http://127.0.0.1:3000/api/v1/exports/x/file?sig=abc')).toBe(true);
    expect(isWebLink('javascript:alert(1)')).toBe(false);
    expect(isWebLink('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isWebLink('//evil.example/x')).toBe(false);
  });

  it('says why an export or a download was refused, in plain words', () => {
    const refused = (code: ConstructorParameters<typeof ApiError>[0], status: number, message = 'refused') =>
      describeExportError(new ApiError(code, message, status));
    expect(refused('EXPORT_ALREADY_RUNNING', 409)).toEqual({
      code: 'EXPORT_ALREADY_RUNNING',
      text: 'You already have an export running. Wait for it to finish, then try again.',
      reasonRequired: false,
    });
    expect(refused('EXPORT_RANGE_TOO_LARGE', 422).text).toBe(
      'An export covers at most 92 days. Narrow the range.',
    );
    expect(refused('EXPORT_EXPIRED', 410).text).toBe(
      'This file was deleted 7 days after it was ready. Export it again.',
    );
    expect(refused('EXPORT_NOT_READY', 409).text).toContain('still being prepared');
    expect(refused('FORBIDDEN', 403, 'You do not have permission.').text).toBe('You do not have permission.');
    // D-21: the organization requires a reason. The server's words, without the field's code.
    const reason = describeExportError(
      new ApiError(
        'VALIDATION_FAILED',
        'Your organization asks for a reason to view location history.',
        400,
        [{ path: 'reason', issue: 'required' }],
      ),
    );
    expect(reason).toEqual({
      code: 'VALIDATION_FAILED',
      text: 'Your organization asks for a reason to view location history.',
      reasonRequired: true,
    });
    expect(describeExportError(new Error('boom'))).toEqual({
      code: 'INTERNAL_ERROR',
      text: 'Something went wrong.',
      reasonRequired: false,
    });
  });
});
