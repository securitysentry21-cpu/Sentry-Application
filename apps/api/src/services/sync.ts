// The sync pipeline (ARCH §8.6, §9). One transaction per batch, one savepoint per item, items in
// order, so a shift's START applies before its points. Per-item results; one bad item is rejected or
// quarantined alone and never fails the batch (ARCH §9.3, ADV-O09). Guard, device and organization
// come from the session, never from the body (ARCH §9.1). Locations outside the shift window are
// rejected and not stored (INV-08); capture times are the server's estimate (INV-07).
import {
  syncItemSchema,
  type ErrorCode,
  type SyncBatchRequest,
  type SyncBatchResponse,
  type SyncItem,
  type SyncItemStatus,
} from '@sentryops/contracts';
import { withTenantTransaction, type Database } from '@sentryops/db';
import { alertKey, estimateCapture, haversineM, inShiftWindow } from '@sentryops/domain';

import type { AppDeps } from '../deps.ts';
import { uuidv7 } from '../ids.ts';
import { numberSetting, organizationSettings } from '../repositories/organizations.ts';
import { getShift } from '../repositories/shifts.ts';
import {
  advanceLiveContact,
  advanceLiveFix,
  insertDeviceStatus,
  insertPoint,
  liveFix,
  quarantine,
  releaseSavepoint,
  rollbackToSavepoint,
  savepoint,
  storedPoint,
} from '../repositories/tracking.ts';
import { deviceReportAlerts, raiseAlert, reopenSuppressionMs } from './alerts.ts';
import { evaluateGeofence } from './geofence.ts';
import { guardEnd, guardStart, type GuardOutcome, type GuardRef } from './shifts.ts';

type Result = { clientEventId: string; status: SyncItemStatus; code?: ErrorCode };

const MAX_ACCURACY_M = 50_000;
const IMPLAUSIBLE_SPEED_MPS = 70;
/** A start or end received within this of its capture counts as online (server time decides). */
const ONLINE_WINDOW_MS = 30_000;

export type SyncGuard = GuardRef & {
  readonly appVersion: string | null;
  /** A replaced phone draining its queue: only items captured before this are accepted (ADV-A08). */
  readonly replacedAt?: Date | null;
};

