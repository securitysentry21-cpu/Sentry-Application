// Guards, their devices, mobile sessions and tracking consents. Always inside a tenant transaction.
import type { Database } from '@sentryops/db';
import { sql } from 'kysely';

import { sha256 } from '../ids.ts';

export type GuardRow = {
  readonly id: string;
  readonly userId: string | null;
  readonly employeeNumber: string;
  readonly displayName: string;
  readonly phone: string;
  readonly status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'TERMINATED';
  readonly preferredLocale: 'en' | 'ur';
  readonly enrolled: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

function guardQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('guards as g')
    .select((eb) => [
      'g.id',
      'g.user_id',
      'g.employee_number',
      'g.display_name',
      'g.phone',
      'g.status',
      'g.preferred_locale',
      'g.version',
      'g.created_at',
      'g.updated_at',
      eb
        .exists(
          eb
            .selectFrom('guard_devices as d')
            .select('d.id')
            .whereRef('d.guard_id', '=', 'g.id')
            .where('d.status', '=', 'ACTIVE'),
        )
        .as('enrolled'),
    ])
    .where('g.organization_id', '=', organizationId);
}

type RawGuard = Awaited<ReturnType<ReturnType<typeof guardQuery>['executeTakeFirstOrThrow']>>;

const toGuard = (r: RawGuard): GuardRow => ({
  id: r.id,
  userId: r.user_id,
  employeeNumber: r.employee_number,
  displayName: r.display_name,
  phone: r.phone,
  status: r.status as GuardRow['status'],
  preferredLocale: r.preferred_locale === 'ur' ? 'ur' : 'en',
  enrolled: Boolean(r.enrolled),
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listGuards(trx: Database, organizationId: string): Promise<GuardRow[]> {
  const rows = await guardQuery(trx, organizationId)
    .where('g.status', '<>', 'TERMINATED')
    .orderBy('g.display_name')
    .orderBy('g.id')
    .limit(5000)
    .execute();
  return rows.map(toGuard);
}

export async function getGuard(
  trx: Database,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<GuardRow | null> {
  let query = guardQuery(trx, organizationId).where('g.id', '=', id);
  if (options.forUpdate) query = query.forUpdate('g');
  const row = await query.executeTakeFirst();
  return row ? toGuard(row) : null;
}

export type GuardInput = {
  readonly employeeNumber: string;
  readonly displayName: string;
  readonly phone: string;
  readonly preferredLocale: 'en' | 'ur';
};

export async function insertGuard(
  trx: Database,
  input: GuardInput & { id: string; organizationId: string; userId: string; now: Date },
): Promise<void> {
  await trx
    .insertInto('guards')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      employee_number: input.employeeNumber,
      display_name: input.displayName,
      phone: input.phone,
      preferred_locale: input.preferredLocale,
      created_at: input.now,
      updated_at: input.now,
      created_by_user_id: input.userId,
      updated_by_user_id: input.userId,
    })
    .execute();
}

export async function updateGuard(
  trx: Database,
  input: {
    organizationId: string;
    id: string;
    version: number;
    userId: string;
    now: Date;
    changes: Partial<GuardInput> & { status?: GuardRow['status'] };
  },
): Promise<boolean> {
  const c = input.changes;
  const result = await trx
    .updateTable('guards')
    .set({
      ...(c.employeeNumber !== undefined ? { employee_number: c.employeeNumber } : {}),
      ...(c.displayName !== undefined ? { display_name: c.displayName } : {}),
      ...(c.phone !== undefined ? { phone: c.phone } : {}),
      ...(c.preferredLocale !== undefined ? { preferred_locale: c.preferredLocale } : {}),
      ...(c.status !== undefined ? { status: c.status } : {}),
      version: input.version + 1,
      updated_at: input.now,
      updated_by_user_id: input.userId,
    })
    .where('organization_id', '=', input.organizationId)
    .where('id', '=', input.id)
    .where('version', '=', input.version)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * Links the guard record to its user. False when that user is still a guard in another
 * organization (A-04: one organization at a time, enforced by a unique index).
 */
export async function linkGuardUser(
  trx: Database,
  organizationId: string,
  guardId: string,
  userId: string,
): Promise<boolean> {
  try {
    await trx
      .updateTable('guards')
      .set({ user_id: userId })
      .where('organization_id', '=', organizationId)
      .where('id', '=', guardId)
      .execute();
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return false;
    throw error;
  }
}

/** Existing employee numbers and phone numbers, for the import preview. */
export async function guardKeys(trx: Database, organizationId: string) {
  const rows = await trx
    .selectFrom('guards')
    .select(['employee_number', 'phone', 'status'])
    .where('organization_id', '=', organizationId)
    .execute();
  return {
    employeeNumbers: new Set(rows.map((r) => r.employee_number)),
    phones: new Set(rows.filter((r) => r.status !== 'TERMINATED').map((r) => r.phone)),
  };
}

// ── Devices ─────────────────────────────────────────────────────────────────────────────────

export type DeviceRow = {
  readonly id: string;
  readonly guardId: string;
  readonly installationId: string;
  readonly publicKey: Buffer;
  readonly platform: 'ANDROID' | 'IOS';
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly osVersion: string | null;
  readonly appVersion: string | null;
  readonly status: 'ACTIVE' | 'REVOKED';
  readonly revokedReason: 'REPLACED' | 'LOST' | 'COMPROMISED' | 'ADMIN' | null;
  readonly revokedAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
};

function deviceQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('guard_devices')
    .select([
      'id',
      'guard_id',
      'installation_id',
      'public_key',
      'platform',
      'manufacturer',
      'model',
      'os_version',
      'app_version',
      'status',
      'revoked_reason',
      'revoked_at',
      'last_seen_at',
      'created_at',
    ])
    .where('organization_id', '=', organizationId);
}

type RawDevice = Awaited<ReturnType<ReturnType<typeof deviceQuery>['executeTakeFirstOrThrow']>>;

const toDevice = (r: RawDevice): DeviceRow => ({
  id: r.id,
  guardId: r.guard_id,
  installationId: r.installation_id,
  publicKey: r.public_key,
  platform: r.platform === 'IOS' ? 'IOS' : 'ANDROID',
  manufacturer: r.manufacturer,
  model: r.model,
  osVersion: r.os_version,
  appVersion: r.app_version,
  status: r.status === 'ACTIVE' ? 'ACTIVE' : 'REVOKED',
  revokedReason: r.revoked_reason as DeviceRow['revokedReason'],
  revokedAt: r.revoked_at,
  lastSeenAt: r.last_seen_at,
  createdAt: r.created_at,
});

export async function listDevices(trx: Database, organizationId: string, guardId: string) {
  const rows = await deviceQuery(trx, organizationId)
    .where('guard_id', '=', guardId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(toDevice);
}

export async function getDevice(trx: Database, organizationId: string, id: string) {
  const row = await deviceQuery(trx, organizationId).where('id', '=', id).forUpdate().executeTakeFirst();
  return row ? toDevice(row) : null;
}

export async function findDeviceByInstallation(
  trx: Database,
  organizationId: string,
  installationId: string,
) {
  const row = await deviceQuery(trx, organizationId)
    .where('installation_id', '=', installationId)
    .forUpdate()
    .executeTakeFirst();
  return row ? toDevice(row) : null;
}

export async function activeDevice(trx: Database, organizationId: string, guardId: string) {
  const row = await deviceQuery(trx, organizationId)
    .where('guard_id', '=', guardId)
    .where('status', '=', 'ACTIVE')
    .forUpdate()
    .executeTakeFirst();
  return row ? toDevice(row) : null;
}

/** Revokes the device and every live session on it (SEC §5: rejected on the next request). */
export async function revokeDevice(
  trx: Database,
  input: {
    organizationId: string;
    deviceId: string;
    reason: NonNullable<DeviceRow['revokedReason']>;
    userId: string | null;
    now: Date;
  },
): Promise<void> {
  await trx
    .updateTable('guard_devices')
    .set({
      status: 'REVOKED',
      revoked_reason: input.reason,
      revoked_at: input.now,
      revoked_by_user_id: input.userId,
      updated_at: input.now,
    })
    .where('organization_id', '=', input.organizationId)
    .where('id', '=', input.deviceId)
    .where('status', '=', 'ACTIVE')
    .execute();
  await trx
    .updateTable('mobile_sessions')
    .set({ revoked_at: input.now, revoked_reason: 'DEVICE_REVOKED' })
    .where('organization_id', '=', input.organizationId)
    .where('device_id', '=', input.deviceId)
    .where('revoked_at', 'is', null)
    .execute();
}

export type DeviceInput = {
  readonly installationId: string;
  readonly publicKey: Buffer;
  readonly platform: 'ANDROID' | 'IOS';
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly osVersion: string;
  readonly appVersion: string;
};

export async function insertDevice(
  trx: Database,
  input: DeviceInput & { id: string; organizationId: string; guardId: string; now: Date },
): Promise<void> {
  await trx
    .insertInto('guard_devices')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      guard_id: input.guardId,
      installation_id: input.installationId,
      public_key: input.publicKey,
      key_algorithm: 'ECDSA_P256_SHA256',
      platform: input.platform,
      manufacturer: input.manufacturer,
      model: input.model,
      os_version: input.osVersion,
      app_version: input.appVersion,
      last_seen_at: input.now,
      created_at: input.now,
      updated_at: input.now,
    })
    .execute();
}

