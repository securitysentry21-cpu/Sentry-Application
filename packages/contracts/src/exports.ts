// Exports (PROD §15.2, SEC §16.4, §16.6) — dashboard ↔ API contract. Every export runs in the
// background, one at a time per person; the file is a UTF-8 CSV with a BOM, formula-safe (SEC §8),
// or a ZIP of CSVs for a guard's data. A download link lasts 15 minutes; files go after 7 days.
// Anyone allowed to export may download the organization's exports (owner decision 2026-11-02),
// within each kind's own rule: a guard's data only for Owners and Administrators, location only
// with location-history access and the reason when the organization requires one.
import { z } from 'zod';

import { historyReasonSchema, localDateSchema } from './reports.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });

export const EXPORT_KINDS = [
  'ATTENDANCE',
  'PATROLS',
  'INCIDENTS',
  'SITE_ACTIVITY',
  'LOCATION_REPORT',
  'LOCATION_HISTORY',
  'GUARD_DATA',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** The kinds that hold location history: location-history access, audited, reason (SEC §16.4). */
export const LOCATION_EXPORT_KINDS: readonly ExportKind[] = [
  'LOCATION_REPORT',
  'LOCATION_HISTORY',
  'GUARD_DATA',
];

export const EXPORT_STATUSES = ['QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** PROD §15.2. */
export const EXPORT_LINK_TTL_S = 15 * 60;
export const EXPORT_FILE_DAYS = 7;

const range = {
  from: localDateSchema,
  to: localDateSchema,
  siteId: uuid.optional(),
  guardId: uuid.optional(),
};

export const exportRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ATTENDANCE'), ...range }),
  z.strictObject({ kind: z.literal('PATROLS'), ...range }),
  z.strictObject({
    kind: z.literal('INCIDENTS'),
    ...range,
    drills: z.enum(['exclude', 'include']).default('exclude'),
  }),
  z.strictObject({ kind: z.literal('SITE_ACTIVITY'), ...range }),
  z.strictObject({ kind: z.literal('LOCATION_REPORT'), ...range, reason: historyReasonSchema.optional() }),
  /**
   * One guard's track: one shift, or a range of local dates (≤ 92 days) in the organization's time
   * zone. One of the two is required (VALIDATION_FAILED otherwise).
   */
  z.strictObject({
    kind: z.literal('LOCATION_HISTORY'),
    guardId: uuid,
    shiftId: uuid.optional(),
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
    reason: historyReasonSchema.optional(),
  }),
  /** SEC §16.6: profile, shifts, location and the incidents they reported, as a ZIP of CSVs. */
  z.strictObject({ kind: z.literal('GUARD_DATA'), guardId: uuid, reason: historyReasonSchema.optional() }),
]);
export type ExportRequest = z.infer<typeof exportRequestSchema>;

export const exportJobSchema = z.object({
  id: uuid,
  kind: z.enum(EXPORT_KINDS),
  status: z.enum(EXPORT_STATUSES),
  /** What was asked for, in words: "Attendance · 2026-10-01 to 2026-10-31 · Main gate". */
  title: z.string(),
  /** The user who asked for it (their user ID, as in /me). */
  requestedBy: z.object({ id: uuid, name: z.string() }),
  containsLocation: z.boolean(),
  rowCount: z.int().nullable(),
  sizeBytes: z.int().nullable(),
  fileName: z.string().nullable(),
  createdAt: instant,
  finishedAt: instant.nullable(),
  /** When the file is deleted (7 days after it was ready). */
  expiresAt: instant.nullable(),
  /** Why it failed: an error code from the catalog (errors.ts), INTERNAL_ERROR when unexpected; null otherwise. */
  errorCode: z.string().nullable(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;

export const exportResponseSchema = z.object({ export: exportJobSchema });
/** The newest 200 the person may see. */
export const exportListResponseSchema = z.object({ exports: z.array(exportJobSchema) });

/** A download is a new read: an export holding location asks for the reason again (SEC §16.4). */
export const exportDownloadRequestSchema = z.strictObject({ reason: historyReasonSchema.optional() });
/** An http(s) link only, served as an attachment (Content-Disposition), valid 15 minutes. */
// http(s) only. Not z.httpUrl(): it refuses IP-address hosts, and the local store's links in
// development and tests point at http://127.0.0.1 (found by the response check, review L-07).
export const exportDownloadResponseSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  expiresAt: instant,
});
