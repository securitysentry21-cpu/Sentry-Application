// Location points, device status, the live-state projection and quarantined items (ARCH §6.3, §9).
import type { Database } from '@sentryops/db';
import { sql } from 'kysely';

// Per-item savepoints (ARCH §9.3): one bad item rolls back alone; the batch commits.
export async function savepoint(trx: Database, name: string): Promise<void> {
  await sql`savepoint ${sql.id(name)}`.execute(trx);
}
export async function releaseSavepoint(trx: Database, name: string): Promise<void> {
  await sql`release savepoint ${sql.id(name)}`.execute(trx);
}
export async function rollbackToSavepoint(trx: Database, name: string): Promise<void> {
  await sql`rollback to savepoint ${sql.id(name)}`.execute(trx);
}

export type PointRow = {
  id: string;
  organizationId: string;
  guardId: string;
  shiftId: string | null;
  deviceId: string;
  clientEventId: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  altitudeM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  recordedAt: Date;
  capturedAt: Date;
  receivedAt: Date;
  clockStatus: 'VERIFIED_MONOTONIC' | 'DEVICE_CLOCK_ONLY' | 'SKEWED';
  source: 'TRACKING' | 'SHIFT_START' | 'SHIFT_END';
  provider: string | null;
  isMock: boolean | null;
  flags: string[];
  appVersion: string | null;
  batchId: string;
};

