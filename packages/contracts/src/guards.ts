// Guards, devices and enrollment codes (Phase 2) — dashboard ↔ API contract.
import { z } from 'zod';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });

export const GUARD_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
export type GuardStatus = (typeof GUARD_STATUSES)[number];

const employeeNumber = z.string().trim().min(1).max(40);
const displayName = z.string().trim().min(1).max(120);
/** Pakistani numbers by default (SEC §9): guard codes go only to +92 unless the operator allows more. */
export const guardPhoneSchema = z.e164();

export const guardSchema = z.object({
  id: uuid,
  employeeNumber: z.string(),
  displayName: z.string(),
  phone: z.string(),
  status: z.enum(GUARD_STATUSES),
  preferredLocale: z.enum(['en', 'ur']),
  enrolled: z.boolean(),
  version: z.int(),
  createdAt: instant,
  updatedAt: instant,
});
export type Guard = z.infer<typeof guardSchema>;

export const guardListResponseSchema = z.object({ guards: z.array(guardSchema) });

export const guardCreateRequestSchema = z.strictObject({
  employeeNumber,
  displayName,
  phone: guardPhoneSchema,
  preferredLocale: z.enum(['en', 'ur']).default('en'),
});

export const guardPatchRequestSchema = z
  .strictObject({
    employeeNumber: employeeNumber.optional(),
    displayName: displayName.optional(),
    phone: guardPhoneSchema.optional(),
    preferredLocale: z.enum(['en', 'ur']).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
    version: z.int().min(1),
  })
  .refine((v) => Object.keys(v).length > 1, 'nothing to change');

export const guardImportRequestSchema = z.strictObject({
  /** UTF-8 CSV with a header row: employee_number, display_name, phone[, preferred_locale]. */
  csv: z.string().min(1).max(1_000_000),
});

export const guardImportResponseSchema = z.object({
  preview: z.boolean(),
  total: z.int(),
  valid: z.int(),
  created: z.int(),
  errors: z.array(z.object({ row: z.int(), field: z.string(), issue: z.string() })),
});

export const DEVICE_REVOKE_REASONS = ['LOST', 'COMPROMISED', 'ADMIN'] as const;

export const deviceSchema = z.object({
  id: uuid,
  platform: z.enum(['ANDROID', 'IOS']),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  osVersion: z.string().nullable(),
  appVersion: z.string().nullable(),
  status: z.enum(['ACTIVE', 'REVOKED']),
  revokedReason: z.enum(['REPLACED', 'LOST', 'COMPROMISED', 'ADMIN']).nullable(),
  revokedAt: instant.nullable(),
  lastSeenAt: instant.nullable(),
  createdAt: instant,
});
export const deviceListResponseSchema = z.object({ devices: z.array(deviceSchema) });

export const deviceRevokeRequestSchema = z.strictObject({ reason: z.enum(DEVICE_REVOKE_REASONS) });

/** Shown once, to be handed to the guard in person (round 6) until SMS exists. */
export const enrollmentCodeResponseSchema = z.object({
  purpose: z.enum(['GUARD_ENROLLMENT', 'NEW_DEVICE']),
  code: z.string(),
  /** What the guard app scans: `SGE1:<code>`. */
  qrPayload: z.string(),
  expiresAt: instant,
});
