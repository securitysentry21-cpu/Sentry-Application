// Patrols (PROD §9, ARCH §11) — dashboard ↔ API and guard app ↔ API contracts. Responses carry
// distances and accuracy, never a guard's coordinates; checkpoint positions are site geometry.
import { z } from 'zod';

import { SITE_GEOMETRY } from './geo.ts';
import { SITE_STATUSES } from './sites.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });

export const SCAN_OUTCOME_LIST = [
  'VERIFIED',
  'LOCATION_UNCONFIRMED',
  'OUTSIDE_RADIUS',
  'WRONG_SITE',
  'INVALID_QR',
  'NO_ACTIVE_SHIFT',
  'DUPLICATE',
] as const;
export type ScanOutcomeName = (typeof SCAN_OUTCOME_LIST)[number];

export const RUN_STATUS_LIST = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'INCOMPLETE',
  'MISSED',
  'CANCELLED',
] as const;
export type PatrolRunStatus = (typeof RUN_STATUS_LIST)[number];

// ── Routes (dashboard) ───────────────────────────────────────────────────────────────────────

/** On demand, or every interval with a completion window no longer than it (PROD §9.2). */
export const PATROL_INTERVAL_MINUTES = { min: 10, max: 720 } as const;
export const PATROL_WINDOW_MINUTES = { min: 5, max: 720 } as const;
export const PATROL_ROUTE_MAX_CHECKPOINTS = 200;

export const patrolRouteSchema = z.object({
  id: uuid,
  siteId: uuid,
  name: z.string(),
  description: z.string().nullable(),
  enforceOrder: z.boolean(),
  /** null: on demand — scans are recorded, nothing is ever missed. */
  schedule: z
    .object({
      intervalMinutes: z.int(),
      firstRunOffsetMinutes: z.int(),
      completionWindowMinutes: z.int(),
    })
    .nullable(),
  status: z.enum(SITE_STATUSES),
  checkpoints: z.array(
    z.object({ checkpointId: uuid, name: z.string(), sequence: z.int(), required: z.boolean() }),
  ),
  version: z.int(),
  updatedAt: instant,
});
export type PatrolRoute = z.infer<typeof patrolRouteSchema>;

export const patrolRouteListResponseSchema = z.object({ routes: z.array(patrolRouteSchema) });

const scheduleInput = z
  .strictObject({
    intervalMinutes: z.int().min(PATROL_INTERVAL_MINUTES.min).max(PATROL_INTERVAL_MINUTES.max),
    firstRunOffsetMinutes: z.int().min(0).max(PATROL_INTERVAL_MINUTES.max).default(0),
    completionWindowMinutes: z.int().min(PATROL_WINDOW_MINUTES.min).max(PATROL_WINDOW_MINUTES.max),
  })
  .refine((s) => s.completionWindowMinutes <= s.intervalMinutes, {
    message: 'the completion window must not be longer than the interval',
    path: ['completionWindowMinutes'],
  });

/** In route order; the first is visited first. */
const stopsInput = z
  .array(z.strictObject({ checkpointId: uuid, required: z.boolean().default(true) }))
  .max(PATROL_ROUTE_MAX_CHECKPOINTS)
  .refine(
    (stops) => new Set(stops.map((s) => s.checkpointId)).size === stops.length,
    'a checkpoint is listed twice',
  );

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const patrolRouteCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: optionalText(4000),
  enforceOrder: z.boolean().default(false),
  schedule: scheduleInput.nullable(),
  checkpoints: stopsInput,
});

export const patrolRoutePatchRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    description: optionalText(4000),
    enforceOrder: z.boolean().optional(),
    schedule: scheduleInput.nullable().optional(),
    checkpoints: stopsInput.optional(),
    status: z.enum(SITE_STATUSES).optional(),
    version: z.int().min(1),
  })
  .refine((v) => Object.keys(v).length > 1, 'nothing to change');

// ── Runs and visits (dashboard) ──────────────────────────────────────────────────────────────

export const patrolRunSchema = z.object({
  id: uuid,
  shiftId: uuid,
  guard: z.object({ id: uuid, displayName: z.string() }),
  site: z.object({ id: uuid, name: z.string(), timezone: z.string() }),
  route: z.object({ id: uuid, name: z.string() }),
  sequenceNo: z.int(),
  dueAt: instant,
  windowEndsAt: instant,
  status: z.enum(RUN_STATUS_LIST),
  startedAt: instant.nullable(),
  completedAt: instant.nullable(),
  closedAt: instant.nullable(),
  requiredCount: z.int(),
  countedCount: z.int(),
  /** Counted only by "QR only" scans (D-17). */
  unconfirmedCount: z.int(),
  /** Required checkpoints not yet counted, in route order. */
  missing: z.array(z.string()),
});
export type PatrolRun = z.infer<typeof patrolRunSchema>;

