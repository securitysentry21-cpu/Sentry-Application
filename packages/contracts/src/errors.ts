// Error catalog — mirrors ARCH Appendix B. A test (ADV-X04) fails if the two differ.
import { z } from 'zod';

export const ERROR_CODES = {
  VALIDATION_FAILED: { http: 400, meaning: 'schema or range violation (details[] included)' },
  UNAUTHENTICATED: { http: 401, meaning: 'missing or invalid credentials' },
  FORBIDDEN: { http: 403, meaning: 'authenticated but lacks permission in own organization' },
  NOT_FOUND: { http: 404, meaning: 'does not exist or belongs to another organization' },
  ORG_CONTEXT_REQUIRED: { http: 400, meaning: 'multi-organization user omitted X-Organization-Id' },
  ORG_SUSPENDED: { http: 403, meaning: 'organization suspended (SOS still accepted)' },
  VERSION_CONFLICT: { http: 409, meaning: 'optimistic concurrency failure' },
  SHIFT_INVALID_TRANSITION: { http: 409, meaning: 'transition not allowed from current state' },
  ALERT_INVALID_TRANSITION: {
    http: 409,
    meaning: 'alert already closed, or SOS / critical incident dismissed instead of resolved',
  },
  SHIFT_OVERLAP: { http: 409, meaning: 'guard already has a shift in that period' },
  SHIFT_NOT_ACTIVE: { http: 409, meaning: 'operation needs an ACTIVE shift' },
  SHIFT_OUTSIDE_START_WINDOW: { http: 422, meaning: 'too early or after the start deadline' },
  TRACKING_PERMISSION_REQUIRED: { http: 422, meaning: 'phone-reported permission insufficient under policy' },
  LOCATION_FIX_REQUIRED: { http: 422, meaning: 'no fresh fix attached' },
  STARTED_OFF_SITE_BLOCKED: { http: 422, meaning: 'start outside geofence when policy is BLOCK' },
  OUTSIDE_SHIFT_WINDOW: { http: 422, meaning: 'location captured outside the shift window' },
  TIMESTAMP_TOO_OLD: { http: 422, meaning: 'beyond maximum offline age' },
  DEVICE_NOT_REGISTERED: { http: 403, meaning: 'missing or unknown X-Device-Id' },
  DEVICE_REVOKED: { http: 403, meaning: 'device revoked' },
  INVALID_QR: { http: 422, meaning: 'unknown, rotated, archived or foreign QR' },
  LAST_OWNER: { http: 409, meaning: 'would leave the organization without an owner' },
  SELF_ROLE_CHANGE: { http: 403, meaning: 'attempt to change own role or status' },
  INVITATION_EXPIRED: { http: 410, meaning: 'invitation or enrollment code expired, used or revoked' },
  ENROLLMENT_CODE_INVALID: {
    http: 422,
    meaning: "wrong enrollment code, or the code doesn't match the phone number",
  },
  ATTACHMENT_TOO_LARGE: { http: 413, meaning: 'over size limit' },
  ATTACHMENT_TYPE_NOT_ALLOWED: { http: 415, meaning: 'content does not match an allowed type' },
  EXPORT_RANGE_TOO_LARGE: { http: 422, meaning: 'export range > 92 days' },
  APP_VERSION_UNSUPPORTED: {
    http: 426,
    meaning: 'below minimum (not returned for SOS or queued uploads unless revoked)',
  },
  RATE_LIMITED: { http: 429, meaning: 'with Retry-After' },
  INTERNAL_ERROR: { http: 500, meaning: 'no internals exposed' },
  NOT_READY: { http: 503, meaning: 'dependency unavailable' },
} as const satisfies Record<string, { http: number; meaning: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const errorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

// ARCH §15.1: every error response has this shape; no stack traces, ever.
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z.array(z.object({ path: z.string(), issue: z.string() })).optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
