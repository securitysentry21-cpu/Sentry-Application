// Sites (D-38) and checkpoints (ARCH §11.1). Always inside a tenant transaction.
import type { SiteBoundary } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import { sql } from 'kysely';

export type SiteRow = {
  readonly id: string;
  readonly name: string;
  readonly clientName: string | null;
  readonly addressLine1: string | null;
  readonly city: string | null;
  readonly country: string;
  readonly timezone: string;
  readonly boundary: SiteBoundary;
  readonly center: { lat: number; lng: number };
  readonly status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  readonly notes: string | null;
  readonly checkpointCount: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

function siteQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('sites as s')
    .select((eb) => [
      's.id',
      's.name',
      's.client_name',
      's.address_line_1',
      's.city',
      's.country',
      's.timezone',
      's.boundary_kind',
      's.latitude',
      's.longitude',
      's.geofence_radius_meters',
      's.polygon',
      's.status',
      's.notes',
      's.version',
      's.created_at',
      's.updated_at',
      eb
        .selectFrom('checkpoints as c')
        .select((c) => c.fn.countAll<string>().as('n'))
        .whereRef('c.site_id', '=', 's.id')
        .where('c.status', '<>', 'ARCHIVED')
        .as('checkpoint_count'),
    ])
    .where('s.organization_id', '=', organizationId);
}

type RawSite = Awaited<ReturnType<ReturnType<typeof siteQuery>['executeTakeFirstOrThrow']>>;

function toSite(r: RawSite): SiteRow {
  const center = { lat: r.latitude, lng: r.longitude };
  const boundary: SiteBoundary =
    r.boundary_kind === 'POLYGON'
      ? { kind: 'POLYGON', points: r.polygon as { lat: number; lng: number }[] }
      : { kind: 'CIRCLE', center, radiusM: r.geofence_radius_meters ?? 100 };
  return {
    id: r.id,
    name: r.name,
    clientName: r.client_name,
    addressLine1: r.address_line_1,
    city: r.city,
    country: r.country,
    timezone: r.timezone,
    boundary,
    center,
    status: r.status as SiteRow['status'],
    notes: r.notes,
    checkpointCount: Number(r.checkpoint_count ?? 0),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listSites(trx: Database, organizationId: string): Promise<SiteRow[]> {
  const rows = await siteQuery(trx, organizationId)
    .where('s.status', '<>', 'ARCHIVED')
    .orderBy('s.name')
    .orderBy('s.id')
    .execute();
  return rows.map(toSite);
}

export async function getSite(trx: Database, organizationId: string, id: string, forUpdate = false) {
  let query = siteQuery(trx, organizationId).where('s.id', '=', id);
  if (forUpdate) query = query.forUpdate('s');
  const row = await query.executeTakeFirst();
  return row ? toSite(row) : null;
}

export type SiteInput = {
  readonly name: string;
  readonly clientName: string | null;
  readonly addressLine1: string | null;
  readonly city: string | null;
  readonly country: string;
  readonly timezone: string;
  readonly boundary: SiteBoundary;
  readonly center: { lat: number; lng: number };
  readonly notes: string | null;
};

function boundaryColumns(boundary: SiteBoundary, center: { lat: number; lng: number }) {
  return boundary.kind === 'CIRCLE'
    ? {
        boundary_kind: 'CIRCLE',
        latitude: boundary.center.lat,
        longitude: boundary.center.lng,
        geofence_radius_meters: boundary.radiusM,
        polygon: null,
      }
    : {
        boundary_kind: 'POLYGON',
        latitude: center.lat,
        longitude: center.lng,
        geofence_radius_meters: null,
        polygon: JSON.stringify(boundary.points),
      };
}

export async function insertSite(
  trx: Database,
  input: SiteInput & { id: string; organizationId: string; userId: string; now: Date },
): Promise<void> {
  await trx
    .insertInto('sites')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      name: input.name,
      client_name: input.clientName,
      address_line_1: input.addressLine1,
      city: input.city,
      country: input.country,
      timezone: input.timezone,
      ...boundaryColumns(input.boundary, input.center),
      notes: input.notes,
      created_at: input.now,
      updated_at: input.now,
      created_by_user_id: input.userId,
      updated_by_user_id: input.userId,
    })
    .execute();
}

