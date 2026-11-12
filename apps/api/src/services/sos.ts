// SOS (PROD §11, ARCH §13.1). Acceptance is never refused for being too frequent, too old an app,
// a suspended organization or an expired session (INV-15; the routes and context.ts see to that).
// One open SOS per guard; pressing again re-triggers it, and after an acknowledgement makes it
// unacknowledged and restarts the ladder (owner decision 2026-11-02). The guard's phone is told
// only what the server can prove (INV-10).
import type { SosLocationsRequest, SosRequest, SosStatusResponse } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import {
  estimateCapture,
  guardSosPhase,
  inShiftWindow,
  sosDrillFor,
  sosTrackingUntil,
  type CaptureEstimate,
} from '@sentryops/domain';

import type { AppDeps } from '../deps.ts';
import { AppError, notFound } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import {
  lastClosedByKey,
  openAlertByKey,
  receiptCounts,
  updateAlert,
  type AlertRow,
} from '../repositories/alerts.ts';
import { sentRecipientCount } from '../repositories/notifications.ts';
import { numberSetting, organizationKind, organizationSettings } from '../repositories/organizations.ts';
import { startedShiftsAround, type ShiftRow } from '../repositories/shifts.ts';
import {
  drillsAround,
  getSos,
  insertPress,
  insertSos,
  openSosForGuard,
  pressByClientEvent,
  updateSos,
  type SosRow,
} from '../repositories/sos.ts';
import { advanceLiveContact, advanceLiveFix, insertPoint } from '../repositories/tracking.ts';
import { acknowledge, alertEvent, raiseAlert, reopenSuppressionMs, resolveManually } from './alerts.ts';
import { firstEscalationAt, queueAlertStep, queueGuardPush } from './notifications.ts';
import { publish } from './realtime.ts';

export const sosAlertKey = (sosEventId: string) => `sos:${sosEventId}`;

const MAX_ACCURACY_M = 50_000;

export type SosGuard = {
  readonly organizationId: string;
  readonly guardId: string;
  readonly deviceId: string;
  readonly name: string;
  readonly auth: 'SESSION' | 'DEVICE_SIGNATURE';
  readonly appVersion: string | null;
  /** False for a disabled guard, whose SOS is accepted and marked (owner decision Q1, review L-11). */
  readonly guardActive: boolean;
};

type Fix = NonNullable<SosRequest['fix']>;

function capture(
  receivedAt: Date,
  item: { recordedAt: string; monoMs: number },
  sentMonoMs: number | undefined,
) {
  return estimateCapture({
    receivedAt,
    recordedAt: new Date(item.recordedAt),
    itemMonoMs: item.monoMs,
    batchSentMonoMs: sentMonoMs ?? 0,
    sameBoot: sentMonoMs !== undefined,
  });
}

/** The shift whose window holds `at`, newest first (judged by capture time, never current state). */
async function shiftAt(trx: Database, organizationId: string, guardId: string, at: Date, now: Date) {
  for (const shift of await startedShiftsAround(trx, organizationId, guardId, at)) {
    if (inShiftWindow(at, shift.actualStartedAt, shift.actualEndedAt, now)) return shift;
  }
  return null;
}

/** Stores one SOS point; true when new. Updates the shift's live state when it belongs to one. */
async function storePoint(
  trx: Database,
  deps: AppDeps,
  guard: SosGuard,
  sos: { id: string },
  item: { clientEventId: string; recordedAt: string },
  fix: Fix,
  estimate: CaptureEstimate,
  shift: ShiftRow | null,
): Promise<{ inserted: boolean; capturedAt: Date }> {
  const now = deps.clock.now();
  const capturedAt = new Date(estimate.capturedAt.getTime() - (fix.fixAgeS ?? 0) * 1000);
  const flags = new Set(estimate.flags);
  if (fix.accuracyM === null) flags.add('ACCURACY_UNKNOWN');
  if (fix.isMock) flags.add('MOCK_LOCATION');
  const pointId = uuidv7(deps.clock);
  const inserted = await insertPoint(trx, {
    id: pointId,
    organizationId: guard.organizationId,
    guardId: guard.guardId,
    shiftId: shift?.id ?? null,
    deviceId: guard.deviceId,
    clientEventId: item.clientEventId,
    latitude: fix.lat,
    longitude: fix.lon,
    accuracyM: fix.accuracyM,
    altitudeM: fix.altitudeM ?? null,
    speedMps: fix.speedMps !== undefined && fix.speedMps <= 150 ? fix.speedMps : null,
    headingDeg: fix.headingDeg ?? null,
    recordedAt: new Date(item.recordedAt),
    capturedAt,
    receivedAt: now,
    clockStatus: estimate.clockStatus,
    source: 'SOS',
    provider: fix.provider ?? null,
    isMock: fix.isMock ?? null,
    flags: [...flags],
    appVersion: guard.appVersion,
    batchId: null,
    sosEventId: sos.id,
  });
  if (inserted && shift) {
    // The control room follows the guard on the live map during the SOS, as during any shift.
    const key = {
      organizationId: guard.organizationId,
      shiftId: shift.id,
      guardId: guard.guardId,
      siteId: shift.siteId,
    };
    await advanceLiveFix(
      trx,
      key,
      { lat: fix.lat, lng: fix.lon, accuracyM: fix.accuracyM, capturedAt, pointId },
      now,
    );
    await advanceLiveContact(trx, key, now);
  }
  return { inserted, capturedAt };
}

