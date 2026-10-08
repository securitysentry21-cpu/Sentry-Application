// Shifts (PROD §6) — dashboard ↔ API contract. Instants are UTC; the dashboard converts site-local
// times with the site's time zone. Guard start and end carry a client event ID (idempotency).
import { z } from 'zod';

import { fixSchema, permissionSnapshotSchema, SHIFT_STATUSES } from './mobile.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const reason = z.string().trim().min(1).max(500);

export const START_SOURCES = ['APP_ONLINE', 'APP_OFFLINE_SYNCED', 'SUPERVISOR_MANUAL'] as const;
export const END_REASONS = [
  'GUARD',
  'GUARD_OFFLINE_SYNCED',
  'SUPERVISOR_FORCE_END',
  'AUTO_TIMEOUT',
  'GUARD_DISABLED',
] as const;

export const shiftSchema = z.object({
  id: uuid,
  guard: z.object({ id: uuid, displayName: z.string(), employeeNumber: z.string() }),
  site: z.object({ id: uuid, name: z.string(), timezone: z.string() }),
  startsAt: instant,
  endsAt: instant,
  startDeadlineAt: instant,
  status: z.enum(SHIFT_STATUSES),
  actualStartedAt: instant.nullable(),
  actualEndedAt: instant.nullable(),
  startSource: z.enum(START_SOURCES).nullable(),
  startGeofenceClass: z.enum(['INSIDE', 'OUTSIDE', 'UNCERTAIN', 'NO_FIX']).nullable(),
  startDistanceM: z.number().nullable(),
  startFlags: z.array(z.string()),
  endReason: z.enum(END_REASONS).nullable(),
  cancelledReason: z.string().nullable(),
  notes: z.string().nullable(),
  version: z.int(),
});
export type Shift = z.infer<typeof shiftSchema>;

export const shiftListQuerySchema = z.strictObject({
  from: instant,
  to: instant,
  siteId: uuid.optional(),
  guardId: uuid.optional(),
});
export const shiftListResponseSchema = z.object({ shifts: z.array(shiftSchema) });

export const shiftCreateRequestSchema = z.strictObject({
  guardId: uuid,
  siteId: uuid,
  startsAt: instant,
  endsAt: instant,
  notes: z.string().trim().max(4000).optional(),
});

export const shiftPatchRequestSchema = z
  .strictObject({
    guardId: uuid.optional(),
    siteId: uuid.optional(),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    version: z.int().min(1),
  })
  .refine((v) => Object.keys(v).length > 1, 'nothing to change');

/** A weekly pattern in the site's time zone (PROD §6.2), e.g. Mon–Sat 20:00–08:00. */
export const shiftBulkRequestSchema = z.strictObject({
  guardId: uuid,
  siteId: uuid,
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: z.array(z.int().min(0).max(6)).min(1).max(7),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** At or before the start time means the next day (an overnight shift). */
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export const shiftBulkResponseSchema = z.object({
  preview: z.boolean(),
  shifts: z.array(z.object({ startsAt: instant, endsAt: instant, conflict: z.string().nullable() })),
  created: z.int(),
});

export const shiftReasonRequestSchema = z.strictObject({ reason });
export const shiftExtendRequestSchema = z.strictObject({ endsAt: instant, reason: reason.optional() });

/** The guard's online start and end (POST /shifts/:id/start|end). Offline ones use /sync/batch. */
export const shiftStartRequestSchema = z.strictObject({
  clientEventId: uuid,
  recordedAt: instant,
  fix: fixSchema.nullable(),
  permission: permissionSnapshotSchema,
});
export const shiftEndRequestSchema = z.strictObject({
  clientEventId: uuid,
  recordedAt: instant,
  fix: fixSchema.nullable(),
});