/** Same app installation enrolling again (after a sign-out): a fresh key, active again. */
export async function reactivateDevice(
  trx: Database,
  input: DeviceInput & { id: string; organizationId: string; guardId: string; now: Date },
): Promise<void> {
  await trx
    .updateTable('guard_devices')
    .set({
      guard_id: input.guardId,
      public_key: input.publicKey,
      platform: input.platform,
      manufacturer: input.manufacturer,
      model: input.model,
      os_version: input.osVersion,
      app_version: input.appVersion,
      status: 'ACTIVE',
      revoked_reason: null,
      revoked_at: null,
      revoked_by_user_id: null,
      last_seen_at: input.now,
      updated_at: input.now,
    })
    .where('organization_id', '=', input.organizationId)
    .where('id', '=', input.id)
    .execute();
}

export async function touchDevice(trx: Database, organizationId: string, deviceId: string, now: Date) {
  await trx
    .updateTable('guard_devices')
    .set({ last_seen_at: now })
    .where('organization_id', '=', organizationId)
    .where('id', '=', deviceId)
    .where((eb) =>
      eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<', new Date(now.getTime() - 60_000))]),
    )
    .execute();
}

// ── Mobile sessions (D-30) ──────────────────────────────────────────────────────────────────

export async function sessionIdByAccess(db: Database, token: string) {
  const { rows } = await sql<{ id: string; organization_id: string }>`
    select * from app.mobile_session_by_access(${sha256(token)})`.execute(db);
  return rows[0] ?? null;
}

