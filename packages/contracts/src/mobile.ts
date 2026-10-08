// Guard app ↔ API contract (ARCH §5.3, §8, §9, §15.2). The guard app and the API import the same
// schemas, so the phone and the server cannot drift apart. Mobile requests carry
// `Authorization: Bearer <accessToken>`, `X-Device-Id`, `X-App-Version` and `X-Platform`.
import { z } from 'zod';

import { errorCodeSchema } from './errors.ts';
import { latitudeSchema, longitudeSchema, siteBoundarySchema } from './geo.ts';

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
});
export type MobileConfig = z.infer<typeof mobileConfigSchema>;

export const trackingConsentRequestSchema = z.strictObject({
  disclosureVersion: z.string().max(40),
  locale: z.enum(GUARD_LOCALES),
});

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

export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

const itemBase = {
  /** UUIDv7 made on the phone; the idempotency key (INV-06). */
  clientEventId: uuid,
  /** Phone wall clock at capture: evidence, never authority (INV-07). */
  recordedAt: instant,
  /** Monotonic clock at capture, counting through deep sleep (ARCH §8.7). */
  monoMs: z.int().min(0),
};

export const SYNC_ITEM_TYPES = [
  'SHIFT_START',
  'SHIFT_END',
  'LOCATION',
  'HEARTBEAT',
  'DEVICE_STATUS',
  'CHECKPOINT_SCAN',
  'INCIDENT',
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
    shiftId: uuid.nullable(),
    incident: z.strictObject({
      type: z.string().max(40),
      severity: z.enum(INCIDENT_SEVERITIES),
      title: text(120),
      description: z.string().trim().max(4000),
      occurredAt: instant,
    }),
    fix: fixSchema.nullable(),
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
    }),
  ),
  /** Server state wins (ARCH §8.8): the phone reconciles its local shifts with these. */
  shifts: z.array(z.object({ shiftId: uuid, status: z.enum(SHIFT_STATUSES), endsAt: instant })),
});
export type SyncBatchResponse = z.infer<typeof syncBatchResponseSchema>;

// ── SOS (ARCH §13.1) ─────────────────────────────────────────────────────────────────────────

export const sosRequestSchema = z.strictObject({
  clientEventId: uuid,
  recordedAt: instant,
  monoMs: z.int().min(0),
  bootId: z.string().min(1).max(64),
  fix: fixSchema.nullable(),
});
export const SOS_STATUSES = ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export const sosResponseSchema = z.object({
  sosEventId: uuid,
  /** RECEIVED means stored on the server, nothing more (INV-10). */
  status: z.literal('RECEIVED'),
  serverTime: instant,
});
