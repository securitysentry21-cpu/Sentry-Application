// Guard app ↔ API contract (ARCH §5.3, §8, §9, §15.2). The guard app and the API import the same
// schemas, so the phone and the server cannot drift apart. Mobile requests carry
// `Authorization: Bearer <accessToken>`, `X-Device-Id`, `X-App-Version` and `X-Platform`.
import { z } from 'zod';

import { errorCodeSchema } from './errors.ts';
import { latitudeSchema, longitudeSchema, siteBoundarySchema } from './geo.ts';
import { INCIDENT_SEVERITIES, INCIDENT_TYPES } from './incidents.ts';
import { scanResultSchema } from './patrols.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);

export const PLATFORMS = ['ANDROID', 'IOS'] as const;
export const GUARD_LOCALES = ['en', 'ur'] as const;
export const SHIFT_STATUSES = ['SCHEDULED', 'ACTIVE', 'COMPLETED', 'MISSED', 'CANCELLED'] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

// ── Enrollment and sessions (D-02, D-30, D-31) ───────────────────────────────────────────────

/** The device key: P-256, SPKI DER, base64. Requests signed with it carry X-Device-Signature. */
export const DEVICE_KEY_ALGORITHM = 'ECDSA_P256_SHA256';

export const enrollmentRedeemRequestSchema = z.strictObject({
  /** What the supervisor handed over: the typed code (e.g. "K7Q4-M9XP") or the scanned QR payload. */
  code: z.string().trim().min(6).max(64),
  /** The guard's own number, E.164. Must match the number the organization entered (ADV-A11). */
  phone: z.e164(),
  installationId: uuid,
  publicKey: z.base64().min(80).max(400),
  keyAlgorithm: z.literal(DEVICE_KEY_ALGORITHM),
  platform: z.enum(PLATFORMS),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  osVersion: z.string().max(40),
  appVersion: z.string().max(40),
});
export type EnrollmentRedeemRequest = z.infer<typeof enrollmentRedeemRequestSchema>;

export const sessionTokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: instant,
  refreshToken: z.string(),
  refreshTokenExpiresAt: instant,
});
export type SessionTokens = z.infer<typeof sessionTokensSchema>;

export const enrollmentRedeemResponseSchema = z.object({
  deviceId: uuid,
  guard: z.object({ id: uuid, displayName: z.string(), preferredLocale: z.enum(GUARD_LOCALES) }),
  organization: z.object({ id: uuid, name: z.string() }),
  session: sessionTokensSchema,
});
export type EnrollmentRedeemResponse = z.infer<typeof enrollmentRedeemResponseSchema>;

export const sessionRefreshRequestSchema = z.strictObject({ refreshToken: z.string().min(20).max(200) });
export const sessionRefreshResponseSchema = z.object({ session: sessionTokensSchema });

// ── Configuration (ARCH §15.2) ───────────────────────────────────────────────────────────────

export const mobileConfigSchema = z.object({
  serverTime: instant,
  minSupportedVersion: z.string(),
  recommendedVersion: z.string(),
  revokedVersions: z.array(z.string()),
  disclosureVersion: z.string(),
  organization: z.object({ id: uuid, name: z.string() }),
  guard: z.object({ id: uuid, displayName: z.string(), preferredLocale: z.enum(GUARD_LOCALES) }),
  tracking: z.object({
    movingDistanceFilterM: z.int(),
    minIntervalS: z.int(),
    maxIntervalS: z.int(),
    stationaryFixIntervalS: z.int(),
    sosIntervalS: z.int(),
  }),
  sync: z.object({
    uploadIntervalS: z.int(),
    heartbeatIntervalS: z.int(),
    maxOfflineAgeHours: z.int(),
    maxBatchItems: z.int(),
  }),
  shift: z.object({
    earliestStartMinutes: z.int(),
    autoEndAfterMinutes: z.int(),
    startMaxFixAgeSeconds: z.int(),
    requireBackgroundPermission: z.enum(['BLOCK', 'WARN']),
  }),
  features: z.object({ sos: z.boolean(), patrols: z.boolean(), incidents: z.boolean() }),
  /** The number "Call supervisor" dials (`sos.emergency_call_number`); null until set. Optional for older servers. */
  support: z.object({ emergencyCallNumber: z.string().nullable() }).optional(),
});
export type MobileConfig = z.infer<typeof mobileConfigSchema>;

