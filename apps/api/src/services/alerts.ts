// The alert engine (PROD §12, ARCH §13.2). Rules decide; this applies their intents inside the
// caller's tenant transaction against the partial unique index on open dedupe keys:
//   - raise: an event happened. Counts a repeat on the open alert (AL01), reopens one that cleared
//     within the suppression window (PROD §12.3), or opens a new one.
//   - ensure: a condition holds (detectors re-check it every run). Opens or reopens like raise, but a
//     run that finds it still open changes nothing, and an episode a person already closed stays closed.
//   - clear: a condition cleared, or its shift ended (PROD §12.4).
// Manual changes (acknowledge, resolve, dismiss) are audited by the routes; acknowledgement is
// idempotent and keeps the first person (AL03).
import type { Database } from '@sentryops/db';
import {
  ALERT_TYPES,
  alertKey,
  batteryCondition,
  SHIFT_SCOPED_ALERT_TYPES,
  trackingDisabled,
  type AlertType,
  type DeviceReport,
} from '@sentryops/domain';

import type { AppDeps } from '../deps.ts';
import { uuidv7 } from '../ids.ts';
import {
  insertAlert,
  insertAlertEvent,
  lastClosedByKey,
  openAlertByKey,
  openShiftScopedAlerts,
  updateAlert,
  type AlertRow,
  type ResolutionType,
} from '../repositories/alerts.ts';
import { numberSetting, organizationSettings } from '../repositories/organizations.ts';
import type { ShiftRow } from '../repositories/shifts.ts';
import { lastGoodReportAt } from '../repositories/tracking.ts';

export type AlertIntent = {
  readonly type: AlertType;
  readonly dedupeKey: string;
  readonly summary: string;
  readonly guardId?: string | null;
  readonly siteId?: string | null;
  readonly shiftId?: string | null;
  readonly details?: Record<string, unknown>;
  /** When the condition started (ensure): an episode closed by a person after this stays closed. */
  readonly since?: Date;
  readonly detectedLate?: boolean;
};

export type RaiseOutcome = { alertId: string; outcome: 'OPENED' | 'RETRIGGERED' | 'REOPENED' | 'UNCHANGED' };

export function reopenSuppressionMs(settings: Record<string, unknown>): number {
  return numberSetting(settings, 'alerts.reopen_suppression_s', 120) * 1000;
}

async function apply(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  intent: AlertIntent,
  mode: 'raise' | 'ensure',
  suppressionMs: number,
): Promise<RaiseOutcome | null> {
  const now = deps.clock.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const open = await openAlertByKey(trx, organizationId, intent.dedupeKey);
    if (open) {
      if (mode === 'ensure') return { alertId: open.id, outcome: 'UNCHANGED' };
      await updateAlert(trx, organizationId, open.id, { lastTriggeredAt: now, incrementTrigger: true }, now);
      await event(trx, deps, organizationId, open.id, 'RETRIGGERED', null, intent.details);
      return { alertId: open.id, outcome: 'RETRIGGERED' };
    }
    const last = await lastClosedByKey(trx, organizationId, intent.dedupeKey);
    if (last) {
      const closedAt = last.resolvedAt ?? last.dismissedAt;
      const byPerson = last.status === 'DISMISSED' || last.resolutionType === 'MANUAL';
      // A person dealt with this episode: the same continuing condition doesn't come back.
      if (mode === 'ensure' && byPerson && intent.since && closedAt && closedAt >= intent.since) return null;
      if (
        last.status === 'RESOLVED' &&
        last.resolutionType === 'CONDITION_CLEARED' &&
        closedAt &&
        now.getTime() - closedAt.getTime() <= suppressionMs
      ) {
        await updateAlert(
          trx,
          organizationId,
          last.id,
          {
            status: last.acknowledgedAt ? 'ACKNOWLEDGED' : 'OPEN',
            resolvedAt: null,
            resolvedBy: null,
            resolutionType: null,
            resolutionNote: null,
            lastTriggeredAt: now,
            incrementTrigger: true,
          },
          now,
        );
        await event(trx, deps, organizationId, last.id, 'REOPENED', null, intent.details);
        return { alertId: last.id, outcome: 'REOPENED' };
      }
    }
    const id = uuidv7(deps.clock);
    const inserted = await insertAlert(trx, {
      id,
      organizationId,
      type: intent.type,
      severity: ALERT_TYPES[intent.type].severity,
      dedupeKey: intent.dedupeKey,
      summary: intent.summary,
      guardId: intent.guardId ?? null,
      siteId: intent.siteId ?? null,
      shiftId: intent.shiftId ?? null,
      details: intent.details ?? {},
      at: now,
      detectedLate: intent.detectedLate ?? false,
    });
    if (inserted) {
      await event(trx, deps, organizationId, id, 'OPENED', null, intent.details);
      deps.metrics.increment(`alert_opened_${intent.type.toLowerCase()}`);
      return { alertId: id, outcome: 'OPENED' };
    }
    // Lost a race with a concurrent opener: go round again and count on theirs.
  }
  throw new Error('alert dedupe did not settle');
}