/** True when inserted; false when that device already sent this client event (INV-06). */
export async function insertPoint(trx: Database, p: PointRow): Promise<boolean> {
  const row = await trx
    .insertInto('location_points')
    .values({
      id: p.id,
      organization_id: p.organizationId,
      guard_id: p.guardId,
      shift_id: p.shiftId,
      device_id: p.deviceId,
      client_event_id: p.clientEventId,
      latitude: p.latitude,
      longitude: p.longitude,
      accuracy_m: p.accuracyM,
      altitude_m: p.altitudeM,
      speed_mps: p.speedMps,
      heading_deg: p.headingDeg,
      recorded_at: p.recordedAt,
      captured_at: p.capturedAt,
      received_at: p.receivedAt,
      clock_status: p.clockStatus,
      source: p.source,
      provider: p.provider,
      is_mock: p.isMock,
      flags: p.flags,
      app_version: p.appVersion,
      sync_batch_id: p.batchId,
      created_at: p.receivedAt,
    })
    .onConflict((oc) => oc.columns(['device_id', 'client_event_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export async function storedPoint(
  trx: Database,
  organizationId: string,
  deviceId: string,
  clientEventId: string,
) {
  return trx
    .selectFrom('location_points')
    .select(['latitude', 'longitude', 'recorded_at'])
    .where('organization_id', '=', organizationId)
    .where('device_id', '=', deviceId)
    .where('client_event_id', '=', clientEventId)
    .executeTakeFirst();
}

export async function insertDeviceStatus(
  trx: Database,
  input: {
    id: string;
    organizationId: string;
    guardId: string;
    deviceId: string;
    shiftId: string | null;
    clientEventId: string;
    recordedAt: Date;
    receivedAt: Date;
    status: {
      locationPermission: string;
      preciseLocation: boolean;
      locationServicesEnabled: boolean;
      notificationsEnabled?: boolean | undefined;
      batteryPct?: number | undefined;
      isCharging?: boolean | undefined;
      powerSaveMode?: boolean | undefined;
      batteryOptimizationExempt?: boolean | null | undefined;
      autoTimeEnabled?: boolean | null | undefined;
      trackingServiceState: string;
      osVersion?: string | undefined;
      pendingQueueCount?: number | undefined;
      oldestPendingAt?: string | null | undefined;
      lastSuccessfulSyncAt?: string | null | undefined;
    };
    appVersion: string | null;
  },
): Promise<boolean> {
  const s = input.status;
  const row = await trx
    .insertInto('device_status_events')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      guard_id: input.guardId,
      device_id: input.deviceId,
      shift_id: input.shiftId,
      client_event_id: input.clientEventId,
      recorded_at: input.recordedAt,
      received_at: input.receivedAt,
      location_permission: s.locationPermission,
      precise_location: s.preciseLocation,
      location_services_enabled: s.locationServicesEnabled,
      notifications_enabled: s.notificationsEnabled ?? null,
      battery_pct: s.batteryPct ?? null,
      is_charging: s.isCharging ?? null,
      power_save_mode: s.powerSaveMode ?? null,
      battery_optimization_exempt: s.batteryOptimizationExempt ?? null,
      auto_time_enabled: s.autoTimeEnabled ?? null,
      tracking_service_state: s.trackingServiceState,
      app_version: input.appVersion,
      os_version: s.osVersion ?? null,
      pending_queue_count: s.pendingQueueCount ?? null,
      oldest_pending_at: s.oldestPendingAt ? new Date(s.oldestPendingAt) : null,
      last_successful_sync_at: s.lastSuccessfulSyncAt ? new Date(s.lastSuccessfulSyncAt) : null,
      created_at: input.receivedAt,
    })
    .onConflict((oc) => oc.columns(['device_id', 'client_event_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

export type LiveKey = { organizationId: string; shiftId: string; guardId: string; siteId: string };

/** Creates the projection row if missing. */
async function ensureLive(trx: Database, key: LiveKey, now: Date): Promise<void> {
  await trx
    .insertInto('shift_live_state')
    .values({
      id: key.shiftId,
      organization_id: key.organizationId,
      guard_id: key.guardId,
      site_id: key.siteId,
      updated_at: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

/** Moves the last fix forward only: an older point arriving late never replaces a newer one (ADV-L06). */
export async function advanceLiveFix(
  trx: Database,
  key: LiveKey,
  fix: { lat: number; lng: number; accuracyM: number | null; capturedAt: Date; pointId: string },
  now: Date,
): Promise<void> {
  await ensureLive(trx, key, now);
  await trx
    .updateTable('shift_live_state')
    .set({
      last_fix_latitude: fix.lat,
      last_fix_longitude: fix.lng,
      last_fix_accuracy_m: fix.accuracyM,
      last_fix_captured_at: fix.capturedAt,
      last_fix_point_id: fix.pointId,
      updated_at: now,
    })
    .where('organization_id', '=', key.organizationId)
    .where('id', '=', key.shiftId)
    .where((eb) =>
      eb.or([eb('last_fix_captured_at', 'is', null), eb('last_fix_captured_at', '<', fix.capturedAt)]),
    )
    .execute();
}

/** Contact time (any heartbeat, status or point) only moves forward too. */
export async function advanceLiveContact(
  trx: Database,
  key: LiveKey,
  contactAt: Date,
  device?: {
    trackingServiceState: string;
    locationPermission: string;
    batteryPct: number | null;
    isCharging: boolean | null;
    pendingQueueCount: number | null;
    oldestPendingAt: Date | null;
    appVersion: string | null;
  },
): Promise<void> {
  await ensureLive(trx, key, contactAt);
  await trx
    .updateTable('shift_live_state')
    .set({ last_contact_at: contactAt, updated_at: contactAt })
    .where('organization_id', '=', key.organizationId)
    .where('id', '=', key.shiftId)
    .where((eb) => eb.or([eb('last_contact_at', 'is', null), eb('last_contact_at', '<', contactAt)]))
    .execute();
  if (device) {
    await trx
      .updateTable('shift_live_state')
      .set({
        tracking_service_state: device.trackingServiceState,
        location_permission: device.locationPermission,
        battery_pct: device.batteryPct,
        is_charging: device.isCharging,
        pending_queue_count: device.pendingQueueCount,
        oldest_pending_at: device.oldestPendingAt,
        app_version: device.appVersion,
        device_report_at: contactAt,
      })
      .where('organization_id', '=', key.organizationId)
      .where('id', '=', key.shiftId)
      .where((eb) => eb.or([eb('device_report_at', 'is', null), eb('device_report_at', '<=', contactAt)]))
      .execute();
  }
}

export async function liveFix(trx: Database, organizationId: string, shiftId: string) {
  return trx
    .selectFrom('shift_live_state')
    .select(['last_fix_latitude', 'last_fix_longitude', 'last_fix_captured_at'])
    .where('organization_id', '=', organizationId)
    .where('id', '=', shiftId)
    .executeTakeFirst();
}

export async function quarantine(
  trx: Database,
  input: {
    id: string;
    organizationId: string;
    deviceId: string;
    batchId: string;
    clientEventId: string;
    item: unknown;
    errorCode: string;
  },
): Promise<void> {
  await trx
    .insertInto('quarantined_items')
    .values({
      id: input.id,
      organization_id: input.organizationId,
      device_id: input.deviceId,
      batch_id: input.batchId,
      client_event_id: input.clientEventId.slice(0, 64),
      item: JSON.stringify(input.item),
      error_code: input.errorCode,
    })
    .execute();
}

/** Every ACTIVE shift with its live state, for the dashboard snapshot. Live coordinates only. */
export async function liveSnapshot(trx: Database, organizationId: string) {
  return trx
    .selectFrom('shifts as sh')
    .innerJoin('guards as g', (j) =>
      j.onRef('g.organization_id', '=', 'sh.organization_id').onRef('g.id', '=', 'sh.guard_id'),
    )
    .innerJoin('sites as s', (j) =>
      j.onRef('s.organization_id', '=', 'sh.organization_id').onRef('s.id', '=', 'sh.site_id'),
    )
    .leftJoin('shift_live_state as l', (j) =>
      j.onRef('l.organization_id', '=', 'sh.organization_id').onRef('l.id', '=', 'sh.id'),
    )
    .select([
      'sh.id as shift_id',
      'sh.guard_id',
      'g.display_name',
      'g.employee_number',
      'sh.site_id',
      's.name as site_name',
      'sh.actual_started_at',
      'sh.ends_at',
      'sh.start_source',
      'sh.start_flags',
      'l.last_fix_latitude',
      'l.last_fix_longitude',
      'l.last_fix_accuracy_m',
      'l.last_fix_captured_at',
      'l.last_contact_at',
      'l.tracking_service_state',
      'l.location_permission',
      'l.battery_pct',
      'l.is_charging',
      'l.pending_queue_count',
    ])
    .where('sh.organization_id', '=', organizationId)
    .where('sh.status', '=', 'ACTIVE')
    .orderBy('g.display_name')
    .limit(5000)
    .execute();
}
