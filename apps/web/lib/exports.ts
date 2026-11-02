// Exports in words (PROD §15.2, SEC §16.4, §16.6): kinds and statuses, who may ask for which kind,
// sizes, why one failed, and which of the person's own exports have just become ready. Every export
// runs in the background, one at a time per person; the file is kept 7 days and a download link
// lasts 15 minutes. The limits are the contracts' (packages/contracts/src/exports.ts): the server
// enforces them, and zod stays out of the browser bundle.
import type { ExportJob, ExportKind, ExportRequest, ExportStatus, Permission } from '@sentryops/contracts';
import { localDate } from '@sentryops/domain';

import { ApiError, errorText } from './api';
import { dayCount, formatCount, isReasonRequired, REPORT_MAX_DAYS, type Can } from './reports';

/** EXPORT_FILE_DAYS: a file is deleted 7 days after it is ready. */
export const EXPORT_FILE_DAYS = 7;
/** EXPORT_LINK_TTL_S: a download link works for 15 minutes. */
export const EXPORT_LINK_MINUTES = 15;

export const EXPORT_KIND_LABEL: Record<ExportKind, string> = {
  ATTENDANCE: 'Attendance',
  PATROLS: 'Patrols',
  INCIDENTS: 'Incidents',
  SITE_ACTIVITY: 'Site activity',
  LOCATION_REPORT: 'Location report',
  LOCATION_HISTORY: 'Location history',
  GUARD_DATA: 'Guard’s data',
};

export const EXPORT_STATUS_LABEL: Record<ExportStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  READY: 'Ready',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
};

export const EXPORT_STATUS_BADGE: Record<ExportStatus, string> = {
  QUEUED: 'info',
  RUNNING: 'info',
  READY: 'ok',
  FAILED: 'danger',
  EXPIRED: 'plain',
};

/**
 * Who may ask for each kind. The server checks the same; the dashboard only hides what it would
 * refuse (INV-12). Location needs location-history access (SEC §16.4); a guard's data stays with
 * Owners and Administrators (SEC §16.6).
 */
export const EXPORT_PERMISSIONS: Record<ExportKind, readonly Permission[]> = {
  ATTENDANCE: ['exports.create'],
  PATROLS: ['exports.create'],
  INCIDENTS: ['exports.create'],
  SITE_ACTIVITY: ['exports.create'],
  LOCATION_REPORT: ['exports.create', 'location.history.read'],
  LOCATION_HISTORY: ['exports.create', 'location.history.read'],
  GUARD_DATA: ['exports.guard_data'],
};

export function canExport(kind: ExportKind, can: Can): boolean {
  return EXPORT_PERMISSIONS[kind].every((p) => can(p));
}

/** The Exports page and its place in the menu: anyone who may export something. */
export const EXPORTS_PAGE_PERMISSIONS: readonly Permission[] = ['exports.create', 'exports.guard_data'];

export function mayOpenExports(can: Can): boolean {
  return EXPORTS_PAGE_PERMISSIONS.some((p) => can(p));
}

/** Still being prepared: the page looks again now and then, in case the live stream is down. */
export function isPending(job: Pick<ExportJob, 'status'>): boolean {
  return job.status === 'QUEUED' || job.status === 'RUNNING';
}

/**
 * The person's own exports that became ready since the previous list: queued or running then, or new
 * since. Nothing on the first list, which only shows what was there before the page looked.
 * `mine` holds the signed-in person's IDs.
 */
export function newlyReady(
  previous: readonly ExportJob[] | null,
  next: readonly ExportJob[],
  mine: readonly string[],
): ExportJob[] {
  if (previous === null) return [];
  const before = new Map(previous.map((j) => [j.id, j.status]));
  return next.filter(
    (j) => j.status === 'READY' && mine.includes(j.requestedBy.id) && before.get(j.id) !== 'READY',
  );
}

export function readyMessage(jobs: readonly ExportJob[]): string {
  const [only] = jobs;
  return jobs.length === 1 && only
    ? `Your export is ready: ${only.title}`
    : `${jobs.length} of your exports are ready`;
}

/** "512 B", "1.5 KB", "12 MB". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit]}`;
}

/** Why an export failed: the error code the job kept, in words. */
const FAILURE_LABEL: Record<string, string> = {
  EXPORT_RANGE_TOO_LARGE: `The range is longer than ${REPORT_MAX_DAYS} days`,
  FORBIDDEN: 'The person who asked for it may no longer export it',
  NOT_FOUND: 'What it was about no longer exists',
  NOT_READY: 'A service it needs was unavailable',
  INTERNAL_ERROR: 'Something went wrong while preparing the file',
};

