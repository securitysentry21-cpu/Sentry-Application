// Member invitations (Phase 1). Guard enrollment and new-phone codes share the table (Phase 2).
import type { StaffRole } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import { sql } from 'kysely';

import { sha256 } from '../ids.ts';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // SEC §5: 7-day expiry

export type InvitationRow = {
  readonly id: string;
  readonly email: string;
  readonly role: StaffRole;
  readonly status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly createdByName: string | null;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
};

type Raw = {
  id: string;
  email: string | null;
  role: string | null;
  expires_at: Date;
  created_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_by_name: string | null;
};

function toInvitation(r: Raw, now: Date): InvitationRow {
  const status = r.accepted_at
    ? 'ACCEPTED'
    : r.revoked_at
      ? 'REVOKED'
      : r.expires_at <= now
        ? 'EXPIRED'
        : 'PENDING';
  return {
    id: r.id,
    email: r.email ?? '',
    role: r.role as StaffRole,
    status,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    createdByName: r.created_by_name,
    acceptedAt: r.accepted_at,
    revokedAt: r.revoked_at,
  };
}

function base(trx: Database, organizationId: string) {
  return trx
    .selectFrom('invitations as i')
    .leftJoin('users as u', 'u.id', 'i.created_by_user_id')
    .select([
      'i.id',
      'i.email',
      'i.role',
      'i.expires_at',
      'i.created_at',
      'i.accepted_at',
      'i.revoked_at',
      'u.name as created_by_name',
    ])
    .where('i.organization_id', '=', organizationId)
    .where('i.purpose', '=', 'MEMBER');
}

export async function listInvitations(trx: Database, organizationId: string, now: Date) {
  const rows = await base(trx, organizationId).orderBy('i.created_at', 'desc').limit(500).execute();
  return rows.map((r) => toInvitation(r, now));
}

export async function getInvitation(trx: Database, organizationId: string, id: string, now: Date) {
  const row = await base(trx, organizationId).where('i.id', '=', id).executeTakeFirst();
  return row ? toInvitation(row, now) : null;
}

export async function createMemberInvitation(
  trx: Database,
  input: {
    id: string;
    organizationId: string;
    email: string;
    role: StaffRole;
    token: string;
    createdByUserId: string | null;
    now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('invitations')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      purpose: 'MEMBER',
      role: input.role,
      email: input.email.toLowerCase(),
      token_hash: sha256(input.token),
      expires_at: new Date(input.now.getTime() + INVITATION_TTL_MS),
      created_by_user_id: input.createdByUserId,
      created_at: input.now,
    })
    .execute();
}

export async function revokeInvitation(
  trx: Database,
  organizationId: string,
  id: string,
  userId: string,
  now: Date,
): Promise<boolean> {
  const result = await trx
    .updateTable('invitations')
    .set({ revoked_at: now, revoked_by_user_id: userId })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** The organization of the invitation a link token belongs to (migration 0002, before membership). */
export async function invitationOrganizationByToken(
  db: Database,
  token: string,
): Promise<{ id: string; organizationId: string } | null> {
  const { rows } = await sql<{ id: string; organization_id: string }>`
    select * from app.invitation_by_token(${sha256(token)})`.execute(db);
  const row = rows[0];
  return row ? { id: row.id, organizationId: row.organization_id } : null;
}

export async function lockMemberInvitation(trx: Database, organizationId: string, id: string) {
  return trx
    .selectFrom('invitations')
    .select(['id', 'email', 'role', 'purpose', 'expires_at', 'accepted_at', 'revoked_at'])
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export async function markInvitationAccepted(
  trx: Database,
  organizationId: string,
  id: string,
  userId: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('invitations')
    .set({ accepted_at: now, accepted_by_user_id: userId })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}
