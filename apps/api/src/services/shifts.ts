// The shift service (PROD §6, ARCH §7). Every state change goes through the pure state machine in
// packages/domain, inside the caller's tenant transaction, with a shift event, and an audit record
// when a person made it. Guard start and end are shared by the online endpoints and, from Phase 4,
// by /sync/batch, so offline and online starts are judged by the same rules.
import type { ErrorCode, Fix } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import {
  classifyFix,
  distanceToPolygonEdgeM,
  haversineM,
  pointInPolygon,
  transition,
  type ShiftCommand,
  type ShiftSettings,
} from '@sentryops/domain';

import type { AppDeps } from '../deps.ts';
import { uuidv7 } from '../ids.ts';
import { numberSetting, organizationSettings } from '../repositories/organizations.ts';
import {
  activeShiftsForGuard,
  eventByClientId,
  getShift,
  insertShiftEvent,
  otherActiveShift,
  updateShift,
  type ShiftRow,
  type ShiftUpdate,
} from '../repositories/shifts.ts';

export type FullShiftSettings = ShiftSettings & {
  readonly missedAfterMinutes: number;
  readonly startMaxFixAgeSeconds: number;
  readonly startRequiredAccuracyM: number;
  readonly requireBackgroundPermission: 'BLOCK' | 'WARN';
  readonly startOutsideGeofence: 'ALLOW_AND_FLAG' | 'BLOCK';
  readonly outsideBufferM: number;
};

export function shiftSettingsFrom(settings: Record<string, unknown>): FullShiftSettings {
  return {
    earliestStartMinutes: numberSetting(settings, 'shift.earliest_start_minutes', 30),
    missedAfterMinutes: numberSetting(settings, 'shift.missed_after_minutes', 120),
    autoEndAfterMinutes: numberSetting(settings, 'shift.auto_end_after_minutes', 60),
    startMaxFixAgeSeconds: numberSetting(settings, 'shift.start_max_fix_age_seconds', 120),
    startRequiredAccuracyM: numberSetting(settings, 'shift.start_required_accuracy_m', 100),
    requireBackgroundPermission:
      settings['shift.require_background_permission'] === 'WARN' ? 'WARN' : 'BLOCK',
    startOutsideGeofence: settings['shift.start_outside_geofence'] === 'BLOCK' ? 'BLOCK' : 'ALLOW_AND_FLAG',
    outsideBufferM: numberSetting(settings, 'geofence.outside_buffer_m', 25),
  };
}

export async function loadShiftSettings(trx: Database, organizationId: string): Promise<FullShiftSettings> {
  return shiftSettingsFrom(await organizationSettings(trx, organizationId));
}

export function shiftDto(s: ShiftRow) {
  return {
    id: s.id,
    guard: { id: s.guardId, displayName: s.guardName, employeeNumber: s.employeeNumber },
    site: { id: s.siteId, name: s.siteName, timezone: s.siteTimezone },
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    startDeadlineAt: s.startDeadlineAt.toISOString(),
    status: s.status,
    actualStartedAt: s.actualStartedAt?.toISOString() ?? null,
    actualEndedAt: s.actualEndedAt?.toISOString() ?? null,
    startSource: s.startSource,
    startGeofenceClass: s.startGeofenceClass,
    startDistanceM: s.startDistanceM,
    startFlags: s.startFlags,
    endReason: s.endReason,
    cancelledReason: s.cancelledReason,
    notes: s.notes,
    version: s.version,
  };
}

export function guardShiftDto(s: ShiftRow) {
  return {
    id: s.id,
    status: s.status,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    startDeadlineAt: s.startDeadlineAt.toISOString(),
    actualStartedAt: s.actualStartedAt?.toISOString() ?? null,
    actualEndedAt: s.actualEndedAt?.toISOString() ?? null,
    site: { id: s.siteId, name: s.siteName, timezone: s.siteTimezone, boundary: s.siteBoundary },
    version: s.version,
  };
}

/** Metres from the boundary when outside; 0 inside. */
function distanceOutside(shift: ShiftRow, fix: { lat: number; lng: number }): number {
  const b = shift.siteBoundary;
  if (b.kind === 'CIRCLE') return Math.max(0, haversineM(b.center, fix) - b.radiusM);
  return pointInPolygon(fix, b.points) ? 0 : distanceToPolygonEdgeM(fix, b.points);
}

export type GuardRef = {
  readonly organizationId: string;
  readonly guardId: string;
  readonly deviceId: string;
  readonly userId: string | null;
};

export type GuardOutcome =
  | { readonly status: 'ACCEPTED' | 'DUPLICATE'; readonly shift: ShiftRow }
  | { readonly status: 'REJECTED'; readonly code: ErrorCode; readonly shift: ShiftRow | null };

export type GuardStartInput = {
  readonly shiftId: string;
  readonly clientEventId: string;
  readonly recordedAt: Date;
  /** Server receipt time online; the server-estimated capture time when synced (INV-07). */
  readonly capturedAt: Date;
  readonly offline: boolean;
  readonly fix: Fix | null;
  readonly permission: { readonly location: string; readonly precise: boolean };
  /** Extra flags from ingestion, e.g. SKEWED_CLOCK on an offline start. */
  readonly flags?: readonly string[];
};

