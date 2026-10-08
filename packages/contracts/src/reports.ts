// Reports (PROD §15) — dashboard ↔ API contract. Dates are inclusive local dates: the site's time
// zone for a one-site report, the organization's otherwise.
import { z } from 'zod';

import { SHIFT_STATUSES } from './mobile.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** PROD §15.2: at most 92 days per report or export. */
export const REPORT_MAX_DAYS = 92;

export const attendanceQuerySchema = z.strictObject({
  from: localDate,
  to: localDate,
  siteId: uuid.optional(),
});

export const attendanceRowSchema = z.object({
  shiftId: uuid,
  guard: z.object({ id: uuid, displayName: z.string(), employeeNumber: z.string() }),
  site: z.object({ id: uuid, name: z.string() }),
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

export const attendanceResponseSchema = z.object({
  timezone: z.string(),
  from: localDate,
  to: localDate,
  rows: z.array(attendanceRowSchema),
  /** True when the period holds more shifts than one report returns; narrow the range. */
  truncated: z.boolean(),
});