/** An event happened (a departure, an SOS): one open alert per key, repeats counted. */
export function raiseAlert(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  intent: AlertIntent,
  suppressionMs: number,
): Promise<RaiseOutcome | null> {
  return apply(trx, deps, organizationId, intent, 'raise', suppressionMs);
}

/** A condition holds; detectors call this every run. */
export function ensureAlert(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  intent: AlertIntent,
  suppressionMs: number,
): Promise<RaiseOutcome | null> {
  return apply(trx, deps, organizationId, intent, 'ensure', suppressionMs);
}

/** Resolves the open alert for a key, if any, by the system. */
export async function clearAlert(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  dedupeKey: string,
  resolution: Exclude<ResolutionType, 'MANUAL'>,
  details?: Record<string, unknown>,
): Promise<AlertRow | null> {
  const open = await openAlertByKey(trx, organizationId, dedupeKey);
  if (!open) return null;
  await systemResolve(trx, deps, organizationId, open, resolution, details);
  return open;
}

async function systemResolve(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  alert: AlertRow,
  resolution: Exclude<ResolutionType, 'MANUAL'>,
  details?: Record<string, unknown>,
): Promise<void> {
  const now = deps.clock.now();
  await updateAlert(
    trx,
    organizationId,
    alert.id,
    {
      status: 'RESOLVED',
      resolvedAt: now,
      resolvedBy: null,
      resolutionType: resolution,
      ...(details ? { details: { ...alert.details, ...details } } : {}),
    },
    now,
  );
  await event(trx, deps, organizationId, alert.id, 'AUTO_RESOLVED', null, { resolution, ...details });
}

/** PROD §12.4: a shift's condition alerts resolve as "shift ended" when it ends. */
export async function resolveShiftAlerts(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  shiftId: string,
): Promise<number> {
  const open = await openShiftScopedAlerts(trx, organizationId, shiftId, SHIFT_SCOPED_ALERT_TYPES);
  for (const alert of open) await systemResolve(trx, deps, organizationId, alert, 'SHIFT_ENDED');
  return open.length;
}

async function event(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  alertId: string,
  type: Parameters<typeof insertAlertEvent>[1]['type'],
  actorUserId: string | null,
  payload?: Record<string, unknown>,
  note?: string | null,
): Promise<void> {
  await insertAlertEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId,
    alertId,
    type,
    actorUserId,
    note: note ?? null,
    payload: payload ?? {},
    at: deps.clock.now(),
  });
}

export type ManualOutcome =
  | { readonly ok: true; readonly alert: AlertRow; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'CLOSED' | 'NOT_DISMISSIBLE' };

/** Idempotent: a second acknowledgement succeeds and shows who acknowledged first (AL03). */
export async function acknowledge(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  alert: AlertRow,
  userId: string,
): Promise<ManualOutcome> {
  if (alert.status === 'ACKNOWLEDGED') return { ok: true, alert, changed: false };
  if (alert.status !== 'OPEN') return { ok: false, reason: 'CLOSED' };
  const now = deps.clock.now();
  await updateAlert(
    trx,
    organizationId,
    alert.id,
    { status: 'ACKNOWLEDGED', acknowledgedBy: userId, acknowledgedAt: now },
    now,
  );
  await event(trx, deps, organizationId, alert.id, 'ACKNOWLEDGED', userId);
  return { ok: true, alert, changed: true };
}

export async function resolveManually(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  alert: AlertRow,
  userId: string,
  note: string | null,
): Promise<ManualOutcome> {
  if (alert.status !== 'OPEN' && alert.status !== 'ACKNOWLEDGED') return { ok: false, reason: 'CLOSED' };
  const now = deps.clock.now();
  await updateAlert(
    trx,
    organizationId,
    alert.id,
    {
      status: 'RESOLVED',
      resolvedAt: now,
      resolvedBy: userId,
      resolutionType: 'MANUAL',
      resolutionNote: note,
      ...(alert.acknowledgedAt ? {} : { acknowledgedAt: now, acknowledgedBy: userId }),
    },
    now,
  );
  await event(trx, deps, organizationId, alert.id, 'RESOLVED', userId, {}, note);
  return { ok: true, alert, changed: true };
}

/** PROD §12.2: a reason is required, and SOS and critical incidents can't be dismissed. */
export async function dismiss(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  alert: AlertRow,
  userId: string,
  reason: string,
): Promise<ManualOutcome> {
  if (!ALERT_TYPES[alert.type].dismissible) return { ok: false, reason: 'NOT_DISMISSIBLE' };
  if (alert.status !== 'OPEN' && alert.status !== 'ACKNOWLEDGED') return { ok: false, reason: 'CLOSED' };
  const now = deps.clock.now();
  await updateAlert(
    trx,
    organizationId,
    alert.id,
    { status: 'DISMISSED', dismissedAt: now, dismissedBy: userId, dismissReason: reason },
    now,
  );
  await event(trx, deps, organizationId, alert.id, 'DISMISSED', userId, {}, reason);
  return { ok: true, alert, changed: true };
}

