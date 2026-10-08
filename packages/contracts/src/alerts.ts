// Alerts (PROD §12) — dashboard ↔ API contract. Summaries are server-generated plain text.
import { z } from 'zod';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });

export const ALERT_TYPE_LIST = [
  'SOS_ACTIVATED',
  'INCIDENT_CRITICAL',
  'INCIDENT_HIGH',
  'GUARD_LEFT_SITE',
  'TRACKING_DISABLED',
  'DEVICE_OFFLINE',
  'LOCATION_STALE',
  'SHIFT_NOT_STARTED',
  'SHIFT_MISSED',
  'CHECKPOINT_MISSED',
  'SUSPICIOUS_LOCATION',
  'STARTED_OFF_SITE',
  'SHIFT_OVERRUN',
  'LOW_BATTERY',
  'DEVICE_CHANGED',
] as const;
export const ALERT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'] as const;
export const RESOLUTION_TYPES = ['MANUAL', 'CONDITION_CLEARED', 'SHIFT_ENDED', 'SUPERSEDED'] as const;

export const alertSchema = z.object({
  id: uuid,
  type: z.enum(ALERT_TYPE_LIST),
  severity: z.enum(ALERT_SEVERITIES),
  status: z.enum(ALERT_STATUSES),
  summary: z.string(),
  guard: z.object({ id: uuid, displayName: z.string() }).nullable(),
  site: z.object({ id: uuid, name: z.string() }).nullable(),
  shiftId: uuid.nullable(),
  details: z.record(z.string(), z.unknown()),
  openedAt: instant,
  lastTriggeredAt: instant,
  triggerCount: z.int(),
  acknowledgedAt: instant.nullable(),
  acknowledgedBy: z.object({ id: uuid, name: z.string() }).nullable(),
  resolvedAt: instant.nullable(),
  resolutionType: z.enum(RESOLUTION_TYPES).nullable(),
  resolutionNote: z.string().nullable(),
  dismissedAt: instant.nullable(),
  dismissReason: z.string().nullable(),
  detectedLate: z.boolean(),
  /** False for SOS and critical incidents (PROD §12.2). */
  dismissible: z.boolean(),
  version: z.int(),
});
export type Alert = z.infer<typeof alertSchema>;

export const alertListQuerySchema = z.strictObject({
  status: z.enum(['active', 'closed', 'all']).default('active'),
  shiftId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const alertListResponseSchema = z.object({ alerts: z.array(alertSchema) });

export const alertEventSchema = z.object({
  id: uuid,
  type: z.string(),
  actorType: z.enum(['USER', 'SYSTEM']),
  actorUserId: uuid.nullable(),
  note: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: instant,
});
export const alertDetailResponseSchema = z.object({ alert: alertSchema, events: z.array(alertEventSchema) });

export const alertResolveRequestSchema = z.strictObject({ note: z.string().trim().max(1000).optional() });
export const alertDismissRequestSchema = z.strictObject({ reason: z.string().trim().min(1).max(1000) });
export const alertResponseSchema = z.object({ alert: alertSchema });