export const patrolRunListQuerySchema = z.strictObject({
  shiftId: uuid.optional(),
  siteId: uuid.optional(),
  guardId: uuid.optional(),
  status: z.enum(RUN_STATUS_LIST).optional(),
  /** Runs due in [from, to); at most 31 days. Defaults to the last and the next 24 hours. */
  from: instant.optional(),
  to: instant.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const patrolRunListResponseSchema = z.object({ runs: z.array(patrolRunSchema) });

export const checkpointVisitSchema = z.object({
  id: uuid,
  shiftId: uuid.nullable(),
  runId: uuid.nullable(),
  /** Null for a label that was not one of the organization's active checkpoints. */
  checkpoint: z.object({ id: uuid, name: z.string() }).nullable(),
  scannedAt: instant,
  receivedAt: instant,
  outcome: z.enum(SCAN_OUTCOME_LIST),
  /** Why the location could not be confirmed, for LOCATION_UNCONFIRMED. */
  reason: z.string().nullable(),
  counted: z.boolean(),
  distanceM: z.int().nullable(),
  accuracyM: z.number().nullable(),
  flags: z.array(z.string()),
  /** Sent from the phone well after the scan (offline). */
  late: z.boolean(),
});
export type CheckpointVisit = z.infer<typeof checkpointVisitSchema>;

export const patrolRunDetailResponseSchema = z.object({
  run: patrolRunSchema,
  enforceOrder: z.boolean(),
  checkpoints: z.array(
    z.object({
      checkpointId: uuid,
      name: z.string(),
      sequence: z.int(),
      required: z.boolean(),
      location: z.object({ lat: z.number(), lng: z.number() }).meta(SITE_GEOMETRY).nullable(),
      done: z.enum(['VERIFIED', 'QR_ONLY']).nullable(),
    }),
  ),
  visits: z.array(checkpointVisitSchema),
});

export const checkpointVisitListQuerySchema = z.strictObject({ shiftId: uuid });
export const checkpointVisitListResponseSchema = z.object({ visits: z.array(checkpointVisitSchema) });

// ── The guard's own rounds (GET /me/patrols) ─────────────────────────────────────────────────

export const guardPatrolsQuerySchema = z.strictObject({ shiftId: uuid });

export const guardPatrolRunSchema = z.object({
  id: uuid,
  routeName: z.string(),
  sequenceNo: z.int(),
  dueAt: instant,
  windowEndsAt: instant,
  status: z.enum(RUN_STATUS_LIST),
  requiredCount: z.int(),
  countedCount: z.int(),
  enforceOrder: z.boolean(),
  checkpoints: z.array(
    z.object({
      checkpointId: uuid,
      name: z.string(),
      sequence: z.int(),
      required: z.boolean(),
      done: z.enum(['VERIFIED', 'QR_ONLY']).nullable(),
    }),
  ),
});
export type GuardPatrolRun = z.infer<typeof guardPatrolRunSchema>;

export const guardPatrolsResponseSchema = z.object({
  serverTime: instant,
  shiftId: uuid,
  runs: z.array(guardPatrolRunSchema),
});
export type GuardPatrolsResponse = z.infer<typeof guardPatrolsResponseSchema>;

/**
 * A scan's outcome, returned with its sync result so the phone can show it (PROD §7.7). The
 * checkpoint's name and the distance appear only for a checkpoint of the guard's own site, and never
 * for a label that isn't recognised (ADV-T08).
 */
export const scanResultSchema = z.object({
  outcome: z.enum(SCAN_OUTCOME_LIST),
  counted: z.boolean(),
  checkpointName: z.string().nullable(),
  /** Metres, rounded to 5, for OUTSIDE_RADIUS. */
  distanceM: z.int().nullable(),
  /** The run the scan counted toward: progress after it. */
  run: z
    .object({ countedCount: z.int(), requiredCount: z.int(), status: z.enum(RUN_STATUS_LIST) })
    .nullable(),
});
export type ScanResult = z.infer<typeof scanResultSchema>;
