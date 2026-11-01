// Live operations (PROD §14, ARCH §14) — dashboard ↔ API contract: the snapshot, the realtime
// stream's events, a guard's live location and the location history viewer.
import { z } from 'zod';

import { alertSchema } from './alerts.ts';
import { GUARD_LOCATION, siteBoundarySchema } from './geo.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });

export const GEOFENCE_STATES = [
  'UNKNOWN',
  'INSIDE',
  'UNCERTAIN',
  'OUTSIDE_SUSPECTED',
  'OUTSIDE_CONFIRMED',
] as const;

export const freshnessSchema = z.object({
  healthLiveMaxS: z.int(),
  offlineAfterS: z.int(),
  locationCurrentMaxS: z.int(),
});

/** A guard on an active shift: tracking health and location age are separate signals (D-36). */
export const liveGuardSchema = z.object({
  shiftId: uuid,
  guard: z.object({ id: uuid, displayName: z.string(), employeeNumber: z.string() }),
  /** Site-bound times show in the site's time zone (PROD §14.7). */
  site: z.object({ id: uuid, name: z.string(), timezone: z.string() }),
  startsAt: instant,
  startedAt: instant.nullable(),
  endsAt: instant,
  manualStart: z.boolean(),
  startFlags: z.array(z.string()),
  /** A live coordinate: current positions of guards on duty only, never history (ADV-X05, INV-14). */
  lastFix: z
    .object({ lat: z.number(), lng: z.number(), accuracyM: z.number().nullable(), capturedAt: instant })
    .meta(GUARD_LOCATION)
    .nullable(),
  lastContactAt: instant.nullable(),
  trackingHealth: z.enum(['LIVE', 'DELAYED', 'OFFLINE']),
  locationAge: z.enum(['CURRENT', 'LAST_KNOWN', 'UNKNOWN']),
  geofenceState: z.enum(GEOFENCE_STATES),
  trackingServiceState: z.string().nullable(),
  locationPermission: z.string().nullable(),
  batteryPct: z.number().nullable(),
  isCharging: z.boolean().nullable(),
  appVersion: z.string().nullable(),
  pendingQueueCount: z.int().nullable(),
  /** When the phone last described itself (PROD §8.3: "as of 21:04" when not LIVE). */
  deviceReportAt: instant.nullable(),
});
export type LiveGuard = z.infer<typeof liveGuardSchema>;

/** Monitoring coverage (PROD §11.5): dashboards connected right now, desktops and phones. */
export const coverageSchema = z.object({ desktop: z.int(), phone: z.int() });
export type Coverage = z.infer<typeof coverageSchema>;

export const snapshotResponseSchema = z.object({
  serverTime: instant,
  /** The stream continues from here (ARCH §14): every change after this snapshot has a later ID. */
  lastEventId: z.int(),
  freshness: freshnessSchema,
  guards: z.array(liveGuardSchema),
  /** Scheduled shifts whose start time has passed without a start (PROD §14.2). */
  shiftsNotStarted: z.int(),
  coverage: coverageSchema,
});
export type Snapshot = z.infer<typeof snapshotResponseSchema>;

// ── The realtime stream (ARCH §14) ──────────────────────────────────────────────────────────