export async function processBatch(
  deps: AppDeps,
  guard: SyncGuard,
  batch: SyncBatchRequest,
): Promise<SyncBatchResponse> {
  const receivedAt = deps.clock.now();
  const touchedShifts = new Set<string>();
  // Shifts whose start in this batch was quarantined: their later items wait (RETRY) instead of
  // being judged against a shift that hasn't started, which would reject and lose them.
  const heldShifts = new Set<string>();
  const pointShifts = new Set<string>();
  const results: Result[] = [];
  await withTenantTransaction(deps.db, guard.organizationId, async (trx) => {
    const settings = await organizationSettings(trx, guard.organizationId);
    const maxAgeMs = numberSetting(settings, 'sync.max_offline_age_hours', 168) * 3_600_000;
    const usableAccuracyM = numberSetting(settings, 'geofence.max_usable_accuracy_m', 100);
    for (const [index, raw] of batch.items.entries()) {
      const clientEventId =
        typeof (raw as { clientEventId?: unknown }).clientEventId === 'string'
          ? (raw as { clientEventId: string }).clientEventId
          : `#${index}`;
      const parsed = syncItemSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({ clientEventId, status: 'REJECTED', code: 'VALIDATION_FAILED' });
        continue;
      }
      const item = parsed.data;
      const shiftId = 'shiftId' in item && item.shiftId ? item.shiftId : null;
      // Every shift the batch mentions comes back with its server state (ARCH §8.8).
      if (shiftId) touchedShifts.add(shiftId);
      if (shiftId && heldShifts.has(shiftId)) {
        results.push({ clientEventId: item.clientEventId, status: 'RETRY' });
        continue;
      }
      const name = `item_${index}`;
      await savepoint(trx, name);
      try {
        const result = await processItem(trx, deps, guard, batch, item, {
          receivedAt,
          maxAgeMs,
          usableAccuracyM,
          settings,
        });
        await releaseSavepoint(trx, name);
        if (item.type === 'LOCATION' && result.status === 'ACCEPTED') pointShifts.add(item.shiftId);
        results.push({ clientEventId: item.clientEventId, ...result });
      } catch {
        // Unexpected: keep the item for operator replay; the phone may delete it (ARCH §9.3).
        await rollbackToSavepoint(trx, name);
        await quarantine(trx, {
          id: uuidv7(deps.clock),
          organizationId: guard.organizationId,
          deviceId: guard.deviceId,
          batchId: batch.batchId,
          clientEventId: item.clientEventId,
          item,
          errorCode: 'INTERNAL_ERROR',
        });
        results.push({ clientEventId: item.clientEventId, status: 'QUARANTINED' });
        if (item.type === 'SHIFT_START') heldShifts.add(item.shiftId);
      }
    }
    // Geofence (ARCH §10): after the points are stored, in capture order, once per shift. A failure
    // here is logged and retried with the next batch (the watermark didn't move); it never fails
    // the batch.
    for (const shiftId of pointShifts) {
      const name = `geofence_${shiftId.replaceAll('-', '')}`;
      await savepoint(trx, name);
      try {
        const shift = await getShift(trx, guard.organizationId, shiftId);
        if (shift) await evaluateGeofence(trx, deps, guard.organizationId, shift, settings);
        await releaseSavepoint(trx, name);
      } catch {
        await rollbackToSavepoint(trx, name);
        deps.metrics.increment('geofence_evaluation_failed');
      }
    }
  });

  // Server state wins (ARCH §8.8): the phone reconciles its shifts with these.
  const shifts = await withTenantTransaction(deps.db, guard.organizationId, async (trx) => {
    const out: SyncBatchResponse['shifts'] = [];
    for (const id of touchedShifts) {
      const s = await getShift(trx, guard.organizationId, id);
      if (s && s.guardId === guard.guardId)
        out.push({ shiftId: s.id, status: s.status, endsAt: s.endsAt.toISOString() });
    }
    return out;
  });
  return { serverTime: deps.clock.now().toISOString(), results, shifts };
}

type Limits = {
  receivedAt: Date;
  maxAgeMs: number;
  usableAccuracyM: number;
  settings: Record<string, unknown>;
};

function fromOutcome(outcome: GuardOutcome): Omit<Result, 'clientEventId'> {
  if (outcome.status === 'REJECTED') return { status: 'REJECTED', code: outcome.code };
  return { status: outcome.status };
}