export type SosAcceptance = {
  readonly sosEventId: string;
  readonly isDrill: boolean;
  readonly outcome: 'CREATED' | 'RETRIGGERED' | 'DUPLICATE';
};

/** POST /sos: store, open SOS_ACTIVATED, queue the first notifications, answer RECEIVED. */
export async function acceptSos(
  trx: Database,
  deps: AppDeps,
  guard: SosGuard,
  request: SosRequest,
): Promise<SosAcceptance> {
  const org = guard.organizationId;
  const now = deps.clock.now();
  // The same press again: the first answer stands (INV-06). Never an error: the phone needs RECEIVED.
  const previous = await pressByClientEvent(trx, org, guard.deviceId, request.clientEventId);
  if (previous) {
    const sos = await getSos(trx, org, previous);
    return { sosEventId: previous, isDrill: sos?.isDrill ?? false, outcome: 'DUPLICATE' };
  }
  const estimate = capture(now, request, request.sentMonoMs);
  const pressedAt = estimate.capturedAt;
  const fix =
    request.fix && (request.fix.accuracyM === null || request.fix.accuracyM <= MAX_ACCURACY_M)
      ? request.fix
      : null;
  const shift = await shiftAt(trx, org, guard.guardId, pressedAt, now);
  const press = {
    organizationId: org,
    guardId: guard.guardId,
    deviceId: guard.deviceId,
    clientEventId: request.clientEventId,
    pressedAtRecorded: new Date(request.recordedAt),
    pressedAt,
    receivedAt: now,
    auth: guard.auth,
  };

  const open = await openSosForGuard(trx, org, guard.guardId);
  if (open) {
    await insertPress(trx, { ...press, id: uuidv7(deps.clock), sosEventId: open.id });
    const pressedAgainAfterAck = open.status === 'ACKNOWLEDGED';
    let location: { lat: number; lng: number; accuracyM: number | null; capturedAt: Date } | undefined;
    if (fix) {
      const point = await storePoint(trx, deps, guard, open, request, fix, estimate, shift);
      if (point.capturedAt >= (open.locationCapturedAt ?? new Date(0))) {
        location = { lat: fix.lat, lng: fix.lon, accuracyM: fix.accuracyM, capturedAt: point.capturedAt };
      }
    }
    await updateSos(
      trx,
      org,
      open.id,
      {
        incrementTrigger: true,
        lastTriggeredAt: now,
        ...(location ? { location } : {}),
        // Owner decision 2026-11-02: pressed again after acknowledgement, it is unacknowledged.
        ...(pressedAgainAfterAck ? { status: 'ACTIVE', acknowledgedBy: null, acknowledgedAt: null } : {}),
      },
      now,
    );
    const alert = await openAlertByKey(trx, org, sosAlertKey(open.id));
    if (alert) await retrigger(trx, deps, org, alert, pressedAgainAfterAck);
    await publish(trx, deps, org, 'sos.updated', { sosEventId: open.id });
    deps.metrics.increment('sos_retriggered');
    return { sosEventId: open.id, isDrill: open.isDrill, outcome: 'RETRIGGERED' };
  }

  const kind = await organizationKind(trx, org);
  const drill = sosDrillFor(kind, await drillsAround(trx, org, now), guard.guardId, now);
  const id = uuidv7(deps.clock);
  // INV-08's exception is an open SOS: a fix older than the press counts only inside a shift.
  const fixCapturedAt = fix ? new Date(pressedAt.getTime() - (fix.fixAgeS ?? 0) * 1000) : null;
  const keepFix =
    fix !== null &&
    fixCapturedAt !== null &&
    (shift !== null || fixCapturedAt.getTime() >= pressedAt.getTime() - 60_000);
  await insertSos(trx, {
    id,
    organizationId: org,
    guardId: guard.guardId,
    shiftId: shift?.id ?? null,
    siteId: shift?.siteId ?? null,
    deviceId: guard.deviceId,
    clientEventId: request.clientEventId,
    activatedAtRecorded: new Date(request.recordedAt),
    activatedAt: pressedAt,
    receivedAt: now,
    clockStatus: estimate.clockStatus,
    location:
      keepFix && fix && fixCapturedAt
        ? { lat: fix.lat, lng: fix.lon, accuracyM: fix.accuracyM, capturedAt: fixCapturedAt }
        : null,
    isDrill: drill.isDrill,
    drillId: drill.drillId,
  });
  await insertPress(trx, { ...press, id: uuidv7(deps.clock), sosEventId: id });
  if (keepFix && fix) await storePoint(trx, deps, guard, { id }, request, fix, estimate, shift);
  const settings = await organizationSettings(trx, org);
  await raiseAlert(
    trx,
    deps,
    org,
    {
      type: 'SOS_ACTIVATED',
      dedupeKey: sosAlertKey(id),
      summary: `${drill.isDrill ? '[DRILL] ' : ''}SOS: ${guard.name}${shift ? ` (${shift.siteName})` : ' (off shift)'}${guard.guardActive ? '' : ' — guard disabled'}`,
      guardId: guard.guardId,
      siteId: shift?.siteId ?? null,
      shiftId: shift?.id ?? null,
      sosEventId: id,
      isDrill: drill.isDrill,
      // Owner decision Q1: a disabled guard's SOS is accepted and says so, so the control room
      // confirms who is calling (the phone may be in other hands).
      details: { offShift: shift === null, ...(guard.guardActive ? {} : { guardDisabled: true }) },
    },
    reopenSuppressionMs(settings),
  );
  await publish(trx, deps, org, 'sos.activated', { sosEventId: id });
  deps.metrics.increment(drill.isDrill ? 'sos_drill_events' : 'sos_events');
  return { sosEventId: id, isDrill: drill.isDrill, outcome: 'CREATED' };
}