/**
 * PROD §6.4, in order. Steps 1–2 (authenticated guard, ACTIVE device) are the request context's.
 * A repeat with the same client event ID returns the original outcome, rejection included (SH02).
 */
export async function guardStart(
  trx: Database,
  deps: AppDeps,
  guard: GuardRef,
  input: GuardStartInput,
): Promise<GuardOutcome> {
  const now = deps.clock.now();
  const shift = await getShift(trx, guard.organizationId, input.shiftId, true);
  // 3. Another guard's shift (or another organization's) is "not found" (ADV-A03).
  if (!shift || shift.guardId !== guard.guardId)
    return { status: 'REJECTED', code: 'NOT_FOUND', shift: null };
  const previous = await eventByClientId(trx, guard.organizationId, shift.id, input.clientEventId);
  if (previous) {
    if (previous.type === 'STARTED') return { status: 'DUPLICATE', shift };
    const code = (previous.payload as { code?: ErrorCode }).code ?? 'SHIFT_INVALID_TRANSITION';
    return { status: 'REJECTED', code, shift };
  }
  const settings = await loadShiftSettings(trx, guard.organizationId);

  const reject = async (code: ErrorCode): Promise<GuardOutcome> => {
    // The attempt is history; its coordinates are not (INV-08, ADV-P05).
    await insertShiftEvent(trx, {
      id: uuidv7(deps.clock),
      organizationId: guard.organizationId,
      shiftId: shift.id,
      type: 'START_REJECTED',
      actorType: 'GUARD',
      actorUserId: guard.userId,
      deviceId: guard.deviceId,
      clientEventId: input.clientEventId,
      occurredAt: now,
      clientRecordedAt: input.recordedAt,
      payload: { code, offline: input.offline, hadFix: input.fix !== null },
    });
    return { status: 'REJECTED', code, shift };
  };

  // 4–5. State and start window, by the state machine.
  const command: ShiftCommand = { type: 'GUARD_START', capturedAt: input.capturedAt, offline: input.offline };
  const result = transition(shift, command, 'GUARD', now, settings);
  if (!result.ok)
    return reject(result.code === 'VALIDATION_FAILED' ? 'SHIFT_INVALID_TRANSITION' : result.code);
  // 6. One active shift at a time.
  if (await otherActiveShift(trx, guard.organizationId, guard.guardId, shift.id))
    return reject('SHIFT_INVALID_TRANSITION');
  // 7. A fresh fix is the evidence; the server can't check the phone's permissions directly.
  const fix = input.fix;
  if (!fix || (fix.fixAgeS ?? 0) > settings.startMaxFixAgeSeconds) return reject('LOCATION_FIX_REQUIRED');
  const flags = new Set<string>(input.flags ?? []);
  if (input.offline) flags.add('OFFLINE_START');
  if (result.changes.lateSync) flags.add('LATE_SYNC');
  // 8. Phone-reported permission.
  if (input.permission.location !== 'ALWAYS' || !input.permission.precise) {
    if (settings.requireBackgroundPermission === 'BLOCK') return reject('TRACKING_PERMISSION_REQUIRED');
    flags.add('PERMISSION_NOT_ALWAYS');
  }
  // 9. Accuracy is flagged, never blocking.
  if (fix.accuracyM === null || fix.accuracyM > settings.startRequiredAccuracyM)
    flags.add('LOW_ACCURACY_START');
  if (fix.isMock) flags.add('MOCK_LOCATION');
  // 10. Off-site start: allowed and flagged by default (D-15).
  const point = { lat: fix.lat, lng: fix.lon };
  const geofenceClass = classifyFix(
    shift.siteBoundary.kind === 'CIRCLE'
      ? { kind: 'CIRCLE', center: shift.siteBoundary.center, radiusM: shift.siteBoundary.radiusM }
      : { kind: 'POLYGON', points: shift.siteBoundary.points },
    point,
    fix.accuracyM,
    settings.outsideBufferM,
  );
  if (geofenceClass === 'OUTSIDE') {
    if (settings.startOutsideGeofence === 'BLOCK') return reject('STARTED_OFF_SITE_BLOCKED');
    flags.add('OFF_SITE_START');
  }

  const changes: ShiftUpdate = {
    status: 'ACTIVE',
    actualStartedAt: input.offline ? input.capturedAt : now,
    startSource: input.offline ? 'APP_OFFLINE_SYNCED' : 'APP_ONLINE',
    start: { lat: fix.lat, lng: fix.lon, accuracyM: fix.accuracyM },
    startDistanceM: Math.round(distanceOutside(shift, point)),
    startGeofenceClass: geofenceClass,
    startDeviceId: guard.deviceId,
    startFlags: [...flags].sort(),
  };
  await updateShift(trx, {
    organizationId: guard.organizationId,
    id: shift.id,
    version: shift.version,
    userId: null,
    now,
    changes,
  });
  await insertShiftEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId: guard.organizationId,
    shiftId: shift.id,
    type: 'STARTED',
    actorType: 'GUARD',
    actorUserId: guard.userId,
    deviceId: guard.deviceId,
    clientEventId: input.clientEventId,
    occurredAt: now,
    clientRecordedAt: input.recordedAt,
    payload: {
      source: changes.startSource,
      flags: changes.startFlags,
      geofenceClass,
      distanceM: changes.startDistanceM,
    },
  });
  const updated = await getShift(trx, guard.organizationId, shift.id);
  return { status: 'ACCEPTED', shift: updated ?? shift };
}

