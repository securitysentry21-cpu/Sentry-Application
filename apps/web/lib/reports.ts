// Reports in words and numbers (PROD §15.1): which reports a role sees, their filters as they live in
// the address, the query and the export each one asks for, and how durations, percentages and
// distances read. Dates are inclusive local dates: the site's time zone for one site, the
// organization's otherwise (ADV-TM02); the server says which one each report used. The limits are
// the contracts' (packages/contracts/src/reports.ts, exports.ts): the server enforces them; the forms
// only say so early, and zod stays out of the browser bundle.
import type {
  AttendanceRow,
  ExportKind,
  ExportRequest,
  IncidentReportRow,
  LocationReportRow,
  PatrolReportRow,
  Permission,
  ShiftStatus,
  SiteActivityRow,
} from '@sentryops/contracts';
import { addDays, localDate } from '@sentryops/domain';

import { ApiError } from './api';
import { formatDateTime, siteTime } from './format';

/** REPORT_MAX_DAYS: at most 92 days per report or export (PROD §15.2). */
export const REPORT_MAX_DAYS = 92;
/** historyReasonSchema: the reason for reading location history (D-21). */
export const REASON_MAX = 500;
/** The default range: the last 7 local days, today included. */
export const DEFAULT_DAYS = 7;

export type Can = (permission: Permission) => boolean;

export type ReportTab = 'attendance' | 'patrols' | 'incidents' | 'locations' | 'site-activity';

/** What each report's rows are. */
export type RowsByTab = {
  attendance: AttendanceRow;
  patrols: PatrolReportRow;
  incidents: IncidentReportRow;
  locations: LocationReportRow;
  'site-activity': SiteActivityRow;
};

/** Every report's response: the time zone its dates and times are in, and whether it was cut short. */
export type Report<T> = { timezone: string; from: string; to: string; rows: T[]; truncated: boolean };

export type TabDef = {
  readonly id: ReportTab;
  readonly label: string;
  /** Under /reports in the API. */
  readonly path: string;
  readonly kind: ExportKind;
  readonly description: string;
  readonly empty: string;
  /** One guard's rows make sense; site activity is per site. */
  readonly guardFilter: boolean;
  /**
   * Reads location history (SEC §16.4): audited, with the reason (D-21), so it loads only when the
   * user asks, never by opening the tab or the address.
   */
  readonly audited: boolean;
  /** Needed on top of reports.read. */
  readonly needs: readonly Permission[];
};

export const REPORT_TABS: readonly TabDef[] = [
  {
    id: 'attendance',
    label: 'Attendance',
    path: 'attendance',
    kind: 'ATTENDANCE',
    description: 'Scheduled against actual, per shift: late starts, early leaves and time worked.',
    empty: 'No shifts in this period.',
    guardFilter: true,
    audited: false,
    needs: [],
  },
  {
    id: 'patrols',
    label: 'Patrols',
    path: 'patrols',
    kind: 'PATROLS',
    description:
      'Each round of each shift: checkpoints required, verified, QR only and missed. Completion is what counted against what was required.',
    empty: 'No patrol rounds in this period.',
    guardFilter: true,
    audited: false,
    needs: [],
  },
  {
    id: 'incidents',
    label: 'Incidents',
    path: 'incidents',
    kind: 'INCIDENTS',
    description:
      'Every incident reported, with how long it took to acknowledge and to resolve. Drills are left out unless you include them.',
    empty: 'No incidents in this period.',
    guardFilter: true,
    audited: false,
    needs: [],
  },
  {
    id: 'locations',
    label: 'Location',
    path: 'locations',
    kind: 'LOCATION_REPORT',
    description:
      'Per shift: time inside and outside the site, excursions, the longest gap and the distance travelled, worked out from the track. It shows no coordinates. Viewing it is recorded in the audit log, with your name and your reason.',
    empty: 'No shifts in this period.',
    guardFilter: true,
    audited: true,
    needs: ['location.history.read'],
  },
  {
    id: 'site-activity',
    label: 'Site activity',
    path: 'site-activity',
    kind: 'SITE_ACTIVITY',
    description:
      'Proof of service, per site and day: shifts covered against scheduled, late starts, time worked, patrol completion and incidents.',
    empty: 'No site activity in this period.',
    guardFilter: false,
    audited: false,
    needs: [],
  },
];