export async function sessionIdByRefresh(db: Database, token: string) {
  const { rows } = await sql<{ id: string; organization_id: string }>`
    select * from app.mobile_session_by_refresh(${sha256(token)})`.execute(db);
  return rows[0] ?? null;
}

export async function loadSession(trx: Database, organizationId: string, id: string, forUpdate = false) {
  let query = trx
    .selectFrom('mobile_sessions as s')
    .innerJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 's.organization_id').onRef('g.id', '=', 's.guard_id'),
    )
    .innerJoin('guard_devices as d', (j) =>
      j.onRef('d.organization_id', '=', 's.organization_id').onRef('d.id', '=', 's.device_id'),
    )
    .innerJoin('organizations as o', 'o.id', 's.organization_id')
    .select([
      's.id',
      's.guard_id',
      's.device_id',
      's.family_id',
      's.access_expires_at',
      's.expires_at',
      's.rotated_at',
      's.revoked_at',
      'g.user_id',
      'g.display_name',
      'g.status as guard_status',
      'g.preferred_locale',
      'd.status as device_status',
      'd.public_key',
      'o.name as organization_name',
      'o.status as organization_status',
    ])
    .where('s.organization_id', '=', organizationId)
    .where('s.id', '=', id);
  if (forUpdate) query = query.forUpdate('s');
  return query.executeTakeFirst();
}