/**
 * A second press on an open SOS: counted, the dashboards told. After an acknowledgement the alert
 * is OPEN again and the ladder restarts from its first step (owner decision 2026-11-02).
 */
async function retrigger(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  alert: AlertRow,
  afterAcknowledgement: boolean,
): Promise<void> {
  const now = deps.clock.now();
  if (!afterAcknowledgement) {
    await updateAlert(trx, organizationId, alert.id, { lastTriggeredAt: now, incrementTrigger: true }, now);
    await alertEvent(trx, deps, organizationId, alert.id, 'RETRIGGERED', null);
    return;
  }
  const settings = await organizationSettings(trx, organizationId);
  await updateAlert(
    trx,
    organizationId,
    alert.id,
    {
      status: 'OPEN',
      acknowledgedBy: null,
      acknowledgedAt: null,
      lastTriggeredAt: now,
      incrementTrigger: true,
      escalationLevel: 0,
      escalationStartedAt: now,
      nextEscalationAt: firstEscalationAt(alert, settings, now),
    },
    now,
  );
  await alertEvent(trx, deps, organizationId, alert.id, 'REOPENED', null, { reason: 'SOS_PRESSED_AGAIN' });
  const reopened = await openAlertByKey(trx, organizationId, alert.dedupeKey);
  if (reopened) await queueAlertStep(trx, deps, organizationId, reopened, 0, 'PRESSED_AGAIN');
}

/** The guard's own open-or-recent SOS, or 404 (another guard's SOS never exists for them). */
async function ownSos(trx: Database, guard: SosGuard, sosEventId: string): Promise<SosRow> {
  const sos = await getSos(trx, guard.organizationId, sosEventId, true);
  if (!sos || sos.guardId !== guard.guardId) throw notFound();
  return sos;
}