async function processItem(
  trx: Database,
  deps: AppDeps,
  guard: SyncGuard,
  batch: SyncBatchRequest,
  item: SyncItem,
  limits: Limits,
): Promise<Omit<Result, 'clientEventId'>> {
  const estimate = estimateCapture({
    receivedAt: limits.receivedAt,
    recordedAt: new Date(item.recordedAt),
    itemMonoMs: item.monoMs,
    batchSentMonoMs: batch.sentMonoMs,
    sameBoot: item.bootId !== undefined && item.bootId === batch.bootId,
  });
  if (limits.receivedAt.getTime() - estimate.capturedAt.getTime() > limits.maxAgeMs) {
    return { status: 'REJECTED', code: 'TIMESTAMP_TOO_OLD' };
  }
  if (guard.replacedAt && estimate.capturedAt.getTime() >= guard.replacedAt.getTime()) {
    return { status: 'REJECTED', code: 'DEVICE_REVOKED' };
  }
  const online =
    estimate.clockStatus === 'VERIFIED_MONOTONIC' &&
    limits.receivedAt.getTime() - estimate.capturedAt.getTime() <= ONLINE_WINDOW_MS;

  switch (item.type) {
    case 'SHIFT_START': {
      const outcome = await guardStart(trx, deps, guard, {
        shiftId: item.shiftId,
        clientEventId: item.clientEventId,
        recordedAt: new Date(item.recordedAt),
        capturedAt: online ? limits.receivedAt : estimate.capturedAt,
        offline: !online,
        fix: item.fix,
        permission: item.permission,
        flags: estimate.flags,
      });
      if (outcome.status === 'ACCEPTED' && item.fix) {
        const key = {
          organizationId: guard.organizationId,
          shiftId: outcome.shift.id,
          guardId: guard.guardId,
          siteId: outcome.shift.siteId,
        };
        await advanceLiveContact(trx, key, limits.receivedAt);
      }
      return fromOutcome(outcome);
    }
    case 'SHIFT_END': {
      const outcome = await guardEnd(trx, deps, guard, {
        shiftId: item.shiftId,
        clientEventId: item.clientEventId,
        recordedAt: new Date(item.recordedAt),
        capturedAt: online ? limits.receivedAt : estimate.capturedAt,
        offline: !online,
        fix: item.fix,
      });
      return fromOutcome(outcome);
    }
    case 'LOCATION': {
      const shift = await getShift(trx, guard.organizationId, item.shiftId);
      // Another guard's or organization's shift: rejected, nothing stored (ADV-L02).
      if (!shift || shift.guardId !== guard.guardId) return { status: 'REJECTED', code: 'NOT_FOUND' };
      // Judged by capture time against the window, not by the shift's current state (ADV-L04, L05).
      if (
        !inShiftWindow(estimate.capturedAt, shift.actualStartedAt, shift.actualEndedAt, limits.receivedAt)
      ) {
        return { status: 'REJECTED', code: 'OUTSIDE_SHIFT_WINDOW' };
      }
      const fix = item.fix;
      if (fix.accuracyM !== null && fix.accuracyM > MAX_ACCURACY_M)
        return { status: 'REJECTED', code: 'VALIDATION_FAILED' };
      const flags = new Set(estimate.flags);
      if (fix.accuracyM === null) flags.add('ACCURACY_UNKNOWN');
      else if (fix.accuracyM > limits.usableAccuracyM) flags.add('LOW_ACCURACY');
      if (fix.isMock) flags.add('MOCK_LOCATION');
      if (fix.speedMps !== undefined && fix.speedMps > 150) flags.add('IMPLAUSIBLE_SPEED');
      const previous = await liveFix(trx, guard.organizationId, shift.id);
      if (
        previous?.last_fix_latitude != null &&
        previous.last_fix_longitude != null &&
        previous.last_fix_captured_at
      ) {
        const seconds =
          Math.abs(estimate.capturedAt.getTime() - previous.last_fix_captured_at.getTime()) / 1000;
        const metres = haversineM(
          { lat: previous.last_fix_latitude, lng: previous.last_fix_longitude },
          { lat: fix.lat, lng: fix.lon },
        );
        if (seconds > 0 && metres / seconds > IMPLAUSIBLE_SPEED_MPS) flags.add('IMPLAUSIBLE_SPEED');
      }
      const pointId = uuidv7(deps.clock);
      const inserted = await insertPoint(trx, {
        id: pointId,
        organizationId: guard.organizationId,
        guardId: guard.guardId,
        shiftId: shift.id,
        deviceId: guard.deviceId,
        clientEventId: item.clientEventId,
        latitude: fix.lat,
        longitude: fix.lon,
        accuracyM: fix.accuracyM,
        altitudeM: fix.altitudeM ?? null,
        speedMps: fix.speedMps ?? null,
        headingDeg: fix.headingDeg ?? null,
        recordedAt: new Date(item.recordedAt),
        capturedAt: estimate.capturedAt,
        receivedAt: limits.receivedAt,
        clockStatus: estimate.clockStatus,
        source: 'TRACKING',
        provider: fix.provider ?? null,
        isMock: fix.isMock ?? null,
        flags: [...flags].sort(),
        appVersion: guard.appVersion,
        batchId: batch.batchId,
      });
      if (!inserted) {
        // The original is kept; altered content under the same ID is an anomaly (INV-05, ADV-L09).
        const stored = await storedPoint(trx, guard.organizationId, guard.deviceId, item.clientEventId);
        if (stored && (stored.latitude !== fix.lat || stored.longitude !== fix.lon)) {
          deps.metrics.increment('idempotency_conflict');
        }
        return { status: 'DUPLICATE' };
      }
      const key = {
        organizationId: guard.organizationId,
        shiftId: shift.id,
        guardId: guard.guardId,
        siteId: shift.siteId,
      };
      if (fix.accuracyM !== null && fix.accuracyM <= limits.usableAccuracyM) {
        await advanceLiveFix(
          trx,
          key,
          { lat: fix.lat, lng: fix.lon, accuracyM: fix.accuracyM, capturedAt: estimate.capturedAt, pointId },
          limits.receivedAt,
        );
      }
      await advanceLiveContact(trx, key, limits.receivedAt);
      // Stored with its flags either way; a person decides what it means (PROD §8.5, ADV-L11).
      const suspicious = ['MOCK_LOCATION', 'IMPLAUSIBLE_SPEED'].filter((f) => flags.has(f));
      if (suspicious.length > 0) {
        await raiseAlert(
          trx,
          deps,
          guard.organizationId,
          {
            type: 'SUSPICIOUS_LOCATION',
            dedupeKey: alertKey.suspicious(shift.id),
            summary: `Suspicious location: ${shift.guardName} (${shift.siteName})`,
            guardId: guard.guardId,
            siteId: shift.siteId,
            shiftId: shift.id,
            details: { flags: suspicious, capturedAt: estimate.capturedAt.toISOString() },
          },
          reopenSuppressionMs(limits.settings),
        );
      }
      return { status: 'ACCEPTED' };
    }
    case 'HEARTBEAT': {
      if (item.shiftId) {
        const shift = await getShift(trx, guard.organizationId, item.shiftId);
        if (!shift || shift.guardId !== guard.guardId) return { status: 'REJECTED', code: 'NOT_FOUND' };
        if (shift.status === 'ACTIVE') {
          await advanceLiveContact(
            trx,
            {
              organizationId: guard.organizationId,
              shiftId: shift.id,
              guardId: guard.guardId,
              siteId: shift.siteId,
            },
            limits.receivedAt,
          );
        }
      }
      return { status: 'ACCEPTED' };
    }
    case 'DEVICE_STATUS': {
      const shift = item.shiftId ? await getShift(trx, guard.organizationId, item.shiftId) : null;
      if (item.shiftId && (!shift || shift.guardId !== guard.guardId))
        return { status: 'REJECTED', code: 'NOT_FOUND' };
      const inserted = await insertDeviceStatus(trx, {
        id: uuidv7(deps.clock),
        organizationId: guard.organizationId,
        guardId: guard.guardId,
        deviceId: guard.deviceId,
        shiftId: shift?.id ?? null,
        clientEventId: item.clientEventId,
        recordedAt: new Date(item.recordedAt),
        receivedAt: limits.receivedAt,
        status: item.status,
        appVersion: guard.appVersion,
      });
      if (!inserted) return { status: 'DUPLICATE' };
      if (shift?.status === 'ACTIVE') {
        await deviceReportAlerts(trx, deps, guard.organizationId, shift, item.status, limits.settings);
        await advanceLiveContact(
          trx,
          {
            organizationId: guard.organizationId,
            shiftId: shift.id,
            guardId: guard.guardId,
            siteId: shift.siteId,
          },
          limits.receivedAt,
          {
            trackingServiceState: item.status.trackingServiceState,
            locationPermission: item.status.locationPermission,
            batteryPct: item.status.batteryPct ?? null,
            isCharging: item.status.isCharging ?? null,
            pendingQueueCount: item.status.pendingQueueCount ?? null,
            oldestPendingAt: item.status.oldestPendingAt ? new Date(item.status.oldestPendingAt) : null,
            appVersion: guard.appVersion,
          },
        );
      }
      return { status: 'ACCEPTED' };
    }
    case 'CHECKPOINT_SCAN':
    case 'INCIDENT':
      // Patrols (Phase 7) and incidents (Phase 8) are off in /mobile/config; the app doesn't send them.
      return { status: 'REJECTED', code: 'VALIDATION_FAILED' };
  }
}