export async function insertSession(
  trx: Database,
  input: {
    id: string;
    organizationId: string;
    guardId: string;
    deviceId: string;
    familyId: string;
    accessToken: string;
    accessExpiresAt: Date;
    refreshToken: string;
    expiresAt: Date;
    now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('mobile_sessions')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      guard_id: input.guardId,
      device_id: input.deviceId,
      family_id: input.familyId,
      access_token_hash: sha256(input.accessToken),
      access_expires_at: input.accessExpiresAt,
      refresh_token_hash: sha256(input.refreshToken),
      expires_at: input.expiresAt,
      issued_at: input.now,
      created_at: input.now,
    })
    .execute();
}

export async function markRotated(trx: Database, organizationId: string, id: string, now: Date) {
  await trx
    .updateTable('mobile_sessions')
    .set({ rotated_at: now, last_used_at: now })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

/** Revokes live sessions of a family; `exceptId` keeps one (the grace path keeps none). */
export async function revokeFamily(
  trx: Database,
  organizationId: string,
  familyId: string,
  reason: 'ROTATION_REUSE' | 'SIGNED_OUT',
  now: Date,
) {
  await trx
    .updateTable('mobile_sessions')
    .set({ revoked_at: now, revoked_reason: reason })
    .where('organization_id', '=', organizationId)
    .where('family_id', '=', familyId)
    .where('revoked_at', 'is', null)
    .execute();
}

/** Live sessions in the family that have not been rotated yet: the current one(s). */
export async function revokeUnrotatedInFamily(
  trx: Database,
  organizationId: string,
  familyId: string,
  now: Date,
) {
  await trx
    .updateTable('mobile_sessions')
    .set({ revoked_at: now, revoked_reason: 'ROTATION_REUSE' })
    .where('organization_id', '=', organizationId)
    .where('family_id', '=', familyId)
    .where('rotated_at', 'is', null)
    .where('revoked_at', 'is', null)
    .execute();
}

export async function revokeGuardSessions(
  trx: Database,
  organizationId: string,
  guardId: string,
  reason: 'GUARD_DISABLED' | 'DEVICE_REVOKED',
  now: Date,
) {
  await trx
    .updateTable('mobile_sessions')
    .set({ revoked_at: now, revoked_reason: reason })
    .where('organization_id', '=', organizationId)
    .where('guard_id', '=', guardId)
    .where('revoked_at', 'is', null)
    .execute();
}

// ── Consents ────────────────────────────────────────────────────────────────────────────────

export async function insertConsent(
  trx: Database,
  input: {
    id: string;
    organizationId: string;
    guardId: string;
    userId: string | null;
    deviceId: string;
    disclosureVersion: string;
    locale: 'en' | 'ur';
    now: Date;
  },
) {
  await trx
    .insertInto('tracking_consents')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      guard_id: input.guardId,
      user_id: input.userId,
      device_id: input.deviceId,
      disclosure_version: input.disclosureVersion,
      locale: input.locale,
      accepted_at: input.now,
      created_at: input.now,
    })
    .execute();
}

export async function latestConsentVersion(trx: Database, organizationId: string, guardId: string) {
  const row = await trx
    .selectFrom('tracking_consents')
    .select('disclosure_version')
    .where('organization_id', '=', organizationId)
    .where('guard_id', '=', guardId)
    .orderBy('accepted_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.disclosure_version ?? null;
}
