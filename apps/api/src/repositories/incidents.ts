// Incidents, their events and photos (ARCH §6.3, §12; PROD §10). Always inside a tenant
// transaction, except the attachment sweep, which runs as system_worker and reads organization IDs.
import type { Database } from '@sentryops/db';

export type IncidentRow = {
  readonly id: string;
  readonly referenceNumber: number;
  readonly guardId: string | null;
  readonly guardName: string | null;
  readonly reportedByUserId: string | null;
  readonly reportedByName: string | null;
  readonly shiftId: string | null;
  readonly sosEventId: string | null;
  readonly siteId: string | null;
  readonly siteName: string | null;
  readonly siteTimezone: string | null;
  readonly checkpointId: string | null;
  readonly checkpointName: string | null;
  readonly type: string;
  readonly severity: string;
  readonly title: string;
  readonly description: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracyM: number | null;
  readonly isMock: boolean | null;
  readonly occurredAt: Date;
  readonly reportedAt: Date;
  readonly receivedAt: Date;
  readonly status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  readonly acknowledgedBy: string | null;
  readonly acknowledgedByName: string | null;
  readonly acknowledgedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolvedByName: string | null;
  readonly resolvedAt: Date | null;
  readonly resolutionNote: string | null;
  readonly isDrill: boolean;
  readonly clientEventId: string | null;
  readonly photoCount: number;
  readonly version: number;
};

function incidentQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('incidents as i')
    .leftJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 'i.organization_id').onRef('g.id', '=', 'i.guard_id'),
    )
    .leftJoin('sites as s', (j) =>
      j.onRef('s.organization_id', '=', 'i.organization_id').onRef('s.id', '=', 'i.site_id'),
    )
    .leftJoin('checkpoints as c', (j) =>
      j.onRef('c.organization_id', '=', 'i.organization_id').onRef('c.id', '=', 'i.checkpoint_id'),
    )
    .leftJoin('users as ur', 'ur.id', 'i.reported_by_user_id')
    .leftJoin('users as ua', 'ua.id', 'i.acknowledged_by')
    .leftJoin('users as uz', 'uz.id', 'i.resolved_by')
    .where('i.organization_id', '=', organizationId)
    .select((eb) => [
      'i.id',
      'i.reference_number',
      'i.guard_id',
      'g.display_name as guard_name',
      'i.reported_by_user_id',
      'ur.name as reported_by_name',
      'i.shift_id',
      'i.sos_event_id',
      'i.site_id',
      's.name as site_name',
      's.timezone as site_timezone',
      'i.checkpoint_id',
      'c.name as checkpoint_name',
      'i.type',
      'i.severity',
      'i.title',
      'i.description',
      'i.latitude',
      'i.longitude',
      'i.accuracy_m',
      'i.is_mock',
      'i.occurred_at',
      'i.reported_at',
      'i.received_at',
      'i.status',
      'i.acknowledged_by',
      'ua.name as acknowledged_by_name',
      'i.acknowledged_at',
      'i.resolved_by',
      'uz.name as resolved_by_name',
      'i.resolved_at',
      'i.resolution_note',
      'i.is_drill',
      'i.client_event_id',
      'i.version',
      eb
        .selectFrom('incident_attachments as a')
        .whereRef('a.organization_id', '=', 'i.organization_id')
        .whereRef('a.incident_id', '=', 'i.id')
        .where('a.status', '<>', 'REJECTED')
        .select((x) => x.fn.countAll<string>().as('n'))
        .as('photo_count'),
    ]);
}

type RawIncident = Awaited<ReturnType<ReturnType<typeof incidentQuery>['executeTakeFirstOrThrow']>>;

function toIncident(r: RawIncident): IncidentRow {
  return {
    id: r.id,
    referenceNumber: r.reference_number,
    guardId: r.guard_id,
    guardName: r.guard_name,
    reportedByUserId: r.reported_by_user_id,
    reportedByName: r.reported_by_name,
    shiftId: r.shift_id,
    sosEventId: r.sos_event_id,
    siteId: r.site_id,
    siteName: r.site_name,
    siteTimezone: r.site_timezone,
    checkpointId: r.checkpoint_id,
    checkpointName: r.checkpoint_name,
    type: r.type,
    severity: r.severity,
    title: r.title,
    description: r.description,
    latitude: r.latitude,
    longitude: r.longitude,
    accuracyM: r.accuracy_m,
    isMock: r.is_mock,
    occurredAt: r.occurred_at,
    reportedAt: r.reported_at,
    receivedAt: r.received_at,
    status: r.status as IncidentRow['status'],
    acknowledgedBy: r.acknowledged_by,
    acknowledgedByName: r.acknowledged_by_name,
    acknowledgedAt: r.acknowledged_at,
    resolvedBy: r.resolved_by,
    resolvedByName: r.resolved_by_name,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    isDrill: r.is_drill,
    clientEventId: r.client_event_id,
    photoCount: Number(r.photo_count ?? 0),
    version: r.version,
  };
}