export function tabDef(id: ReportTab): TabDef {
  return REPORT_TABS.find((t) => t.id === id) ?? REPORT_TABS[0]!;
}

/** The reports a role sees: none without reports.read; location only with location-history access. */
export function visibleTabs(can: Can): ReportTab[] {
  if (!can('reports.read')) return [];
  return REPORT_TABS.filter((t) => t.needs.every((p) => can(p))).map((t) => t.id);
}

// ── Filters, kept in the address ─────────────────────────────────────────────────────────────

export type ReportFilters = {
  readonly tab: ReportTab;
  readonly from: string;
  readonly to: string;
  /** '' for every site. */
  readonly siteId: string;
  /** '' for every guard. */
  readonly guardId: string;
  readonly drills: 'exclude' | 'include';
};

export type ParamReader = { get(name: string): string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A real calendar date: "2026-02-30" would otherwise roll into March (the contract's rule). */
export function isLocalDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Days from `from` to `to`, both included. */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Null when the range is fine; otherwise what to say (the server refuses the same). */
export function rangeProblem(from: string, to: string): string | null {
  if (!isLocalDate(from) || !isLocalDate(to)) return 'Enter both dates.';
  if (from > to) return 'The start date must be on or before the end date.';
  if (dayCount(from, to) > REPORT_MAX_DAYS) return `Choose at most ${REPORT_MAX_DAYS} days.`;
  return null;
}

export function defaultRange(today: string): { from: string; to: string } {
  return { from: addDays(today, -(DEFAULT_DAYS - 1)), to: today };
}

/** The filters in the address; anything missing, unknown or out of range falls back to the default. */
export function readFilters(params: ParamReader, today: string, tabs: readonly ReportTab[]): ReportFilters {
  const wanted = params.get('tab');
  const tab = tabs.find((t) => t === wanted) ?? tabs[0] ?? 'attendance';
  const from = params.get('from');
  const to = params.get('to');
  const range =
    isLocalDate(from) && isLocalDate(to) && rangeProblem(from, to) === null
      ? { from, to }
      : defaultRange(today);
  const id = (name: string) => {
    const value = params.get(name);
    return value !== null && UUID.test(value) ? value : '';
  };
  return {
    tab,
    ...range,
    siteId: id('siteId'),
    guardId: id('guardId'),
    drills: params.get('drills') === 'include' ? 'include' : 'exclude',
  };
}

/** What a report depends on: the same key, the same rows. */
export function filtersKey(f: ReportFilters): string {
  const tab = tabDef(f.tab);
  return [
    f.tab,
    f.from,
    f.to,
    f.siteId,
    tab.guardFilter ? f.guardId : '',
    f.tab === 'incidents' ? f.drills : '',
  ].join('|');
}

/** The address for these filters. Defaults stay out of it, so a saved link keeps meaning "the last 7 days". */
export function filtersHref(pathname: string, f: ReportFilters, today: string): string {
  const params = new URLSearchParams();
  if (f.tab !== 'attendance') params.set('tab', f.tab);
  const d = defaultRange(today);
  if (f.from !== d.from || f.to !== d.to) {
    params.set('from', f.from);
    params.set('to', f.to);
  }
  if (f.siteId) params.set('siteId', f.siteId);
  // Kept for the other tabs even where this one has no guard filter.
  if (f.guardId) params.set('guardId', f.guardId);
  if (f.drills === 'include') params.set('drills', 'include');
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** GET /reports/<path>?… for these filters. The reason only for the location report, never in the address. */
export function reportQuery(f: ReportFilters, reason = ''): string {
  const tab = tabDef(f.tab);
  const params = new URLSearchParams({ from: f.from, to: f.to });
  if (f.siteId) params.set('siteId', f.siteId);
  if (tab.guardFilter && f.guardId) params.set('guardId', f.guardId);
  if (f.tab === 'incidents') params.set('drills', f.drills);
  if (tab.audited && reason.trim()) params.set('reason', reason.trim());
  return params.toString();
}

/** POST /exports for the report on screen: the same filters, and the reason it was viewed with. */
export function exportRequest(f: ReportFilters, reason = ''): ExportRequest {
  const tab = tabDef(f.tab);
  const range = {
    from: f.from,
    to: f.to,
    ...(f.siteId ? { siteId: f.siteId } : {}),
    ...(tab.guardFilter && f.guardId ? { guardId: f.guardId } : {}),
  };
  const why = reason.trim();
  switch (f.tab) {
    case 'attendance':
      return { kind: 'ATTENDANCE', ...range };
    case 'patrols':
      return { kind: 'PATROLS', ...range };
    case 'incidents':
      return { kind: 'INCIDENTS', ...range, drills: f.drills };
    case 'locations':
      return { kind: 'LOCATION_REPORT', ...range, ...(why ? { reason: why } : {}) };
    case 'site-activity':
      return { kind: 'SITE_ACTIVITY', ...range };
  }
}

/** The server asked for the reason the organization requires (D-21). */
export function isReasonRequired(error: unknown): boolean {
  return error instanceof ApiError && error.details.some((d) => d.path === 'reason');
}

// ── Words and numbers ─────────────────────────────────────────────────────────────────────────

/** "2 h 05 min", "45 min", "30 s", "0 min"; "—" when there is nothing to say. */
export function formatSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  if (total === 0) return '0 min';
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export function formatMinutes(minutes: number | null): string {
  return minutes === null ? '—' : formatSeconds(minutes * 60);
}

/** Completion: null when nothing was required. */
export function formatPct(pct: number | null): string {
  return pct === null ? '—' : `${pct}%`;
}

export function formatKm(metres: number): string {
  const km = Math.max(0, metres) / 1000;
  return `${km.toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-GB');
}

/** "02 Nov 2026, 21:00–23:00", or both dates when it runs past midnight. */
export function spanText(startIso: string, endIso: string, timeZone: string): string {
  const sameDay = localDate(new Date(startIso), timeZone) === localDate(new Date(endIso), timeZone);
  return sameDay
    ? `${formatDateTime(startIso, timeZone)}–${siteTime(endIso, timeZone, false)}`
    : `${formatDateTime(startIso, timeZone)} – ${formatDateTime(endIso, timeZone)}`;
}

/** A local date as words, read as a calendar date (no time zone moves it): "Mon, 02 Nov 2026". */
export function dayLabel(date: string, weekday = true): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    ...(weekday ? { weekday: 'short' as const } : {}),
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

/** "27 Oct 2026 to 02 Nov 2026", or one day. */
export function periodText(from: string, to: string): string {
  return from === to ? dayLabel(from, false) : `${dayLabel(from, false)} to ${dayLabel(to, false)}`;
}

/** A code the dashboard has no words for yet, still readable. */
const plainWords = (code: string) => code.toLowerCase().replaceAll('_', ' ');

export const SHIFT_STATUS_LABEL: Record<ShiftStatus, string> = {
  SCHEDULED: 'Scheduled',
  ACTIVE: 'On duty',
  COMPLETED: 'Completed',
  MISSED: 'Missed',
  CANCELLED: 'Cancelled',
};

export const SHIFT_STATUS_BADGE: Record<ShiftStatus, string> = {
  SCHEDULED: 'info',
  ACTIVE: 'ok',
  COMPLETED: 'plain',
  MISSED: 'danger',
  CANCELLED: 'plain',
};

const ATTENDANCE_FLAG_LABEL: Record<string, string> = {
  OFFLINE_START: 'offline start',
  MANUAL_START: 'manual start',
  AUTO_ENDED: 'auto-ended',
  FORCE_ENDED: 'force-ended',
  OFF_SITE_START: 'off-site start',
  LOW_ACCURACY_START: 'low-accuracy start',
};

export function attendanceFlagsText(flags: readonly string[]): string {
  return flags.map((f) => ATTENDANCE_FLAG_LABEL[f] ?? plainWords(f)).join(' · ');
}

const PATROL_FLAG_LABEL: Record<string, string> = {
  OUT_OF_ORDER: 'out of order',
  SENT_LATE: 'sent late',
  SUSPICIOUS: 'suspicious (impossible travel or fake GPS)',
};

export function patrolFlagsText(flags: readonly string[]): string {
  return flags.map((f) => PATROL_FLAG_LABEL[f] ?? plainWords(f)).join(' · ');
}

type Excursion = LocationReportRow['excursions'][number];

/** "None", or how many and the longest: "3 · longest 12 min". */
export function excursionsText(excursions: readonly Excursion[]): string {
  if (excursions.length === 0) return 'None';
  const longest = Math.max(...excursions.map((e) => e.seconds));
  return `${excursions.length} · longest ${formatSeconds(longest)}`;
}

/** One excursion: "21:14–21:32 · 18 min", with "detected late" when its fixes arrived after the fact. */
export function excursionText(e: Excursion, timeZone: string): string {
  const when = e.to
    ? `${siteTime(e.from, timeZone, false)}–${siteTime(e.to, timeZone, false)}`
    : `from ${siteTime(e.from, timeZone, false)}, no return recorded`;
  return `${when} · ${formatSeconds(e.seconds)}${e.detectedLate ? ' · detected late' : ''}`;
}

// ── Summaries above the table ─────────────────────────────────────────────────────────────────

export type Stat = { readonly label: string; readonly value: string; readonly tone: '' | 'warn' | 'danger' };

/** A report as the page shows it: the rows, and the filters and reason they were asked with. */
export type ShownReport = {
  [T in ReportTab]: {
    readonly tab: T;
    readonly key: string;
    readonly filters: ReportFilters;
    readonly reason: string;
    readonly report: Report<RowsByTab[T]>;
  };
}[ReportTab];

const stat = (label: string, n: number, tone: 'warn' | 'danger' | '' = ''): Stat => ({
  label,
  value: formatCount(n),
  tone: n > 0 ? tone : '',
});
const sum = <T>(rows: readonly T[], pick: (row: T) => number) =>
  rows.reduce((total, r) => total + pick(r), 0);

/** Three numbers that sum the period up, exceptions marked by a border and a word (PROD §14.7). */
export function reportStats(shown: ShownReport): Stat[] {
  switch (shown.tab) {
    case 'attendance': {
      const rows = shown.report.rows;
      return [
        stat('shifts', rows.length),
        stat('started late', rows.filter((r) => (r.lateMinutes ?? 0) > 0).length, 'warn'),
        stat('missed', rows.filter((r) => r.status === 'MISSED').length, 'danger'),
      ];
    }
    case 'patrols': {
      const rows = shown.report.rows;
      return [
        stat('rounds', rows.length),
        stat('rounds missed', rows.filter((r) => r.status === 'MISSED').length, 'danger'),
        stat(
          'checkpoints missed',
          sum(rows, (r) => r.missed),
          'warn',
        ),
      ];
    }
    case 'incidents': {
      const rows = shown.report.rows;
      return [
        stat('incidents', rows.length),
        stat(
          'high or critical',
          rows.filter((r) => r.severity === 'HIGH' || r.severity === 'CRITICAL').length,
        ),
        stat('not resolved', rows.filter((r) => r.status !== 'RESOLVED').length, 'warn'),
      ];
    }
    case 'locations': {
      const rows = shown.report.rows;
      const outside = sum(rows, (r) => r.outsideSeconds);
      return [
        stat('shifts', rows.length),
        stat(
          'excursions',
          sum(rows, (r) => r.excursions.length),
          'warn',
        ),
        { label: 'time outside', value: formatSeconds(outside), tone: outside > 0 ? 'warn' : '' },
      ];
    }
    case 'site-activity': {
      const rows = shown.report.rows;
      const scheduled = sum(rows, (r) => r.shiftsScheduled);
      const covered = sum(rows, (r) => r.shiftsCovered);
      return [
        {
          label: 'shifts covered',
          value: `${formatCount(covered)} of ${formatCount(scheduled)}`,
          tone: sum(rows, (r) => r.shiftsMissed) > 0 ? 'danger' : '',
        },
        stat(
          'late starts',
          sum(rows, (r) => r.lateStarts),
          'warn',
        ),
        stat(
          'incidents',
          sum(rows, (r) => r.incidents),
        ),
      ];
    }
  }
}
