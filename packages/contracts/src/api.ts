// Dashboard ↔ API contract for identity and tenancy (Phase 1). Request schemas are strict:
// unknown fields are rejected, and identity fields are never accepted where the server derives
// them (SEC §6 rule 4, ADV-A10).
import { z } from 'zod';

import { AUDIT_ACTIONS } from './audit.ts';
import { PERMISSIONS, ROLES, type Permission } from './permissions.ts';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const name = z.string().trim().min(1).max(120);

export const MEMBER_STATUSES = ['INVITED', 'ACTIVE', 'DISABLED', 'REMOVED'] as const;
export const ORGANIZATION_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
/** Roles a dashboard user can hold; guards use the guard app (D-02). */
export const STAFF_ROLES = ['OWNER', 'ADMIN', 'SUPERVISOR', 'DISPATCHER'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

const permissionSchema = z.enum(Object.keys(PERMISSIONS) as [Permission, ...Permission[]]);

// ── /me ──────────────────────────────────────────────────────────────────────────────────────

export const meResponseSchema = z.object({
  user: z.object({ id: uuid, name: z.string(), email: z.string().nullable(), locale: z.string() }),
  memberships: z.array(
    z.object({
      organizationId: uuid,
      organizationName: z.string(),
      organizationStatus: z.enum(ORGANIZATION_STATUSES),
      organizationTimezone: z.string(),
      memberId: uuid,
      role: z.enum(ROLES),
      permissions: z.array(permissionSchema),
    }),
  ),
  serverTime: instant,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// ── Members ──────────────────────────────────────────────────────────────────────────────────

export const memberSchema = z.object({
  id: uuid,
  userId: uuid,
  name: z.string(),
  email: z.string().nullable(),
  role: z.enum(ROLES),
  status: z.enum(MEMBER_STATUSES),
  version: z.int(),
  createdAt: instant,
  updatedAt: instant,
});
export type Member = z.infer<typeof memberSchema>;

export const memberListResponseSchema = z.object({ members: z.array(memberSchema) });

export const memberPatchRequestSchema = z
  .strictObject({
    role: z.enum(STAFF_ROLES).optional(),
    status: z.enum(['ACTIVE', 'DISABLED', 'REMOVED']).optional(),
    version: z.int().min(1),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, 'nothing to change');
export type MemberPatchRequest = z.infer<typeof memberPatchRequestSchema>;

// ── Invitations ──────────────────────────────────────────────────────────────────────────────

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] as const;

export const invitationSchema = z.object({
  id: uuid,
  email: z.string(),
  role: z.enum(STAFF_ROLES),
  status: z.enum(INVITATION_STATUSES),
  expiresAt: instant,
  createdAt: instant,
  createdByName: z.string().nullable(),
});
export type Invitation = z.infer<typeof invitationSchema>;

export const invitationListResponseSchema = z.object({ invitations: z.array(invitationSchema) });

export const invitationCreateRequestSchema = z.strictObject({
  email: z.email().max(254),
  role: z.enum(STAFF_ROLES),
});

/** The link is shown once, to be sent by hand until an email provider exists (round 6). */
export const invitationCreateResponseSchema = z.object({
  invitation: invitationSchema,
  acceptUrl: z.string(),
});

export const invitationAcceptRequestSchema = z.strictObject({ token: z.string().min(20).max(100) });
export const invitationAcceptResponseSchema = z.object({
  organizationId: uuid,
  organizationName: z.string(),
  role: z.enum(STAFF_ROLES),
});

// ── Settings ─────────────────────────────────────────────────────────────────────────────────

export const settingsResponseSchema = z.object({
  /** Every setting, defaults merged with the organization's overrides. */
  settings: z.record(z.string(), z.unknown()),
  /** Keys this user may change from the dashboard (P-06). */
  editableKeys: z.array(z.string()),
  version: z.int(),
});

export const settingsPatchRequestSchema = z.strictObject({
  changes: z.record(z.string(), z.unknown()),
  version: z.int().min(1),
});

// ── Audit log ────────────────────────────────────────────────────────────────────────────────

export const auditLogEntrySchema = z.object({
  id: uuid,
  createdAt: instant,
  actorType: z.enum(['USER', 'SYSTEM', 'PLATFORM_OPERATOR']),
  actorName: z.string().nullable(),
  action: z.enum(AUDIT_ACTIONS),
  resourceType: z.string(),
  resourceId: uuid.nullable(),
  reason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export const auditLogListResponseSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
});

export const auditLogQuerySchema = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ── Sign-in ──────────────────────────────────────────────────────────────────────────────────

export const devLoginRequestSchema = z.strictObject({
  email: z.email().max(254),
  name: name.optional(),
});

export const nameSchema = name;
