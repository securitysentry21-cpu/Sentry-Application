// Reports (PROD §15) — dashboard ↔ API contract. Dates are inclusive local dates: the site's time
// zone for a one-site report, the organization's otherwise (ADV-TM02).
import { z } from 'zod';

import { INCIDENT_SEVERITIES, INCIDENT_STATUSES, INCIDENT_TYPES } from './incidents.ts';
import { SHIFT_STATUSES } from './mobile.ts';
import { RUN_STATUS_LIST } from './patrols.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
/** A real calendar date: "2026-02-30" or "2026-13-45" would otherwise roll into another month. */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'not a calendar date');
const localDate = localDateSchema;

/** PROD §15.2: at most 92 days per report or export. */
export const REPORT_MAX_DAYS = 92;

/** D-21: the reason for reading location history; mandatory when the organization requires it. */
export const historyReasonSchema = z.string().trim().max(500);

/** Every report: inclusive local dates; one site or the whole organization; optionally one guard. */
const range = {
  from: localDate,
  to: localDate,
  siteId: uuid.optional(),
  guardId: uuid.optional(),
};

export const attendanceQuerySchema = z.strictObject(range);
export const patrolReportQuerySchema = z.strictObject(range);
export const siteActivityQuerySchema = z.strictObject(range);
export const incidentReportQuerySchema = z.strictObject({
  ...range,
  /** Drills are practice (PROD §11.10): left out unless asked for. */
  drills: z.enum(['exclude', 'include']).default('exclude'),
});
/** The location report reads location history (SEC §16.4): audited, with the reason (D-21). */
export const locationReportQuerySchema = z.strictObject({ ...range, reason: historyReasonSchema.optional() });

const guardRef = z.object({ id: uuid, displayName: z.string(), employeeNumber: z.string() });
const siteRef = z.object({ id: uuid, name: z.string() });

const reportResponse = <T extends z.ZodType>(row: T) =>
  z.object({
    timezone: z.string(),
    from: localDate,
    to: localDate,
    rows: z.array(row),
    /** True when the period holds more than one report returns; narrow the range. */
    truncated: z.boolean(),
  });

// ── Attendance (PROD §6.8) ──────────────────────────────────────────────────────────────────

export const attendanceRowSchema = z.object({
  shiftId: uuid,
  guard: guardRef,
  site: siteRef,
  scheduledStart: instant,
  scheduledEnd: instant,
  actualStart: instant.nullable(),
  actualEnd: instant.nullable(),
  status: z.enum(SHIFT_STATUSES),
  lateMinutes: z.int().nullable(),
  earlyLeaveMinutes: z.int().nullable(),
  workedMinutes: z.int().nullable(),
  flags: z.array(z.string()),
});
export type AttendanceRow = z.infer<typeof attendanceRowSchema>;
export const attendanceResponseSchema = reportResponse(attendanceRowSchema);

// ── Patrols (PROD §15.1): per shift and round ───────────────────────────────────────────────

export const patrolReportRowSchema = z.object({
  runId: uuid,
  shiftId: uuid,
  guard: guardRef,
  site: siteRef,
  route: z.object({ id: uuid, name: z.string() }),
  sequenceNo: z.int(),
  dueAt: instant,
  windowEndsAt: instant,
  status: z.enum(RUN_STATUS_LIST),
  required: z.int(),
  verified: z.int(),
  qrOnly: z.int(),
  missed: z.int(),
  /** Counted ÷ required, 0–100 (PROD §15.1); null when the round required nothing. */
  completionPct: z.int().nullable(),
  /** OUT_OF_ORDER, SENT_LATE, SUSPICIOUS (implausible travel or a mock location). */
  flags: z.array(z.string()),
});
export type PatrolReportRow = z.infer<typeof patrolReportRowSchema>;
export const patrolReportResponseSchema = reportResponse(patrolReportRowSchema);

// ── Incidents (PROD §15.1) ──────────────────────────────────────────────────────────────────

export const incidentReportRowSchema = z.object({
  incidentId: uuid,
  referenceNumber: z.string(),
  type: z.enum(INCIDENT_TYPES),
  severity: z.enum(INCIDENT_SEVERITIES),
  site: siteRef.nullable(),
  guard: guardRef.nullable(),
  occurredAt: instant,
  reportedAt: instant,
  status: z.enum(INCIDENT_STATUSES),
  /** From receipt to the first acknowledgement; null while nobody has. */
  secondsToAcknowledge: z.int().nullable(),
  /** From receipt to resolution; null while open. */
  secondsToResolve: z.int().nullable(),
  isDrill: z.boolean(),
});
export type IncidentReportRow = z.infer<typeof incidentReportRowSchema>;
export const incidentReportResponseSchema = reportResponse(incidentReportRowSchema);

// ── Location (PROD §15.1): per shift, derived from the track; no coordinates ─────────────────

export const locationReportRowSchema = z.object({
  shiftId: uuid,
  guard: guardRef,
  site: siteRef,
  scheduledStart: instant,
  scheduledEnd: instant,
  firstFixAt: instant.nullable(),
  lastFixAt: instant.nullable(),
  /** The shift's worked time split by where the track says the guard was (PROD §8.4 rules). */
  insideSeconds: z.int(),
  outsideSeconds: z.int(),
  unknownSeconds: z.int(),
  /** Confirmed departures, in order; `detectedLate` when the fixes arrived after the fact. */
  excursions: z.array(
    z.object({ from: instant, to: instant.nullable(), seconds: z.int(), detectedLate: z.boolean() }),
  ),
  longestGapSeconds: z.int(),
  /** The route summary: metres between usable fixes, and how many fixes there were. */
  distanceM: z.int(),
  points: z.int(),
  /** The track was deleted under retention: only the records' own times are left. */
  trackDeleted: z.boolean(),
});
export type LocationReportRow = z.infer<typeof locationReportRowSchema>;
export const locationReportResponseSchema = reportResponse(locationReportRowSchema);

// ── Site activity (PROD §15.1, R2): proof of service, per site and local date ───────────────

export const siteActivityRowSchema = z.object({
  site: siteRef,
  date: localDate,
  shiftsScheduled: z.int(),
  /** Started (on time or late) and not cancelled. */
  shiftsCovered: z.int(),
  shiftsMissed: z.int(),
  lateStarts: z.int(),
  workedMinutes: z.int(),
  patrolRequired: z.int(),
  patrolCounted: z.int(),
  patrolCompletionPct: z.int().nullable(),
  incidents: z.int(),
  incidentsHighOrCritical: z.int(),
});
export type SiteActivityRow = z.infer<typeof siteActivityRowSchema>;
export const siteActivityResponseSchema = reportResponse(siteActivityRowSchema);