export function failureText(code: string | null): string {
  if (!code) return 'No reason given';
  const words = code.toLowerCase().replaceAll('_', ' ');
  return FAILURE_LABEL[code] ?? `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** What follows the status: how big a file is, why one failed, what one still being prepared waits for. */
export function statusDetail(job: ExportJob): string {
  switch (job.status) {
    case 'QUEUED':
      return 'Waiting to start';
    case 'RUNNING':
      return 'Being prepared';
    case 'FAILED':
      return failureText(job.errorCode);
    case 'READY':
    case 'EXPIRED':
      return [
        job.rowCount === null ? '' : `${formatCount(job.rowCount)} row${job.rowCount === 1 ? '' : 's'}`,
        job.sizeBytes === null ? '' : formatBytes(job.sizeBytes),
      ]
        .filter(Boolean)
        .join(' · ');
  }
}

/** A signed link from the API is a web address; anything else is never navigated to. */
export function isWebLink(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export type ExportFailure = {
  readonly code: string;
  readonly text: string;
  /** The organization requires a reason (D-21): the form marks its reason field. */
  readonly reasonRequired: boolean;
};

/** A refused export or download, in plain words. */
export function describeExportError(error: unknown): ExportFailure {
  if (!(error instanceof ApiError))
    return { code: 'INTERNAL_ERROR', text: errorText(error), reasonRequired: false };
  if (isReasonRequired(error)) return { code: error.code, text: error.message, reasonRequired: true };
  const says = (text: string) => ({ code: error.code, text, reasonRequired: false });
  switch (error.code) {
    case 'EXPORT_ALREADY_RUNNING':
      return says('You already have an export running. Wait for it to finish, then try again.');
    case 'EXPORT_RANGE_TOO_LARGE':
      return says(`An export covers at most ${REPORT_MAX_DAYS} days. Narrow the range.`);
    case 'EXPORT_NOT_READY':
      return says('This export can’t be downloaded: it is still being prepared, or it failed.');
    case 'EXPORT_EXPIRED':
      return says(`This file was deleted ${EXPORT_FILE_DAYS} days after it was ready. Export it again.`);
    default:
      return says(errorText(error));
  }
}

/** A guard's own data (SEC §16.6): profile, shifts, location and the incidents they reported. */
export function guardDataExport(guardId: string, reason: string): ExportRequest {
  const why = reason.trim();
  return { kind: 'GUARD_DATA', guardId, ...(why ? { reason: why } : {}) };
}

export type HistoryScope = { readonly shiftId: string } | { readonly fromMs: number; readonly toMs: number };

export type HistoryExport =
  | {
      readonly request: ExportRequest;
      /** For a time range: the whole local days the export covers. */
      readonly days: { readonly from: string; readonly to: string } | null;
    }
  | { readonly problem: string };

/**
 * The location history viewer's export (SEC §16.4): the shift on screen, or, for a time range, every
 * shift on the local dates it touches in `timeZone`. The export takes whole days, so a range of a
 * few hours exports the days around it. The reason is the one given for viewing (D-21).
 */
export function historyExport(
  guardId: string,
  scope: HistoryScope,
  reason: string,
  timeZone: string,
): HistoryExport {
  const why = reason.trim();
  const extra = why ? { reason: why } : {};
  if ('shiftId' in scope) {
    if (!scope.shiftId) return { problem: 'Choose a shift.' };
    return { request: { kind: 'LOCATION_HISTORY', guardId, shiftId: scope.shiftId, ...extra }, days: null };
  }
  const { fromMs, toMs } = scope;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return { problem: 'Choose a time range that ends after it starts.' };
  }
  const from = localDate(new Date(fromMs), timeZone);
  // The end itself is not part of the range: one ending at midnight doesn't reach the next day.
  const to = localDate(new Date(toMs - 1), timeZone);
  if (dayCount(from, to) > REPORT_MAX_DAYS) {
    return { problem: `An export covers at most ${REPORT_MAX_DAYS} days.` };
  }
  return { request: { kind: 'LOCATION_HISTORY', guardId, from, to, ...extra }, days: { from, to } };
}