export type GuardEndInput = {
  readonly shiftId: string;
  readonly clientEventId: string;
  readonly recordedAt: Date;
  readonly capturedAt: Date;
  readonly offline: boolean;
  readonly fix: Fix | null;
};

export async function guardEnd(
  trx: Database,
  deps: AppDeps,
  guard: GuardRef,
  input: GuardEndInput,
): Promise<GuardOutcome> {
  const now = deps.clock.now();
  const shift = await getShift(trx, guard.organizationId, input.shiftId, true);
  if (!shift || shift.guardId !== guard.guardId)
    return { status: 'REJECTED', code: 'NOT_FOUND', shift: null };
  const previous = await eventByClientId(trx, guard.organizationId, shift.id, input.clientEventId);
  if (previous) return { status: 'DUPLICATE', shift };
  const settings = await loadShiftSettings(trx, guard.organizationId);
  const result = transition(shift, { type: 'GUARD_END' }, 'GUARD', now, settings);
  if (!result.ok) return { status: 'REJECTED', code: 'SHIFT_NOT_ACTIVE', shift };
  // An offline end is the capture time, but never before the start or after now.
  const endedAt = input.offline
    ? new Date(
        Math.min(now.getTime(), Math.max(input.capturedAt.getTime(), shift.actualStartedAt?.getTime() ?? 0)),
      )
    : now;
  await updateShift(trx, {
    organizationId: guard.organizationId,
    id: shift.id,
    version: shift.version,
    userId: null,
    now,
    changes: {
      status: 'COMPLETED',
      actualEndedAt: endedAt,
      endReason: input.offline ? 'GUARD_OFFLINE_SYNCED' : 'GUARD',
      end: input.fix ? { lat: input.fix.lat, lng: input.fix.lon, accuracyM: input.fix.accuracyM } : null,
    },
  });
  await insertShiftEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId: guard.organizationId,
    shiftId: shift.id,
    type: 'ENDED',
    actorType: 'GUARD',
    actorUserId: guard.userId,
    deviceId: guard.deviceId,
    clientEventId: input.clientEventId,
    occurredAt: now,
    clientRecordedAt: input.recordedAt,
    payload: { offline: input.offline },
  });
  const updated = await getShift(trx, guard.organizationId, shift.id);
  return { status: 'ACCEPTED', shift: updated ?? shift };
}

/** A system transition (detectors). Returns false when it no longer applies (already handled). */
export async function systemTransition(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  shiftId: string,
  command: { type: 'MARK_MISSED' } | { type: 'AUTO_END' },
): Promise<boolean> {
  const now = deps.clock.now();
  const shift = await getShift(trx, organizationId, shiftId, true);
  if (!shift) return false;
  const settings = await loadShiftSettings(trx, organizationId);
  const result = transition(shift, command, 'SYSTEM', now, settings);
  if (!result.ok) return false;
  const changes: ShiftUpdate =
    command.type === 'AUTO_END'
      ? { status: 'COMPLETED', actualEndedAt: now, endReason: 'AUTO_TIMEOUT' }
      : { status: 'MISSED' };
  await updateShift(trx, {
    organizationId,
    id: shift.id,
    version: shift.version,
    userId: null,
    now,
    changes,
  });
  await insertShiftEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId,
    shiftId: shift.id,
    type: result.event,
    actorType: 'SYSTEM',
    actorUserId: null,
    deviceId: null,
    clientEventId: null,
    occurredAt: now,
    clientRecordedAt: null,
    payload: {},
  });
  return true;
}

/** SEC §5: revoking a guard's access during a shift force-ends it with a recorded reason. */
export async function endShiftsForDisabledGuard(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  guardId: string,
  userId: string,
) {
  const now = deps.clock.now();
  for (const shift of await activeShiftsForGuard(trx, organizationId, guardId)) {
    await updateShift(trx, {
      organizationId,
      id: shift.id,
      version: shift.version,
      userId,
      now,
      changes: { status: 'COMPLETED', actualEndedAt: now, endReason: 'GUARD_DISABLED' },
    });
    await insertShiftEvent(trx, {
      id: uuidv7(deps.clock),
      organizationId,
      shiftId: shift.id,
      type: 'FORCE_ENDED',
      actorType: 'USER',
      actorUserId: userId,
      deviceId: null,
      clientEventId: null,
      occurredAt: now,
      clientRecordedAt: null,
      payload: { reason: 'guard access revoked' },
    });
  }
}