/**
 * The tracking disclosure version the server currently asks guards to accept (SEC §16.3). The guard
 * app can only record acceptance of text it ships, so every app build must bundle this version
 * (apps/mobile/src/core/i18n/disclosure.ts; a test checks). A new text after the legal review gets a
 * new version here and in the app.
 */
export const CURRENT_DISCLOSURE_VERSION = '1';

export const trackingConsentRequestSchema = z.strictObject({
  disclosureVersion: z.string().max(40),
  locale: z.enum(GUARD_LOCALES),
});
export const trackingConsentResponseSchema = z.object({ recordedAt: instant });

// ── Shifts for the guard (GET /me/shifts) ────────────────────────────────────────────────────

export const guardShiftSchema = z.object({
  id: uuid,
  status: z.enum(SHIFT_STATUSES),
  startsAt: instant,
  endsAt: instant,
  startDeadlineAt: instant,
  actualStartedAt: instant.nullable(),
  actualEndedAt: instant.nullable(),
  site: z.object({ id: uuid, name: z.string(), timezone: z.string(), boundary: siteBoundarySchema }),
  version: z.int(),
});
export type GuardShift = z.infer<typeof guardShiftSchema>;

export const meShiftsResponseSchema = z.object({ serverTime: instant, shifts: z.array(guardShiftSchema) });

// ── Sync (ARCH §8.6, §9) ─────────────────────────────────────────────────────────────────────

export const fixSchema = z.strictObject({
  lat: latitudeSchema,
  lon: longitudeSchema,
  /** Metres; null when the platform did not report it (flagged ACCURACY_UNKNOWN). */
  accuracyM: z.number().positive().nullable(),
  altitudeM: z.number().min(-500).max(10_000).optional(),
  /** Out-of-range speeds are flagged, not rejected (SEC §8). */
  speedMps: z.number().min(0).optional(),
  headingDeg: z.number().min(0).lt(360).optional(),
  isMock: z.boolean().optional(),
  provider: z.enum(['GPS', 'NETWORK', 'FUSED', 'UNKNOWN']).optional(),
  /** Seconds between the fix and the item (on-demand fixes for start, end, scans, incidents). */
  fixAgeS: z.number().min(0).optional(),
});
export type Fix = z.infer<typeof fixSchema>;

export const LOCATION_PERMISSIONS = [
  'ALWAYS',
  'WHEN_IN_USE',
  'DENIED',
  'RESTRICTED',
  'NOT_DETERMINED',
] as const;
export const TRACKING_SERVICE_STATES = ['RUNNING', 'STOPPED', 'PERMISSION_PROBLEM', 'UNKNOWN'] as const;

export const permissionSnapshotSchema = z.strictObject({
  location: z.enum(LOCATION_PERMISSIONS),
  precise: z.boolean(),
});

export const deviceStatusSchema = z.strictObject({
  locationPermission: z.enum(LOCATION_PERMISSIONS),
  preciseLocation: z.boolean(),
  locationServicesEnabled: z.boolean(),
  notificationsEnabled: z.boolean().optional(),
  batteryPct: z.number().min(0).max(100).optional(),
  isCharging: z.boolean().optional(),
  powerSaveMode: z.boolean().optional(),
  batteryOptimizationExempt: z.boolean().nullable().optional(),
  autoTimeEnabled: z.boolean().nullable().optional(),
  trackingServiceState: z.enum(TRACKING_SERVICE_STATES),
  osVersion: z.string().max(40).optional(),
  pendingQueueCount: z.int().min(0).optional(),
  oldestPendingAt: instant.nullable().optional(),
  lastSuccessfulSyncAt: instant.nullable().optional(),
});
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

const itemBase = {
  /** UUIDv7 made on the phone; the idempotency key (INV-06). */
  clientEventId: uuid,
  /** Phone wall clock at capture: evidence, never authority (INV-07). */
  recordedAt: instant,
  /** Monotonic clock at capture, counting through deep sleep (ARCH §8.7). */
  monoMs: z.int().min(0),
  /**
   * The boot (or app run) `monoMs` was taken in. Only an item whose bootId equals the batch's gets
   * the monotonic capture estimate; without it the server falls back to the phone clock (safe).
   */
  bootId: z.string().min(1).max(64).optional(),
};