export async function updateSite(
  trx: Database,
  input: {
    organizationId: string;
    id: string;
    version: number;
    userId: string;
    now: Date;
    changes: Partial<Omit<SiteInput, 'center'>> & {
      center?: { lat: number; lng: number };
      status?: SiteRow['status'];
    };
  },
): Promise<boolean> {
  const c = input.changes;
  const result = await trx
    .updateTable('sites')
    .set({
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.clientName !== undefined ? { client_name: c.clientName } : {}),
      ...(c.addressLine1 !== undefined ? { address_line_1: c.addressLine1 } : {}),
      ...(c.city !== undefined ? { city: c.city } : {}),
      ...(c.timezone !== undefined ? { timezone: c.timezone } : {}),
      ...(c.notes !== undefined ? { notes: c.notes } : {}),
      ...(c.status !== undefined ? { status: c.status } : {}),
      ...(c.boundary && c.center ? boundaryColumns(c.boundary, c.center) : {}),
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

// ── Checkpoints ─────────────────────────────────────────────────────────────────────────────

export type CheckpointRow = {
  readonly id: string;
  readonly siteId: string;
  readonly name: string;
  readonly description: string | null;
  readonly location: { lat: number; lng: number } | null;
  readonly verificationRadiusM: number;
  readonly qrVersion: number;
  readonly qrRotatedAt: Date | null;
  readonly status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  readonly version: number;
};

function checkpointQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('checkpoints')
    .select([
      'id',
      'site_id',
      'name',
      'description',
      'latitude',
      'longitude',
      'verification_radius_meters',
      'qr_token_version',
      'qr_rotated_at',
      'status',
      'version',
    ])
    .where('organization_id', '=', organizationId);
}

type RawCheckpoint = Awaited<ReturnType<ReturnType<typeof checkpointQuery>['executeTakeFirstOrThrow']>>;

const toCheckpoint = (r: RawCheckpoint): CheckpointRow => ({
  id: r.id,
  siteId: r.site_id,
  name: r.name,
  description: r.description,
  location: r.latitude !== null && r.longitude !== null ? { lat: r.latitude, lng: r.longitude } : null,
  verificationRadiusM: r.verification_radius_meters,
  qrVersion: r.qr_token_version,
  qrRotatedAt: r.qr_rotated_at,
  status: r.status as CheckpointRow['status'],
  version: r.version,
});

export async function listCheckpoints(trx: Database, organizationId: string, siteId: string) {
  const rows = await checkpointQuery(trx, organizationId)
    .where('site_id', '=', siteId)
    .where('status', '<>', 'ARCHIVED')
    .orderBy('name')
    .orderBy('id')
    .execute();
  return rows.map(toCheckpoint);
}

export async function getCheckpoint(trx: Database, organizationId: string, id: string, forUpdate = false) {
  let query = checkpointQuery(trx, organizationId).where('id', '=', id);
  if (forUpdate) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row ? toCheckpoint(row) : null;
}

export async function insertCheckpoint(
  trx: Database,
  input: {
    id: string;
    organizationId: string;
    siteId: string;
    name: string;
    description: string | null;
    location: { lat: number; lng: number } | null;
    verificationRadiusM: number;
    qrTokenHash: Buffer;
    userId: string;
    now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('checkpoints')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      site_id: input.siteId,
      name: input.name,
      description: input.description,
      latitude: input.location?.lat ?? null,
      longitude: input.location?.lng ?? null,
      verification_radius_meters: input.verificationRadiusM,
      qr_token_hash: input.qrTokenHash,
      created_at: input.now,
      updated_at: input.now,
      created_by_user_id: input.userId,
      updated_by_user_id: input.userId,
    })
    .execute();
}

export async function updateCheckpoint(
  trx: Database,
  input: {
    organizationId: string;
    id: string;
    version: number;
    userId: string;
    now: Date;
    changes: {
      name?: string;
      description?: string | null;
      location?: { lat: number; lng: number } | null;
      verificationRadiusM?: number;
      status?: CheckpointRow['status'];
      qr?: { hash: Buffer; version: number };
    };
  },
): Promise<boolean> {
  const c = input.changes;
  const result = await trx
    .updateTable('checkpoints')
    .set({
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.location !== undefined
        ? { latitude: c.location?.lat ?? null, longitude: c.location?.lng ?? null }
        : {}),
      ...(c.verificationRadiusM !== undefined ? { verification_radius_meters: c.verificationRadiusM } : {}),
      ...(c.status !== undefined ? { status: c.status } : {}),
      ...(c.qr ? { qr_token_hash: c.qr.hash, qr_token_version: c.qr.version, qr_rotated_at: input.now } : {}),
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

/** The checkpoint a token belongs to, in any organization; the caller then checks the tenant. */
export async function checkpointByTokenHash(db: Database, hash: Buffer) {
  const { rows } = await sql<{ id: string; organization_id: string }>`
    select * from app.checkpoint_by_token(${hash})`.execute(db);
  return rows[0] ?? null;
}