export const REALTIME_EVENT_TYPES = [
  'guard.state',
  'alert.opened',
  'alert.updated',
  'shift.updated',
  'coverage.updated',
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/**
 * What the stream sends, as `data:` of an SSE event whose `id:` is the organization's sequence.
 * Stored events hold IDs only; the API adds the current state when it sends them, so a dashboard
 * never has to fetch per event. `resync` means the client's position is outside the replay buffer:
 * reload the snapshot.
 */
export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('guard.state'),
    occurredAt: instant,
    /** `guard` is null once the shift is no longer active. */
    data: z.object({ shiftId: uuid, guard: liveGuardSchema.nullable() }),
  }),
  z.object({
    type: z.enum(['alert.opened', 'alert.updated']),
    occurredAt: instant,
    data: z.object({ alertId: uuid, alert: alertSchema.nullable() }),
  }),
  z.object({
    type: z.literal('shift.updated'),
    occurredAt: instant,
    data: z.object({ shiftId: uuid, status: z.string().nullable() }),
  }),
  z.object({
    type: z.literal('coverage.updated'),
    occurredAt: instant,
    data: z.object({ coverage: coverageSchema }),
  }),
  z.object({ type: z.literal('resync'), occurredAt: instant, data: z.object({}) }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;

export const streamQuerySchema = z.strictObject({
  /** Only for the coverage count; it grants nothing. */
  client: z.enum(['desktop', 'phone']).default('desktop'),
});

// ── A guard's live location (ARCH §15.3: GET /guards/:id/location) ──────────────────────────

export const guardLocationResponseSchema = z.object({
  serverTime: instant,
  freshness: freshnessSchema,
  /** The guard's active shift, or null when off duty. */
  live: liveGuardSchema.nullable(),
  /** The disclosure the guard last accepted (SEC §16.3). */
  consent: z.object({ version: z.string(), locale: z.string(), acceptedAt: instant }).nullable(),
});

// ── Location history (PROD §14.5, SEC §16.4) ────────────────────────────────────────────────

export const HISTORY_MAX_RANGE_H = 24;
export const HISTORY_MAX_POINTS = 2000;
export const HISTORY_GAP_S = 300;

export const locationHistoryQuerySchema = z
  .strictObject({
    shiftId: uuid.optional(),
    from: instant.optional(),
    to: instant.optional(),
    /** Always offered; required when the organization requires it (D-21). */
    reason: z.string().trim().max(500).optional(),
  })
  .refine((q) => (q.shiftId ? !q.from && !q.to : Boolean(q.from && q.to)), {
    message: 'give either shiftId, or from and to',
  })
  .refine(
    (q) => {
      if (!q.from || !q.to) return true;
      const span = Date.parse(q.to) - Date.parse(q.from);
      return span > 0 && span <= HISTORY_MAX_RANGE_H * 3_600_000;
    },
    { message: `from must be before to, at most ${HISTORY_MAX_RANGE_H} hours apart`, path: ['to'] },
  );
export type LocationHistoryQuery = z.infer<typeof locationHistoryQuerySchema>;

export const historyPointSchema = z
  .object({
    lat: z.number(),
    lng: z.number(),
    accuracyM: z.number().nullable(),
    capturedAt: instant,
    shiftId: uuid.nullable(),
    source: z.string(),
    flags: z.array(z.string()),
    /** More than HISTORY_GAP_S since the previous point: draw a break, never a line (PROD §14.5). */
    gapBefore: z.boolean(),
  })
  .meta(GUARD_LOCATION);
export type HistoryPoint = z.infer<typeof historyPointSchema>;

export const locationHistoryResponseSchema = z.object({
  guard: z.object({ id: uuid, displayName: z.string(), employeeNumber: z.string() }),
  from: instant,
  to: instant,
  /** Raw points in the range; at most HISTORY_MAX_POINTS are returned. */
  totalPoints: z.int(),
  points: z.array(historyPointSchema),
  shifts: z.array(
    z.object({
      id: uuid,
      status: z.string(),
      startsAt: instant,
      endsAt: instant,
      startedAt: instant.nullable(),
      endedAt: instant.nullable(),
      site: z.object({ id: uuid, name: z.string(), timezone: z.string(), boundary: siteBoundarySchema }),
    }),
  ),
  /** Shift events in the range: starts, ends, leaving and returning to the site. No coordinates. */
  events: z.array(z.object({ shiftId: uuid, type: z.string(), occurredAt: instant })),
});
export type LocationHistory = z.infer<typeof locationHistoryResponseSchema>;
