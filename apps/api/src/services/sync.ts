// The sync pipeline (ARCH §8.6, §9). One transaction per batch, one savepoint per item, items in
// order, so a shift's START applies before its points. Per-item results; one bad item is rejected or
// quarantined alone and never fails the batch (ARCH §9.3, ADV-O09). Guard, device and organization
// come from the session, never from the body (ARCH §9.1). Locations outside the shift window are
// rejected and not stored (INV-08); capture times are the server's estimate (INV-07).
import {
  syncItemSchema,
  type ErrorCode,
  type ScanResult,
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
  hasQuarantinedStart,
  insertDeviceStatus,
  insertPoint,
  liveFix,
  type LiveKey,
  quarantine,
  releaseSavepoint,
  rollbackToSavepoint,
  savepoint,
  storedPoint,
} from '../repositories/tracking.ts';
import { deviceReportAlerts, raiseAlert, reopenSuppressionMs } from './alerts.ts';
import { evaluateGeofence } from './geofence.ts';
import { processIncidentItem, processNoteItem } from './incidents.ts';
import { processScan } from './patrols.ts';
import { publish } from './realtime.ts';
import { guardEnd, guardStart, type GuardOutcome, type GuardRef } from './shifts.ts';

type Result = {
  clientEventId: string;
  status: SyncItemStatus;
  code?: ErrorCode;
  scan?: ScanResult;
  incident?: { id: string; referenceNumber: string };
};

const MAX_ACCURACY_M = 50_000;
const IMPLAUSIBLE_SPEED_MPS = 70;
/** A start or end received within this of its capture counts as online (server time decides). */
const ONLINE_WINDOW_MS = 30_000;

export type SyncGuard = GuardRef & {
  readonly appVersion: string | null;
  /** A replaced phone draining its queue: only items captured before this are accepted (ADV-A08). */
  readonly replacedAt?: Date | null;
};

/** What the live-state projection learns from one item, applied only if the item succeeds. */
type LiveStaging = {
  contact: LiveKey | null;
  fix: { key: LiveKey; fix: LiveFixUpdate } | null;
};

type LiveFixUpdate = { lat: number; lng: number; accuracyM: number; capturedAt: Date; pointId: string };
type PreviousFix = { lat: number; lng: number; capturedAt: Date };
type ShiftRow = NonNullable<Awaited<ReturnType<typeof getShift>>>;

/**
 * What one batch learns about the shifts it mentions, so that a batch of 100 items does not ask the
 * database the same questions 100 times (ARCH §18.3: 100 items in 300 ms at p95).
 *   - A shift is read once; any start or end in the batch makes the batch read it again.
 *   - The last fix a shift had is read once and then kept up to date in memory, with the database's
 *     own rule: a fix replaces the last one only if it was captured later (ADV-L06).
 *   - "Contact" and "last fix" only ever move forward, and every item of a batch carries the same
 *     received time, so the batch's final state is the same whether it is written after each item
 *     or once per shift at the end. It is written once, before the geofence looks at the shift.
 *   - An item that fails changes nothing here: it is merged only after the item succeeded.
 */
class BatchLive {
  readonly #shifts = new Map<string, ShiftRow | null>();
  readonly #previous = new Map<string, PreviousFix | null>();
  readonly #contacts = new Map<string, LiveKey>();
  readonly #fixes = new Map<string, { key: LiveKey; fix: LiveFixUpdate }>();

  async shift(trx: Database, organizationId: string, shiftId: string): Promise<ShiftRow | null> {
    if (!this.#shifts.has(shiftId)) this.#shifts.set(shiftId, await getShift(trx, organizationId, shiftId));
    return this.#shifts.get(shiftId) ?? null;
  }

  forgetShifts(): void {
    this.#shifts.clear();
  }

  async previous(trx: Database, organizationId: string, shiftId: string): Promise<PreviousFix | null> {
    if (!this.#previous.has(shiftId)) {
      const row = await liveFix(trx, organizationId, shiftId);
      this.#previous.set(
        shiftId,
        row?.last_fix_latitude != null && row.last_fix_longitude != null && row.last_fix_captured_at
          ? { lat: row.last_fix_latitude, lng: row.last_fix_longitude, capturedAt: row.last_fix_captured_at }
          : null,
      );
    }
    return this.#previous.get(shiftId) ?? null;
  }