export async function getIncident(trx: Database, organizationId: string, id: string, forUpdate = false) {
  let q = incidentQuery(trx, organizationId).where('i.id', '=', id);
  if (forUpdate) q = q.forUpdate('i');
  const row = await q.executeTakeFirst();
  return row ? toIncident(row) : null;
}

export async function incidentByClientEvent(
  trx: Database,
  organizationId: string,
  deviceId: string,
  clientEventId: string,
) {
  const row = await incidentQuery(trx, organizationId)
    .where('i.device_id', '=', deviceId)
    .where('i.client_event_id', '=', clientEventId)
    .executeTakeFirst();
  return row ? toIncident(row) : null;
}

/** A guard's own report by the phone's id, whichever of the guard's phones filed it. */
export async function guardIncidentByClientEvent(
  trx: Database,
  organizationId: string,
  guardId: string,
  clientEventId: string,
) {
  const row = await incidentQuery(trx, organizationId)
    .where('i.guard_id', '=', guardId)
    .where('i.client_event_id', '=', clientEventId)
    .executeTakeFirst();
  return row ? toIncident(row) : null;
}

export type IncidentFilter = {
  status: 'open' | 'resolved' | 'all';
  severity?: string | undefined;
  type?: string | undefined;
  siteId?: string | undefined;
  guardId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
};

export async function listIncidents(trx: Database, organizationId: string, f: IncidentFilter) {
  let q = incidentQuery(trx, organizationId);
  if (f.status === 'open') q = q.where('i.status', 'in', ['OPEN', 'ACKNOWLEDGED']);
  if (f.status === 'resolved') q = q.where('i.status', '=', 'RESOLVED');
  if (f.severity) q = q.where('i.severity', '=', f.severity);
  if (f.type) q = q.where('i.type', '=', f.type);
  if (f.siteId) q = q.where('i.site_id', '=', f.siteId);
  if (f.guardId) q = q.where('i.guard_id', '=', f.guardId);
  if (f.from) q = q.where('i.occurred_at', '>=', f.from);
  if (f.to) q = q.where('i.occurred_at', '<', f.to);
  const rows = await q.orderBy('i.created_at', 'desc').orderBy('i.id', 'desc').limit(f.limit).execute();
  return rows.map(toIncident);
}

/** The guard's own reports since `since`, newest first (GET /me/incidents). */
export async function guardIncidents(trx: Database, organizationId: string, guardId: string, since: Date) {
  const rows = await incidentQuery(trx, organizationId)
    .where('i.guard_id', '=', guardId)
    .where('i.received_at', '>=', since)
    .orderBy('i.received_at', 'desc')
    .limit(50)
    .execute();
  return rows.map(toIncident);
}

export async function incidentsByIds(trx: Database, organizationId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await incidentQuery(trx, organizationId).where('i.id', 'in', ids).execute();
  return rows.map(toIncident);
}

