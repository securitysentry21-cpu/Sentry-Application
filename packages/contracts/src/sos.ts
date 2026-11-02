// SOS and drills on the dashboard (PROD §11, §14.2) — dashboard ↔ API contract. The guard app's
// side of SOS is in mobile.ts.
import { z } from 'zod';

import { GUARD_LOCATION } from './geo.ts';
import { SOS_STATUSES } from './mobile.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);

export const SOS_RESOLUTIONS = ['GENUINE', 'FALSE_ALARM', 'ACCIDENTAL', 'DRILL', 'OTHER'] as const;
export type SosResolution = (typeof SOS_RESOLUTIONS)[number];

const sosPoint = z
  .object({ lat: z.number(), lng: z.number(), accuracyM: z.number().nullable(), capturedAt: instant })
  .meta(GUARD_LOCATION);

export const sosDeliverySchema = z.object({
  channel: z.enum(['WEB_PUSH', 'PUSH', 'SMS']),
  /** A member's name, or "Emergency contact" with the number masked (SEC §17.2). */
  recipient: z.string(),
  status: z.enum(['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED']),
  escalationLevel: z.int(),
  sentAt: instant.nullable(),
  errorCode: z.string().nullable(),
});

export const sosDetailSchema = z.object({
  id: uuid,
  alertId: uuid.nullable(),
  status: z.enum(SOS_STATUSES),
  isDrill: z.boolean(),
  guard: z.object({ id: uuid, displayName: z.string(), employeeNumber: z.string(), phone: z.string() }),
  site: z.object({ id: uuid, name: z.string(), timezone: z.string() }).nullable(),
  shiftId: uuid.nullable(),
  activatedAt: instant,
  receivedAt: instant,
  triggerCount: z.int(),
  lastTriggeredAt: instant,
  guardCancelRequestedAt: instant.nullable(),
  alertSentAt: instant.nullable(),
  notifiedAt: instant.nullable(),
  acknowledgedAt: instant.nullable(),
  acknowledgedBy: z.object({ id: uuid, name: z.string() }).nullable(),
  resolvedAt: instant.nullable(),
  resolvedBy: z.object({ id: uuid, name: z.string() }).nullable(),
  resolution: z.enum(SOS_RESOLUTIONS).nullable(),
  resolutionNote: z.string().nullable(),
  /** The newest SOS position and the recent trail. Viewing is audited (SOS_VIEWED, INV-14). */
  location: sosPoint.nullable(),
  trail: z.array(sosPoint),
  receipts: z.object({ shownOnDashboards: z.int(), reachedPhones: z.int() }),
  deliveries: z.array(sosDeliverySchema),
  version: z.int(),
});
export type SosDetail = z.infer<typeof sosDetailSchema>;
export const sosDetailResponseSchema = z.object({ sos: sosDetailSchema });

export const sosAcknowledgeRequestSchema = z.strictObject({});
export const sosResolveRequestSchema = z.strictObject({
  resolution: z.enum(SOS_RESOLUTIONS),
  note: text(1000),
});

// ── Drills (PROD §11.10, ADV-S10) ────────────────────────────────────────────────────────────

export const SOS_DRILL_MAX_MINUTES = 240;

export const sosDrillSchema = z.object({
  id: uuid,
  startedAt: instant,
  endsAt: instant,
  endedAt: instant.nullable(),
  /** True while the window is open: started, not ended, not past its end. */
  active: z.boolean(),
  startedBy: z.object({ id: uuid, name: z.string() }),
  /** Only these guards' SOS is a drill; anyone else's SOS during the window is real. */
  guards: z.array(z.object({ id: uuid, displayName: z.string() })),
  /** The only members a drill reaches (owner decision 2026-11-02). */
  members: z.array(z.object({ id: uuid, name: z.string() })),
  note: z.string().nullable(),
});
export type SosDrill = z.infer<typeof sosDrillSchema>;

export const sosDrillStartRequestSchema = z.strictObject({
  guardIds: z.array(uuid).min(1).max(50),
  /** Members taking part besides the person starting it, who always takes part. */
  memberIds: z.array(uuid).max(50).default([]),
  durationMinutes: z.int().min(5).max(SOS_DRILL_MAX_MINUTES).default(60),
  note: z.string().trim().max(500).optional(),
});
export const sosDrillResponseSchema = z.object({ drill: sosDrillSchema });
export const sosDrillCurrentResponseSchema = z.object({ drill: sosDrillSchema.nullable() });