  /** The item succeeded: what it staged now counts. */
  merge(staged: LiveStaging): void {
    if (staged.contact) this.#contacts.set(staged.contact.shiftId, staged.contact);
    if (staged.fix) {
      const { key, fix } = staged.fix;
      const best = this.#fixes.get(key.shiftId);
      if (!best || best.fix.capturedAt.getTime() < fix.capturedAt.getTime()) {
        this.#fixes.set(key.shiftId, { key, fix });
      }
      const previous = this.#previous.get(key.shiftId);
      if (!previous || previous.capturedAt.getTime() < fix.capturedAt.getTime()) {
        this.#previous.set(key.shiftId, { lat: fix.lat, lng: fix.lng, capturedAt: fix.capturedAt });
      }
    }
  }

  async flush(trx: Database, receivedAt: Date): Promise<void> {
    for (const { key, fix } of this.#fixes.values()) await advanceLiveFix(trx, key, fix, receivedAt);
    for (const key of this.#contacts.values()) await advanceLiveContact(trx, key, receivedAt);
  }
}

type BatchRun = {
  readonly results: Result[];
  readonly touchedShifts: Set<string>;
};

export async function processBatch(
  deps: AppDeps,
  guard: SyncGuard,
  batch: SyncBatchRequest,
): Promise<SyncBatchResponse> {
  const receivedAt = deps.clock.now();
  // The normal path runs the whole batch in one transaction without a savepoint per item. If any item
  // throws, that transaction is rolled back and the batch runs again item by item, each in its own
  // savepoint, so the one bad item is quarantined alone and the rest commit (ARCH §9.3, ADV-O09).
  let run: BatchRun;
  try {
    run = await withTenantTransaction(deps.db, guard.organizationId, (trx) =>
      runBatch(trx, deps, guard, batch, receivedAt, false),
    );
  } catch {
    run = await withTenantTransaction(deps.db, guard.organizationId, (trx) =>
      runBatch(trx, deps, guard, batch, receivedAt, true),
    );
  }

  // Server state wins (ARCH §8.8): the phone reconciles its shifts with these.
  const shifts = await withTenantTransaction(deps.db, guard.organizationId, async (trx) => {
    const out: SyncBatchResponse['shifts'] = [];
    for (const id of run.touchedShifts) {
      const s = await getShift(trx, guard.organizationId, id);
      if (s && s.guardId === guard.guardId)
        out.push({ shiftId: s.id, status: s.status, endsAt: s.endsAt.toISOString() });
    }
    return out;
  });
  return { serverTime: deps.clock.now().toISOString(), results: run.results, shifts };
}

async function runBatch(
  trx: Database,
  deps: AppDeps,
  guard: SyncGuard,
  batch: SyncBatchRequest,
  receivedAt: Date,
  careful: boolean,
): Promise<BatchRun> {
  const touchedShifts = new Set<string>();
  // Shifts whose start in this batch was quarantined: their later items wait (RETRY) instead of
  // being judged against a shift that hasn't started, which would reject and lose them.
  const heldShifts = new Set<string>();
  const pointShifts = new Set<string>();
  // Shifts whose live state this batch moved: the dashboards hear about each once (ARCH §14).
  const liveShifts = new Set<string>();
  const results: Result[] = [];
  const live = new BatchLive();

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
    if (careful) await savepoint(trx, name);
    try {
      const staged: LiveStaging = { contact: null, fix: null };
      const result = await processItem(trx, deps, guard, batch, item, {
        receivedAt,
        maxAgeMs,
        usableAccuracyM,
        settings,
        live,
        staged,
      });
      if (careful) await releaseSavepoint(trx, name);
      live.merge(staged);
      // A start or an end changes what the shift lookups return.
      if (item.type === 'SHIFT_START' || item.type === 'SHIFT_END') live.forgetShifts();
      if (item.type === 'LOCATION' && result.status === 'ACCEPTED') pointShifts.add(item.shiftId);
      if (shiftId && result.status === 'ACCEPTED') liveShifts.add(shiftId);
      results.push({ clientEventId: item.clientEventId, ...result });
    } catch (error) {
      // Unexpected. On the normal path the whole batch is rolled back and run again with savepoints.
      if (!careful) throw error;
      // Unexpected: keep the item for operator replay; the phone may delete it (ARCH §9.3).
      await rollbackToSavepoint(trx, name);
      live.forgetShifts();
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
  // What the items learned about the shifts' live state, written once per shift.
  await live.flush(trx, receivedAt);
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
  for (const shiftId of liveShifts) {
    await publish(trx, deps, guard.organizationId, 'guard.state', { shiftId });
  }
  return { results, touchedShifts };
}

type Limits = {
  receivedAt: Date;
  maxAgeMs: number;
  usableAccuracyM: number;
  settings: Record<string, unknown>;
  live: BatchLive;
  /** What this item tells the live-state projection; merged by the batch only if the item succeeds. */
  staged: LiveStaging;
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
        limits.staged.contact = key;
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
      // Its start is in quarantine: wait for the replay rather than lose the end.
      if (
        outcome.status === 'REJECTED' &&
        outcome.shift?.status === 'SCHEDULED' &&
        (await hasQuarantinedStart(trx, guard.organizationId, guard.deviceId, outcome.shift.id))
      ) {
        return { status: 'RETRY' };
      }
      return fromOutcome(outcome);
    }
    case 'LOCATION': {
      const shift = await limits.live.shift(trx, guard.organizationId, item.shiftId);
      // Another guard's or organization's shift: rejected, nothing stored (ADV-L02).
      if (!shift || shift.guardId !== guard.guardId) return { status: 'REJECTED', code: 'NOT_FOUND' };
      // Judged by capture time against the window, not by the shift's current state (ADV-L04, L05).
      if (
        !inShiftWindow(estimate.capturedAt, shift.actualStartedAt, shift.actualEndedAt, limits.receivedAt)
      ) {
        // Not started because its start is in quarantine: wait for the replay rather than lose it.
        if (
          shift.status === 'SCHEDULED' &&
          (await hasQuarantinedStart(trx, guard.organizationId, guard.deviceId, shift.id))
        ) {
          return { status: 'RETRY' };
        }
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
      const previous = await limits.live.previous(trx, guard.organizationId, shift.id);
      if (previous) {
        const seconds = Math.abs(estimate.capturedAt.getTime() - previous.capturedAt.getTime()) / 1000;
        const metres = haversineM({ lat: previous.lat, lng: previous.lng }, { lat: fix.lat, lng: fix.lon });
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
        limits.staged.fix = {
          key,
          fix: {
            lat: fix.lat,
            lng: fix.lon,
            accuracyM: fix.accuracyM,
            capturedAt: estimate.capturedAt,
            pointId,
          },
        };
      }
      limits.staged.contact = key;
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
        const shift = await limits.live.shift(trx, guard.organizationId, item.shiftId);
        if (!shift || shift.guardId !== guard.guardId) return { status: 'REJECTED', code: 'NOT_FOUND' };
        if (shift.status === 'ACTIVE') {
          limits.staged.contact = {
            organizationId: guard.organizationId,
            shiftId: shift.id,
            guardId: guard.guardId,
            siteId: shift.siteId,
          };
        }
      }
      return { status: 'ACCEPTED' };
    }
    case 'DEVICE_STATUS': {
      const shift = item.shiftId ? await limits.live.shift(trx, guard.organizationId, item.shiftId) : null;
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
      // Online and offline scans alike, judged by capture time (ARCH §11.2, ADV-Q09).
      return processScan(trx, deps, guard, item, {
        estimate,
        receivedAt: limits.receivedAt,
        settings: limits.settings,
      });
    case 'INCIDENT': {
      // Only during a shift or an open SOS, judged by capture time (INV-08, PROD §10.1).
      const result = await processIncidentItem(trx, deps, guard, item, {
        estimate,
        receivedAt: limits.receivedAt,
      });
      return result;
    }
    case 'INCIDENT_NOTE':
      return processNoteItem(trx, deps, guard, item, limits.receivedAt);
  }
}