export const SYNC_ITEM_TYPES = [
  'SHIFT_START',
  'SHIFT_END',
  'LOCATION',
  'HEARTBEAT',
  'DEVICE_STATUS',
  'CHECKPOINT_SCAN',
  'INCIDENT',
  'INCIDENT_NOTE',
] as const;
export type SyncItemType = (typeof SYNC_ITEM_TYPES)[number];

export const syncItemSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...itemBase,
    type: z.literal('SHIFT_START'),
    shiftId: uuid,
    fix: fixSchema.nullable(),
    permission: permissionSnapshotSchema,
  }),
  z.strictObject({ ...itemBase, type: z.literal('SHIFT_END'), shiftId: uuid, fix: fixSchema.nullable() }),
  z.strictObject({ ...itemBase, type: z.literal('LOCATION'), shiftId: uuid, fix: fixSchema }),
  z.strictObject({ ...itemBase, type: z.literal('HEARTBEAT'), shiftId: uuid.nullable() }),
  z.strictObject({
    ...itemBase,
    type: z.literal('DEVICE_STATUS'),
    shiftId: uuid.nullable(),
    status: deviceStatusSchema,
  }),
  z.strictObject({
    ...itemBase,
    type: z.literal('CHECKPOINT_SCAN'),
    shiftId: uuid.nullable(),
    /** The QR content as scanned. Never logged or stored (ARCH §11.1). */
    token: z.string().max(80),
    fix: fixSchema.nullable(),
  }),
  z.strictObject({
    ...itemBase,
    type: z.literal('INCIDENT'),
    /** A hint only: the server finds the shift (or open SOS) whose window holds the capture time. */
    shiftId: uuid.nullable(),
    incident: z.strictObject({
      type: z.enum(INCIDENT_TYPES),
      severity: z.enum(INCIDENT_SEVERITIES),
      /** The app asks for a type, not a title; the server names untitled reports by their type. */
      title: text(120).optional(),
      description: z.string().trim().max(4000),
      /** PROD §10.1: up to 24 hours back, never later than the report itself. */
      occurredAt: instant,
      /** "Checkpoint problem" (PROD §7.7): the damaged or missing label's checkpoint. */
      checkpointId: uuid.optional(),
    }),
    fix: fixSchema.nullable(),
  }),
  z
    .strictObject({
      ...itemBase,
      type: z.literal('INCIDENT_NOTE'),
      shiftId: uuid.nullable(),
      /** The guard's own report, by its server id, or by the phone's id when it was filed offline. */
      incidentId: uuid.optional(),
      incidentClientEventId: uuid.optional(),
      body: text(4000),
    })
    .refine((n) => (n.incidentId === undefined) !== (n.incidentClientEventId === undefined), {
      message: 'give incidentId or incidentClientEventId',
    }),
]);
export type SyncItem = z.infer<typeof syncItemSchema>;

export const MAX_BATCH_ITEMS = 500;

/** Items are validated one by one, so one malformed item never fails the batch (ARCH §9.3). */
export const syncBatchRequestSchema = z.strictObject({
  batchId: uuid,
  sentAt: instant,
  sentMonoMs: z.int().min(0),
  bootId: z.string().min(1).max(64),
  items: z.array(z.unknown()).min(1).max(MAX_BATCH_ITEMS),
});
export type SyncBatchRequest = z.infer<typeof syncBatchRequestSchema>;

export const SYNC_ITEM_STATUSES = ['ACCEPTED', 'DUPLICATE', 'QUARANTINED', 'REJECTED', 'RETRY'] as const;
export type SyncItemStatus = (typeof SYNC_ITEM_STATUSES)[number];

export const syncBatchResponseSchema = z.object({
  serverTime: instant,
  results: z.array(
    z.object({
      clientEventId: z.string(),
      status: z.enum(SYNC_ITEM_STATUSES),
      code: errorCodeSchema.optional(),
      /** A checkpoint scan's outcome, when the item was one (ACCEPTED or DUPLICATE). */
      scan: scanResultSchema.optional(),
      /** The incident the server stored, when the item was one: photos upload against its id. */
      incident: z.object({ id: uuid, referenceNumber: z.string() }).optional(),
    }),
  ),
  /** Server state wins (ARCH §8.8): the phone reconciles its local shifts with these. */
  shifts: z.array(z.object({ shiftId: uuid, status: z.enum(SHIFT_STATUSES), endsAt: instant })),
});
export type SyncBatchResponse = z.infer<typeof syncBatchResponseSchema>;