export function alertDto(a: AlertRow) {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    status: a.status,
    summary: a.summary,
    guard: a.guardId ? { id: a.guardId, displayName: a.guardName ?? '' } : null,
    site: a.siteId ? { id: a.siteId, name: a.siteName ?? '' } : null,
    shiftId: a.shiftId,
    details: a.details,
    openedAt: a.openedAt.toISOString(),
    lastTriggeredAt: a.lastTriggeredAt.toISOString(),
    triggerCount: a.triggerCount,
    acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: a.acknowledgedBy ? { id: a.acknowledgedBy, name: a.acknowledgedByName ?? '' } : null,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    resolutionType: a.resolutionType,
    resolutionNote: a.resolutionNote,
    dismissedAt: a.dismissedAt?.toISOString() ?? null,
    dismissReason: a.dismissReason,
    detectedLate: a.detectedLate,
    dismissible: ALERT_TYPES[a.type].dismissible,
    version: a.version,
  };
}

/** TRACKING_DISABLED and LOW_BATTERY follow each device report during an active shift. */
export async function deviceReportAlerts(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  shift: ShiftRow,
  report: DeviceReport,
  settings: Record<string, unknown>,
): Promise<void> {
  const suppressionMs = reopenSuppressionMs(settings);
  const now = deps.clock.now();
  const subject = { guardId: shift.guardId, siteId: shift.siteId, shiftId: shift.id };
  if (trackingDisabled(report)) {
    await ensureAlert(
      trx,
      deps,
      organizationId,
      {
        type: 'TRACKING_DISABLED',
        dedupeKey: alertKey.trackingDisabled(shift.id),
        summary: `Tracking disabled: ${shift.guardName} (${shift.siteName})`,
        ...subject,
        details: {
          locationPermission: report.locationPermission,
          preciseLocation: report.preciseLocation,
          locationServicesEnabled: report.locationServicesEnabled,
          trackingServiceState: report.trackingServiceState,
        },
        since:
          (await lastGoodReportAt(trx, organizationId, shift.id, 'TRACKING')) ?? shift.actualStartedAt ?? now,
      },
      suppressionMs,
    );
  } else {
    await clearAlert(trx, deps, organizationId, alertKey.trackingDisabled(shift.id), 'CONDITION_CLEARED');
  }
  const battery = batteryCondition(report, numberSetting(settings, 'battery.low_alert_pct', 15));
  if (battery === 'LOW') {
    await ensureAlert(
      trx,
      deps,
      organizationId,
      {
        type: 'LOW_BATTERY',
        dedupeKey: alertKey.lowBattery(shift.id),
        summary: `Low battery: ${shift.guardName} (${shift.siteName})`,
        ...subject,
        details: { batteryPct: report.batteryPct },
        since:
          (await lastGoodReportAt(trx, organizationId, shift.id, 'BATTERY')) ?? shift.actualStartedAt ?? now,
      },
      suppressionMs,
    );
  } else if (battery === 'CLEARED') {
    await clearAlert(trx, deps, organizationId, alertKey.lowBattery(shift.id), 'CONDITION_CLEARED');
  }
}

/**
 * The alert side of a shift change (PROD §12.1, §12.4), called with the updated shift by every path
 * that changes a shift's status. The detectors also sweep for anything a path missed.
 */
export async function onShiftChanged(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  shift: ShiftRow,
): Promise<void> {
  const settings = await organizationSettings(trx, organizationId);
  const suppressionMs = reopenSuppressionMs(settings);
  const subject = { guardId: shift.guardId, siteId: shift.siteId, shiftId: shift.id };
  switch (shift.status) {
    case 'ACTIVE':
      await clearAlert(trx, deps, organizationId, alertKey.notStarted(shift.id), 'CONDITION_CLEARED');
      // A late offline start clears a missed shift (PROD §12.1).
      await clearAlert(trx, deps, organizationId, alertKey.missed(shift.id), 'CONDITION_CLEARED');
      if (shift.startGeofenceClass === 'OUTSIDE') {
        await raiseAlert(
          trx,
          deps,
          organizationId,
          {
            type: 'STARTED_OFF_SITE',
            dedupeKey: alertKey.offSiteStart(shift.id),
            summary: `Started off site: ${shift.guardName} (${shift.siteName})`,
            ...subject,
            details: { distanceM: shift.startDistanceM },
          },
          suppressionMs,
        );
      }
      return;
    case 'MISSED':
      await clearAlert(trx, deps, organizationId, alertKey.notStarted(shift.id), 'SUPERSEDED');
      await raiseAlert(
        trx,
        deps,
        organizationId,
        {
          type: 'SHIFT_MISSED',
          dedupeKey: alertKey.missed(shift.id),
          summary: `Shift missed: ${shift.guardName} (${shift.siteName})`,
          ...subject,
          details: { startsAt: shift.startsAt.toISOString() },
        },
        suppressionMs,
      );
      return;
    case 'COMPLETED':
    case 'CANCELLED':
      await clearAlert(trx, deps, organizationId, alertKey.notStarted(shift.id), 'CONDITION_CLEARED');
      await resolveShiftAlerts(trx, deps, organizationId, shift.id);
      return;
    default:
      return;
  }
}