/** SEC §9: incidents per guard per hour, counted from what arrived (sync answers RETRY beyond it). */
export async function incidentsReceivedSince(
  trx: Database,
  organizationId: string,
  guardId: string,
  since: Date,
): Promise<number> {
  const row = await trx
    .selectFrom('incidents')
    .where('organization_id', '=', organizationId)
    .where('guard_id', '=', guardId)
    .where('received_at', '>=', since)
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function openIncidentCount(trx: Database, organizationId: string): Promise<number> {
  const row = await trx
    .selectFrom('incidents')
    .where('organization_id', '=', organizationId)
    .where('status', 'in', ['OPEN', 'ACKNOWLEDGED'])
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** The next reference number (INC-000123), taken under the organization's counter row lock. */
export async function nextIncidentNumber(trx: Database, organizationId: string, id: string): Promise<number> {
  const row = await trx
    .insertInto('incident_counters')
    .values({ id, organization_id: organizationId, next_value: 2 })
    .onConflict((oc) =>
      oc
        .column('organization_id')
        .doUpdateSet((eb) => ({ next_value: eb('incident_counters.next_value', '+', 1) })),
    )
    .returning('next_value')
    .executeTakeFirstOrThrow();
  return row.next_value - 1;
}

export type IncidentInsert = {
  readonly id: string;
  readonly organizationId: string;
  readonly referenceNumber: number;
  readonly guardId: string | null;
  readonly reportedByUserId: string | null;
  readonly shiftId: string | null;
  readonly sosEventId: string | null;
  readonly siteId: string | null;
  readonly checkpointId: string | null;
  readonly type: string;
  readonly severity: string;
  readonly title: string;
  readonly description: string;
  readonly location: {
    lat: number;
    lng: number;
    accuracyM: number | null;
    fixAgeS: number | null;
    isMock: boolean | null;
  } | null;
  readonly occurredAt: Date;
  readonly reportedAt: Date;
  readonly reportedAtRecorded: Date | null;
  readonly receivedAt: Date;
  readonly isDrill: boolean;
  readonly deviceId: string | null;
  readonly clientEventId: string | null;
};

export async function insertIncident(trx: Database, i: IncidentInsert): Promise<boolean> {
  const row = await trx
    .insertInto('incidents')
    .values({
      id: i.id,
      organization_id: i.organizationId,
      reference_number: i.referenceNumber,
      guard_id: i.guardId,
      reported_by_user_id: i.reportedByUserId,
      shift_id: i.shiftId,
      sos_event_id: i.sosEventId,
      site_id: i.siteId,
      checkpoint_id: i.checkpointId,
      type: i.type,
      severity: i.severity,
      title: i.title,
      description: i.description,
      latitude: i.location?.lat ?? null,
      longitude: i.location?.lng ?? null,
      accuracy_m: i.location?.accuracyM ?? null,
      fix_age_s: i.location?.fixAgeS ?? null,
      is_mock: i.location?.isMock ?? null,
      occurred_at: i.occurredAt,
      reported_at: i.reportedAt,
      reported_at_recorded: i.reportedAtRecorded,
      received_at: i.receivedAt,
      is_drill: i.isDrill,
      device_id: i.deviceId,
      client_event_id: i.clientEventId,
      created_at: i.receivedAt,
      updated_at: i.receivedAt,
    })
    .onConflict((oc) =>
      oc.columns(['device_id', 'client_event_id']).where('client_event_id', 'is not', null).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** Only status, severity and type can change (column grants, INV-05); the submission never does. */
export async function updateIncident(
  trx: Database,
  organizationId: string,
  id: string,
  changes: {
    type?: string;
    severity?: string;
    status?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
    acknowledgedBy?: string | null;
    acknowledgedAt?: Date | null;
    resolvedBy?: string | null;
    resolvedAt?: Date | null;
    resolutionNote?: string | null;
  },
  now: Date,
): Promise<void> {
  await trx
    .updateTable('incidents')
    .set((eb) => ({
      ...(changes.type !== undefined ? { type: changes.type } : {}),
      ...(changes.severity !== undefined ? { severity: changes.severity } : {}),
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.acknowledgedBy !== undefined ? { acknowledged_by: changes.acknowledgedBy } : {}),
      ...(changes.acknowledgedAt !== undefined ? { acknowledged_at: changes.acknowledgedAt } : {}),
      ...(changes.resolvedBy !== undefined ? { resolved_by: changes.resolvedBy } : {}),
      ...(changes.resolvedAt !== undefined ? { resolved_at: changes.resolvedAt } : {}),
      ...(changes.resolutionNote !== undefined ? { resolution_note: changes.resolutionNote } : {}),
      version: eb('version', '+', 1),
      updated_at: now,
    }))
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

export type IncidentEventInsert = {
  readonly id: string;
  readonly organizationId: string;
  readonly incidentId: string;
  readonly type:
    | 'CREATED'
    | 'NOTE_ADDED'
    | 'STATUS_CHANGED'
    | 'SEVERITY_CHANGED'
    | 'TYPE_CHANGED'
    | 'ATTACHMENT_ADDED'
    | 'ATTACHMENT_REJECTED';
  readonly actor: { type: 'GUARD'; guardId: string } | { type: 'USER'; userId: string } | { type: 'SYSTEM' };
  readonly body?: string | null;
  readonly fromValue?: string | null;
  readonly toValue?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly deviceId?: string | null;
  readonly clientEventId?: string | null;
  readonly at: Date;
};

/** True when inserted; false when the phone already sent this note (INV-06). */
export async function insertIncidentEvent(trx: Database, e: IncidentEventInsert): Promise<boolean> {
  const row = await trx
    .insertInto('incident_events')
    .values({
      id: e.id,
      organization_id: e.organizationId,
      incident_id: e.incidentId,
      type: e.type,
      actor_type: e.actor.type,
      actor_user_id: e.actor.type === 'USER' ? e.actor.userId : null,
      actor_guard_id: e.actor.type === 'GUARD' ? e.actor.guardId : null,
      body: e.body ?? null,
      from_value: e.fromValue ?? null,
      to_value: e.toValue ?? null,
      payload: JSON.stringify(e.payload ?? {}),
      device_id: e.deviceId ?? null,
      client_event_id: e.clientEventId ?? null,
      created_at: e.at,
    })
    .onConflict((oc) =>
      oc.columns(['device_id', 'client_event_id']).where('client_event_id', 'is not', null).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export async function incidentEvents(trx: Database, organizationId: string, incidentIds: readonly string[]) {
  if (incidentIds.length === 0) return [];
  return trx
    .selectFrom('incident_events as e')
    .leftJoin('users as u', 'u.id', 'e.actor_user_id')
    .leftJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 'e.organization_id').onRef('g.id', '=', 'e.actor_guard_id'),
    )
    .where('e.organization_id', '=', organizationId)
    .where('e.incident_id', 'in', [...incidentIds])
    .select([
      'e.id',
      'e.incident_id',
      'e.type',
      'e.actor_type',
      'e.actor_guard_id',
      'u.name as user_name',
      'g.display_name as guard_name',
      'e.body',
      'e.from_value',
      'e.to_value',
      'e.payload',
      'e.created_at',
    ])
    .orderBy('e.created_at')
    .orderBy('e.id')
    .execute();
}

// ── Photos ────────────────────────────────────────────────────────────────────────────────────

export type AttachmentRow = {
  readonly id: string;
  readonly incidentId: string;
  readonly clientEventId: string;
  readonly guardId: string | null;
  readonly captureSource: 'IN_APP_CAMERA' | 'GALLERY';
  readonly declaredType: string;
  readonly declaredSize: number;
  readonly originalKey: string;
  readonly viewKey: string;
  readonly status: 'PENDING_UPLOAD' | 'PROCESSING' | 'AVAILABLE' | 'REJECTED';
  readonly sha256: Buffer | null;
  readonly detectedType: string | null;
  readonly sizeBytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly exifCapturedAt: Date | null;
  readonly rejectionReason: string | null;
  readonly uploadExpiresAt: Date;
  readonly createdAt: Date;
};

const attachmentColumns = [
  'id',
  'incident_id',
  'client_event_id',
  'guard_id',
  'capture_source',
  'declared_type',
  'declared_size',
  'original_key',
  'view_key',
  'status',
  'sha256',
  'detected_type',
  'size_bytes',
  'width',
  'height',
  'exif_captured_at',
  'rejection_reason',
  'upload_expires_at',
  'created_at',
] as const;

type RawAttachment = {
  id: string;
  incident_id: string;
  client_event_id: string;
  guard_id: string | null;
  capture_source: string;
  declared_type: string;
  declared_size: number;
  original_key: string;
  view_key: string;
  status: string;
  sha256: Buffer | null;
  detected_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  exif_captured_at: Date | null;
  rejection_reason: string | null;
  upload_expires_at: Date;
  created_at: Date;
};

function toAttachment(r: RawAttachment): AttachmentRow {
  return {
    id: r.id,
    incidentId: r.incident_id,
    clientEventId: r.client_event_id,
    guardId: r.guard_id,
    captureSource: r.capture_source === 'GALLERY' ? 'GALLERY' : 'IN_APP_CAMERA',
    declaredType: r.declared_type,
    declaredSize: r.declared_size,
    originalKey: r.original_key,
    viewKey: r.view_key,
    status: r.status as AttachmentRow['status'],
    sha256: r.sha256,
    detectedType: r.detected_type,
    sizeBytes: r.size_bytes,
    width: r.width,
    height: r.height,
    exifCapturedAt: r.exif_captured_at,
    rejectionReason: r.rejection_reason,
    uploadExpiresAt: r.upload_expires_at,
    createdAt: r.created_at,
  };
}

export async function attachmentsFor(trx: Database, organizationId: string, incidentIds: readonly string[]) {
  if (incidentIds.length === 0) return [];
  const rows = await trx
    .selectFrom('incident_attachments')
    .where('organization_id', '=', organizationId)
    .where('incident_id', 'in', [...incidentIds])
    .select([...attachmentColumns])
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(toAttachment);
}

export async function getAttachment(trx: Database, organizationId: string, id: string, forUpdate = false) {
  let q = trx
    .selectFrom('incident_attachments')
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .select([...attachmentColumns]);
  if (forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return row ? toAttachment(row) : null;
}

export async function attachmentByClientEvent(
  trx: Database,
  organizationId: string,
  incidentId: string,
  clientEventId: string,
) {
  const row = await trx
    .selectFrom('incident_attachments')
    .where('organization_id', '=', organizationId)
    .where('incident_id', '=', incidentId)
    .where('client_event_id', '=', clientEventId)
    .select([...attachmentColumns])
    .executeTakeFirst();
  return row ? toAttachment(row) : null;
}

export async function insertAttachment(
  trx: Database,
  a: {
    id: string;
    organizationId: string;
    incidentId: string;
    clientEventId: string;
    guardId: string | null;
    deviceId: string | null;
    captureSource: string;
    declaredType: string;
    declaredSize: number;
    originalKey: string;
    viewKey: string;
    uploadExpiresAt: Date;
    now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('incident_attachments')
    .values({
      id: a.id,
      organization_id: a.organizationId,
      incident_id: a.incidentId,
      client_event_id: a.clientEventId,
      guard_id: a.guardId,
      device_id: a.deviceId,
      capture_source: a.captureSource,
      declared_type: a.declaredType,
      declared_size: a.declaredSize,
      original_key: a.originalKey,
      view_key: a.viewKey,
      status: 'PENDING_UPLOAD',
      upload_expires_at: a.uploadExpiresAt,
      created_at: a.now,
      updated_at: a.now,
    })
    .execute();
}

export async function updateAttachment(
  trx: Database,
  organizationId: string,
  id: string,
  changes: {
    status?: AttachmentRow['status'];
    sha256?: Buffer;
    detectedType?: string;
    sizeBytes?: number;
    width?: number;
    height?: number;
    exifCapturedAt?: Date | null;
    exifLatitude?: number | null;
    exifLongitude?: number | null;
    rejectionReason?: string;
    uploadExpiresAt?: Date;
    completedAt?: Date;
    processedAt?: Date;
  },
  now: Date,
): Promise<void> {
  await trx
    .updateTable('incident_attachments')
    .set({
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.sha256 !== undefined ? { sha256: changes.sha256 } : {}),
      ...(changes.detectedType !== undefined ? { detected_type: changes.detectedType } : {}),
      ...(changes.sizeBytes !== undefined ? { size_bytes: changes.sizeBytes } : {}),
      ...(changes.width !== undefined ? { width: changes.width } : {}),
      ...(changes.height !== undefined ? { height: changes.height } : {}),
      ...(changes.exifCapturedAt !== undefined ? { exif_captured_at: changes.exifCapturedAt } : {}),
      ...(changes.exifLatitude !== undefined ? { exif_latitude: changes.exifLatitude } : {}),
      ...(changes.exifLongitude !== undefined ? { exif_longitude: changes.exifLongitude } : {}),
      ...(changes.rejectionReason !== undefined ? { rejection_reason: changes.rejectionReason } : {}),
      ...(changes.uploadExpiresAt !== undefined ? { upload_expires_at: changes.uploadExpiresAt } : {}),
      ...(changes.completedAt !== undefined ? { completed_at: changes.completedAt } : {}),
      ...(changes.processedAt !== undefined ? { processed_at: changes.processedAt } : {}),
      updated_at: now,
    })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

export async function organizationsWithAttachmentsToProcess(sweep: Database): Promise<string[]> {
  const rows = await sweep
    .selectFrom('incident_attachments')
    .where('status', '=', 'PROCESSING')
    .select('organization_id')
    .distinct()
    .execute();
  return rows.map((r) => r.organization_id);
}

/** Photos waiting for the processor, locked so two workers never check the same one. */
export async function attachmentsToProcess(trx: Database, organizationId: string, limit: number) {
  const rows = await trx
    .selectFrom('incident_attachments')
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'PROCESSING')
    .select([...attachmentColumns])
    .orderBy('updated_at')
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();
  return rows.map(toAttachment);
}