// ── SOS (ARCH §13.1, PROD §11) ───────────────────────────────────────────────────────────────

export const sosRequestSchema = z.strictObject({
  clientEventId: uuid,
  recordedAt: instant,
  monoMs: z.int().min(0),
  bootId: z.string().min(1).max(64),
  fix: fixSchema.nullable(),
  /** The monotonic clock when sent, so the server can estimate when it was pressed (ARCH §8.7). */
  sentMonoMs: z.int().min(0).optional(),
});
export type SosRequest = z.infer<typeof sosRequestSchema>;
export const SOS_STATUSES = ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export const sosResponseSchema = z.object({
  sosEventId: uuid,
  /** RECEIVED means stored on the server, nothing more (INV-10). */
  status: z.literal('RECEIVED'),
  serverTime: instant,
  /** A drill (PROD §11.10): the phone says so. Optional for older servers. */
  isDrill: z.boolean().optional(),
});
export type SosResponse = z.infer<typeof sosResponseSchema>;

/**
 * What the server can confirm about an SOS, in order (PROD §11.3). Each one needs its own fact:
 * ALERT_SENT a provider accepting a push or text; NOTIFIED a dashboard showing the alarm or a
 * person's phone confirming the push arrived; ACKNOWLEDGED a person; RESOLVED a supervisor (INV-10).
 */
export const SOS_PHASES = ['RECEIVED', 'ALERT_SENT', 'NOTIFIED', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type SosPhase = (typeof SOS_PHASES)[number];

export const sosStatusResponseSchema = z.object({
  sosEventId: uuid,
  serverTime: instant,
  phase: z.enum(SOS_PHASES),
  isDrill: z.boolean(),
  /** People a provider accepted a push or text for (ALERT_SENT: "Alert sent to 4 supervisors"). */
  alertSentTo: z.int().min(0),
  /** A connected dashboard showed the alarm ("Alert showing in the control room"). */
  shownInControlRoom: z.boolean(),
  /** People whose phones confirmed the alert arrived ("Alert reached 2 supervisors' phones"). */
  reachedPhones: z.int().min(0),
  acknowledgedBy: z.string().nullable(),
  acknowledgedAt: instant.nullable(),
  resolvedAt: instant.nullable(),
  cancelRequestedAt: instant.nullable(),
  /** SOS tracking stops here unless the SOS is resolved first (PROD §11.2: 4 hours). */
  trackingUntil: instant,
  trackingIntervalS: z.int(),
});
export type SosStatusResponse = z.infer<typeof sosStatusResponseSchema>;

/** SOS tracking points (PROD §11.2), sent on the SOS lane, never behind the main queue. */
export const sosLocationsRequestSchema = z.strictObject({
  bootId: z.string().min(1).max(64),
  sentMonoMs: z.int().min(0),
  points: z
    .array(z.strictObject({ ...itemBase, fix: fixSchema }))
    .min(1)
    .max(100),
});
export type SosLocationsRequest = z.infer<typeof sosLocationsRequestSchema>;
export const sosLocationsResponseSchema = z.object({
  serverTime: instant,
  results: z.array(
    z.object({
      clientEventId: z.string(),
      status: z.enum(SYNC_ITEM_STATUSES),
      code: errorCodeSchema.optional(),
    }),
  ),
});

/** "I'm safe / false alarm": noted on the SOS; it never resolves it or stops escalation (PROD §11.8). */
export const sosCancelRequestSchema = z.strictObject({ clientEventId: uuid, recordedAt: instant });

// ── Push to the guard app (D-26) ─────────────────────────────────────────────────────────────

export const guardPushTokenRequestSchema = z.strictObject({
  provider: z.literal('FCM'),
  token: z.string().min(20).max(4096),
});
export type GuardPushTokenRequest = z.infer<typeof guardPushTokenRequestSchema>;
