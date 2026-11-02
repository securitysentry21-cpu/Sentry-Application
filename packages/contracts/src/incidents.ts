// Incidents and their photos (PROD §10, ARCH §12) — dashboard and guard app ↔ API contract.
import { z } from 'zod';

import { INCIDENT_LOCATION } from './geo.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);

export const INCIDENT_TYPES = [
  'THEFT',
  'INTRUSION',
  'FIRE',
  'MEDICAL',
  'PROPERTY_DAMAGE',
  'ALTERCATION',
  'SUSPICIOUS_ACTIVITY',
  'OTHER',
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** The severity the guard app preselects for each type (PROD §7.8: FIRE and MEDICAL default HIGH). */
export const DEFAULT_INCIDENT_SEVERITY: Readonly<Record<IncidentType, IncidentSeverity>> = {
  THEFT: 'MEDIUM',
  INTRUSION: 'HIGH',
  FIRE: 'HIGH',
  MEDICAL: 'HIGH',
  PROPERTY_DAMAGE: 'MEDIUM',
  ALTERCATION: 'HIGH',
  SUSPICIOUS_ACTIVITY: 'MEDIUM',
  OTHER: 'MEDIUM',
};

/** The title the server gives a guard's report that has none (the app asks for a type, not a title). */
export const INCIDENT_TYPE_TITLES: Readonly<Record<IncidentType, string>> = {
  THEFT: 'Theft',
  INTRUSION: 'Intrusion',
  FIRE: 'Fire',
  MEDICAL: 'Medical emergency',
  PROPERTY_DAMAGE: 'Property damage',
  ALTERCATION: 'Altercation',
  SUSPICIOUS_ACTIVITY: 'Suspicious activity',
  OTHER: 'Other incident',
};

/** PROD §10.1: the occurred time may be set up to 24 hours back, never in the future. */
export const INCIDENT_MAX_BACKDATE_H = 24;
export const MAX_INCIDENT_PHOTOS = 5;
/** SEC §12: uploads are limited to 15 MB, and decoded images to 40 megapixels. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENT_PIXELS = 40_000_000;
export const ATTACHMENT_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
export const CAPTURE_SOURCES = ['IN_APP_CAMERA', 'GALLERY'] as const;
export const ATTACHMENT_STATUSES = ['PENDING_UPLOAD', 'PROCESSING', 'AVAILABLE', 'REJECTED'] as const;

/** "INC-000123": the human reference, per organization. */
export function incidentReference(n: number): string {
  return `INC-${String(n).padStart(6, '0')}`;
}

// ── What the dashboard sees ──────────────────────────────────────────────────────────────────

const person = z.object({ id: uuid, name: z.string() });

export const incidentAttachmentSchema = z.object({
  id: uuid,
  status: z.enum(ATTACHMENT_STATUSES),
  /** D-18: every photo says whether it came from the in-app camera or the gallery. */
  captureSource: z.enum(CAPTURE_SOURCES),
  width: z.int().nullable(),
  height: z.int().nullable(),
  sizeBytes: z.int().nullable(),
  /** The photo's own capture time, from its metadata when it had any. */
  exifCapturedAt: instant.nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: instant,
});
export type IncidentAttachment = z.infer<typeof incidentAttachmentSchema>;

export const incidentEventSchema = z.object({
  id: uuid,
  type: z.enum([
    'CREATED',
    'NOTE_ADDED',
    'STATUS_CHANGED',
    'SEVERITY_CHANGED',
    'TYPE_CHANGED',
    'ATTACHMENT_ADDED',
    'ATTACHMENT_REJECTED',
  ]),
  actorType: z.enum(['GUARD', 'USER', 'SYSTEM']),
  actorName: z.string().nullable(),
  body: z.string().nullable(),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  createdAt: instant,
});
export type IncidentEvent = z.infer<typeof incidentEventSchema>;

export const incidentSummarySchema = z.object({
  id: uuid,
  referenceNumber: z.string(),
  type: z.enum(INCIDENT_TYPES),
  severity: z.enum(INCIDENT_SEVERITIES),
  status: z.enum(INCIDENT_STATUSES),
  title: z.string(),
  guard: z.object({ id: uuid, displayName: z.string() }).nullable(),
  reportedBy: person.nullable(),
  site: z.object({ id: uuid, name: z.string(), timezone: z.string() }).nullable(),
  checkpoint: z.object({ id: uuid, name: z.string() }).nullable(),
  shiftId: uuid.nullable(),
  sosEventId: uuid.nullable(),
  occurredAt: instant,
  reportedAt: instant,
  receivedAt: instant,
  acknowledgedAt: instant.nullable(),
  resolvedAt: instant.nullable(),
  photoCount: z.int(),
  /** Filed during an SOS drill or in a demo organization: left out of statistics (PROD §11.10). */
  isDrill: z.boolean(),
  version: z.int(),
});
export type IncidentSummary = z.infer<typeof incidentSummarySchema>;

export const incidentDetailSchema = incidentSummarySchema.extend({
  description: z.string(),
  /** Where the guard was when filing it; only ever inside a shift or an open SOS (INV-08). */
  location: z
    .object({ lat: z.number(), lng: z.number(), accuracyM: z.number().nullable() })
    .meta(INCIDENT_LOCATION)
    .nullable(),
  locationFlags: z.array(z.string()),
  acknowledgedBy: person.nullable(),
  resolvedBy: person.nullable(),
  resolutionNote: z.string().nullable(),
  /** The type and severity as the reporter filed them (PROD §10.2: changes never overwrite them). */
  original: z.object({ type: z.enum(INCIDENT_TYPES), severity: z.enum(INCIDENT_SEVERITIES) }),
  events: z.array(incidentEventSchema),
  attachments: z.array(incidentAttachmentSchema),
});
export type IncidentDetail = z.infer<typeof incidentDetailSchema>;

export const incidentListQuerySchema = z.strictObject({
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  severity: z.enum(INCIDENT_SEVERITIES).optional(),
  type: z.enum(INCIDENT_TYPES).optional(),
  siteId: uuid.optional(),
  guardId: uuid.optional(),
  from: instant.optional(),
  to: instant.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type IncidentListQuery = z.infer<typeof incidentListQuerySchema>;
export const incidentListResponseSchema = z.object({ incidents: z.array(incidentSummarySchema) });
export const incidentResponseSchema = z.object({ incident: incidentDetailSchema });

/** A Supervisor, Administrator or Owner records an incident from the dashboard (PROD §3.2). */
export const incidentCreateRequestSchema = z.strictObject({
  type: z.enum(INCIDENT_TYPES),
  severity: z.enum(INCIDENT_SEVERITIES),
  title: text(120),
  description: z.string().trim().max(4000).default(''),
  occurredAt: instant.optional(),
  siteId: uuid.optional(),
});
export type IncidentCreateRequest = z.infer<typeof incidentCreateRequestSchema>;

export const incidentPatchRequestSchema = z
  .strictObject({
    version: z.int().min(1),
    severity: z.enum(INCIDENT_SEVERITIES).optional(),
    type: z.enum(INCIDENT_TYPES).optional(),
  })
  .refine((v) => v.severity !== undefined || v.type !== undefined, 'nothing to change');
export const incidentNoteRequestSchema = z.strictObject({ body: text(4000) });
export const incidentResolveRequestSchema = z.strictObject({ note: text(4000) });
export const incidentReopenRequestSchema = z.strictObject({ reason: text(1000) });

// ── Photos (ARCH §12) ────────────────────────────────────────────────────────────────────────

export const attachmentSlotRequestSchema = z.strictObject({
  /** The phone's id for this photo: asking again for the same photo returns the same slot. */
  clientEventId: uuid,
  contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
  sizeBytes: z.int().min(1).max(MAX_ATTACHMENT_BYTES),
  captureSource: z.enum(CAPTURE_SOURCES),
});
export type AttachmentSlotRequest = z.infer<typeof attachmentSlotRequestSchema>;

export const attachmentSlotResponseSchema = z.object({
  attachmentId: uuid,
  status: z.enum(ATTACHMENT_STATUSES),
  /** A signed PUT for exactly this type and size, valid until expiresAt (≤ 15 min). Null once uploaded. */
  upload: z
    .object({
      url: z.url(),
      method: z.literal('PUT'),
      headers: z.record(z.string(), z.string()),
      expiresAt: instant,
    })
    .nullable(),
});
export type AttachmentSlotResponse = z.infer<typeof attachmentSlotResponseSchema>;

export const attachmentCompleteRequestSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex SHA-256'),
});
export const attachmentCompleteResponseSchema = z.object({
  attachmentId: uuid,
  status: z.enum(ATTACHMENT_STATUSES),
});

/** A signed GET, valid ≤ 5 minutes (SEC §12). */
export const attachmentUrlResponseSchema = z.object({ url: z.url(), expiresAt: instant });

// ── The guard's own reports (GET /me/incidents) ──────────────────────────────────────────────

export const guardIncidentSchema = z.object({
  id: uuid,
  /** The phone's id for the report, so the app can match it with what it queued. */
  clientEventId: uuid.nullable(),
  referenceNumber: z.string(),
  type: z.enum(INCIDENT_TYPES),
  severity: z.enum(INCIDENT_SEVERITIES),
  status: z.enum(INCIDENT_STATUSES),
  title: z.string(),
  occurredAt: instant,
  receivedAt: instant,
  photos: z.array(z.object({ id: uuid, status: z.enum(ATTACHMENT_STATUSES) })),
  /** The guard's own notes only: the spec lets guards add notes, not read the supervisors' (agent-decided). */
  notes: z.array(z.object({ body: z.string(), createdAt: instant })),
});
export type GuardIncident = z.infer<typeof guardIncidentSchema>;
export const guardIncidentsResponseSchema = z.object({
  serverTime: instant,
  incidents: z.array(guardIncidentSchema),
});
export type GuardIncidentsResponse = z.infer<typeof guardIncidentsResponseSchema>;