/** SOS tracking points (PROD §11.2): accepted from the press until resolution, idempotent each. */
export async function acceptSosLocations(
  trx: Database,
  deps: AppDeps,
  guard: SosGuard,
  sosEventId: string,
  body: SosLocationsRequest,
) {
  const sos = await ownSos(trx, guard, sosEventId);
  const now = deps.clock.now();
  const results: {
    clientEventId: string;
    status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
    code?: 'OUTSIDE_SHIFT_WINDOW' | 'VALIDATION_FAILED';
  }[] = [];
  let newest: { lat: number; lng: number; accuracyM: number | null; capturedAt: Date } | null = null;
  for (const point of body.points) {
    const estimate = estimateCapture({
      receivedAt: now,
      recordedAt: new Date(point.recordedAt),
      itemMonoMs: point.monoMs,
      batchSentMonoMs: body.sentMonoMs,
      sameBoot: point.bootId !== undefined && point.bootId === body.bootId,
    });
    const fix = point.fix;
    const capturedAt = new Date(estimate.capturedAt.getTime() - (fix.fixAgeS ?? 0) * 1000);
    if (fix.accuracyM !== null && fix.accuracyM > MAX_ACCURACY_M) {
      results.push({ clientEventId: point.clientEventId, status: 'REJECTED', code: 'VALIDATION_FAILED' });
      continue;
    }
    // INV-08: an SOS point is captured while the SOS was open; otherwise only a shift could hold it.
    const shift = await shiftAt(trx, guard.organizationId, guard.guardId, capturedAt, now);
    const sosOpenThen =
      capturedAt.getTime() >= sos.activatedAt.getTime() - 60_000 &&
      (sos.resolvedAt === null || capturedAt.getTime() <= sos.resolvedAt.getTime() + 60_000);
    if (!sosOpenThen) {
      results.push({ clientEventId: point.clientEventId, status: 'REJECTED', code: 'OUTSIDE_SHIFT_WINDOW' });
      continue;
    }
    const stored = await storePoint(trx, deps, guard, sos, point, fix, estimate, shift);
    results.push({ clientEventId: point.clientEventId, status: stored.inserted ? 'ACCEPTED' : 'DUPLICATE' });
    if (stored.inserted && (!newest || stored.capturedAt > newest.capturedAt)) {
      newest = { lat: fix.lat, lng: fix.lon, accuracyM: fix.accuracyM, capturedAt: stored.capturedAt };
    }
  }
  if (newest && (!sos.locationCapturedAt || newest.capturedAt > sos.locationCapturedAt)) {
    await updateSos(trx, guard.organizationId, sos.id, { location: newest }, now);
    // Only the position moved: the stream carries it live, so an open SOS page needn't reload its
    // detail (and write SOS_VIEWED, INV-14) every 10 seconds.
    await publish(trx, deps, guard.organizationId, 'sos.updated', {
      sosEventId: sos.id,
      positionOnly: 'true',
    });
  }
  return { serverTime: now.toISOString(), results };
}

/** "I'm safe / false alarm" (PROD §11.8): noted for the control room; nothing stops (ADV-S07). */
export async function requestCancel(trx: Database, deps: AppDeps, guard: SosGuard, sosEventId: string) {
  const sos = await ownSos(trx, guard, sosEventId);
  const now = deps.clock.now();
  if (sos.status !== 'RESOLVED' && !sos.guardCancelRequestedAt) {
    await updateSos(trx, guard.organizationId, sos.id, { guardCancelRequestedAt: now }, now);
    const alert = await openAlertByKey(trx, guard.organizationId, sosAlertKey(sos.id));
    if (alert) {
      await alertEvent(
        trx,
        deps,
        guard.organizationId,
        alert.id,
        'NOTE',
        null,
        { source: 'GUARD', guardCancelRequest: true },
        'The guard pressed "I\'m safe / false alarm". The SOS stays open until a person resolves it.',
      );
    }
    await publish(trx, deps, guard.organizationId, 'sos.updated', { sosEventId: sos.id });
  }
}

/** What the phone may show (PROD §11.3, INV-10): each state only with its server fact. */
export async function guardSosStatus(
  trx: Database,
  deps: AppDeps,
  guard: SosGuard,
  sosEventId: string,
): Promise<SosStatusResponse> {
  const sos = await ownSos(trx, guard, sosEventId);
  const settings = await organizationSettings(trx, guard.organizationId);
  const alert = await alertForSos(trx, guard.organizationId, sos.id);
  const receipts = alert
    ? await receiptCounts(trx, guard.organizationId, alert.id)
    : { shownOnDashboards: 0, reachedPhones: 0 };
  const alertSentTo = alert ? await sentRecipientCount(trx, guard.organizationId, alert.id) : 0;
  const phase = guardSosPhase({ status: sos.status, alertSentTo, ...receipts });
  return {
    sosEventId: sos.id,
    serverTime: deps.clock.now().toISOString(),
    phase,
    isDrill: sos.isDrill,
    alertSentTo,
    shownInControlRoom: receipts.shownOnDashboards > 0,
    reachedPhones: receipts.reachedPhones,
    acknowledgedBy:
      sos.status === 'ACKNOWLEDGED' || sos.status === 'RESOLVED' ? sos.acknowledgedByName : null,
    acknowledgedAt: sos.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: sos.resolvedAt?.toISOString() ?? null,
    cancelRequestedAt: sos.guardCancelRequestedAt?.toISOString() ?? null,
    trackingUntil: sosTrackingUntil(
      sos.activatedAt,
      numberSetting(settings, 'tracking.sos_max_hours', 4),
    ).toISOString(),
    trackingIntervalS: numberSetting(settings, 'tracking.sos_interval_s', 10),
  };
}

