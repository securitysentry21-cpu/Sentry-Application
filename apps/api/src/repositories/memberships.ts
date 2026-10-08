// Memberships. Before an organization is chosen, the request context reads the signed-in user's
// own ACTIVE memberships through app.user_memberships() (migration 0002); everything else runs
// inside a tenant transaction, where RLS limits rows to the current organization.
import type { Role } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import { sql } from 'kysely';

export type UserMembership = {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  readonly organizationTimezone: string;
  readonly memberId: string;
  readonly role: Role;
};

export async function userMemberships(db: Database, userId: string): Promise<UserMembership[]> {
  const { rows } = await sql<{
    organization_id: string;
    organization_name: string;
    organization_status: UserMembership['organizationStatus'];
    organization_timezone: string;
    member_id: string;
    role: Role;
  }>`select * from app.user_memberships(${userId}::uuid)`.execute(db);
  return rows.map((r) => ({
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    organizationStatus: r.organization_status,
    organizationTimezone: r.organization_timezone,
    memberId: r.member_id,
    role: r.role,
  }));
}

export type MemberRow = {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: Role;
  readonly status: 'INVITED' | 'ACTIVE' | 'DISABLED' | 'REMOVED';
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const memberColumns = [
  'm.id',
  'm.user_id',
  'u.name',
  'u.email',
  'm.role',
  'm.status',
  'm.version',
  'm.created_at',
  'm.updated_at',
] as const;

type RawMember = {
  id: string;
  user_id: string;
  name: string;
  email: string | null;
  role: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
};

const toMember = (r: RawMember): MemberRow => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  email: r.email,
  role: r.role as Role,
  status: r.status as MemberRow['status'],
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Staff members of the current organization; guards are managed as guards (Phase 2). */
export async function listMembers(trx: Database, organizationId: string): Promise<MemberRow[]> {
  const rows = await trx
    .selectFrom('organization_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(memberColumns)
    .where('m.organization_id', '=', organizationId)
    .where('m.role', '<>', 'GUARD')
    .where('m.status', '<>', 'REMOVED')
    .orderBy('u.name')
    .orderBy('m.id')
    .execute();
  return rows.map(toMember);
}

export async function getMember(
  trx: Database,
  organizationId: string,
  memberId: string,
  options: { forUpdate?: boolean } = {},
): Promise<MemberRow | null> {
  let query = trx
    .selectFrom('organization_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(memberColumns)
    .where('m.organization_id', '=', organizationId)
    .where('m.id', '=', memberId);
  if (options.forUpdate) query = query.forUpdate('m');
  const row = await query.executeTakeFirst();
  return row ? toMember(row) : null;
}

export async function findMemberByUser(
  trx: Database,
  organizationId: string,
  userId: string,
): Promise<MemberRow | null> {
  const row = await trx
    .selectFrom('organization_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(memberColumns)
    .where('m.organization_id', '=', organizationId)
    .where('m.user_id', '=', userId)
    .executeTakeFirst();
  return row ? toMember(row) : null;
}

/**
 * Locks the organization's ACTIVE owner rows, always in ID order, and returns their member IDs.
 * Every change that can affect ownership takes this lock first, so concurrent changes queue up
 * instead of deadlocking, and each sees the result of the one before (ADV-A06).
 */
export async function lockActiveOwners(trx: Database, organizationId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('organization_members')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('role', '=', 'OWNER')
    .where('status', '=', 'ACTIVE')
    .orderBy('id')
    .forUpdate()
    .execute();
  return rows.map((r) => r.id);
}

export async function updateMember(
  trx: Database,
  input: {
    organizationId: string;
    memberId: string;
    version: number;
    role: Role;
    status: MemberRow['status'];
    now: Date;
  },
): Promise<boolean> {
  const result = await trx
    .updateTable('organization_members')
    .set({ role: input.role, status: input.status, version: input.version + 1, updated_at: input.now })
    .where('organization_id', '=', input.organizationId)
    .where('id', '=', input.memberId)
    .where('version', '=', input.version)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function insertMember(
  trx: Database,
  input: { id: string; organizationId: string; userId: string; role: Role; now: Date },
): Promise<void> {
  await trx
    .insertInto('organization_members')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      user_id: input.userId,
      role: input.role,
      status: 'ACTIVE',
      created_at: input.now,
      updated_at: input.now,
    })
    .execute();
}