/** The SOS's alert, open or closed (one per SOS, keyed sos:{id}). */
export async function alertForSos(trx: Database, organizationId: string, sosEventId: string) {
  return (
    (await openAlertByKey(trx, organizationId, sosAlertKey(sosEventId))) ??
    lastClosedByKey(trx, organizationId, sosAlertKey(sosEventId))
  );
}

// ── The dashboard's side ──────────────────────────────────────────────────────────────────────

/** Acknowledges the SOS and its alert; stops escalation; tells the guard (PROD §11.3, §11.4). */
export async function acknowledgeSos(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  sosEventId: string,
  user: { userId: string; name: string },
): Promise<{ sos: SosRow; changed: boolean }> {
  const sos = await getSos(trx, organizationId, sosEventId, true);
  if (!sos) throw notFound();
  if (sos.status === 'RESOLVED')
    throw new AppError('ALERT_INVALID_TRANSITION', 'This SOS is already resolved.');
  // Two people at once: the second sees who was first (AL03).
  if (sos.status === 'ACKNOWLEDGED') return { sos, changed: false };
  const now = deps.clock.now();
  await updateSos(
    trx,
    organizationId,
    sos.id,
    { status: 'ACKNOWLEDGED', acknowledgedBy: user.userId, acknowledgedAt: now },
    now,
  );
  const alert = await openAlertByKey(trx, organizationId, sosAlertKey(sos.id));
  if (alert) await acknowledge(trx, deps, organizationId, alert, user.userId);
  await queueGuardPush(trx, deps, organizationId, sos.guardId, {
    topic: 'SOS_GUARD',
    title: sos.isDrill ? '[DRILL] SOS acknowledged' : 'SOS acknowledged',
    body: `Help acknowledged by ${user.name.slice(0, 80)}.`,
    dedupeKey: `sos:${sos.id}:ack:${now.getTime()}`,
    sosEventId: sos.id,
    urgent: true,
  });
  await publish(trx, deps, organizationId, 'sos.updated', { sosEventId: sos.id });
  return { sos: (await getSos(trx, organizationId, sos.id)) ?? sos, changed: true };
}

/** Resolves the SOS with a type and a note (PROD §11.4); records the acknowledgement if none. */
export async function resolveSos(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  sosEventId: string,
  user: { userId: string; name: string },
  resolution: { type: string; note: string },
): Promise<SosRow> {
  const sos = await getSos(trx, organizationId, sosEventId, true);
  if (!sos) throw notFound();
  if (sos.status === 'RESOLVED')
    throw new AppError('ALERT_INVALID_TRANSITION', 'This SOS is already resolved.');
  const now = deps.clock.now();
  await updateSos(
    trx,
    organizationId,
    sos.id,
    {
      status: 'RESOLVED',
      resolvedBy: user.userId,
      resolvedAt: now,
      resolution: resolution.type,
      resolutionNote: resolution.note,
      ...(sos.acknowledgedAt ? {} : { acknowledgedBy: user.userId, acknowledgedAt: now }),
    },
    now,
  );
  const alert = await openAlertByKey(trx, organizationId, sosAlertKey(sos.id));
  if (alert)
    await resolveManually(
      trx,
      deps,
      organizationId,
      alert,
      user.userId,
      `${resolution.type}: ${resolution.note}`.slice(0, 1000),
    );
  await queueGuardPush(trx, deps, organizationId, sos.guardId, {
    topic: 'SOS_GUARD',
    title: sos.isDrill ? '[DRILL] SOS closed' : 'SOS closed',
    body: 'Your SOS was closed by your control room.',
    dedupeKey: `sos:${sos.id}:resolved`,
    sosEventId: sos.id,
    urgent: true,
  });
  await publish(trx, deps, organizationId, 'sos.updated', { sosEventId: sos.id });
  return (await getSos(trx, organizationId, sos.id)) ?? sos;
}
