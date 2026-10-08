// The geofence evaluator (ARCH §10, PROD §8.4). Runs after each sync batch, per shift that received
// points, in the batch's transaction: it reads the shift's points after its watermark in capture
// order, steps the pure state machine, writes ENTERED_SITE / LEFT_SITE shift events and opens or
// resolves GUARD_LEFT_SITE. An excursion that started and ended within data that arrived together
// (an offline backlog) is recorded as "detected after sync" and raises no live alert.
import type { Database } from '@sentryops/db';
import {
  alertKey,
  INITIAL_GEOFENCE,
  stepGeofence,
  type GeofenceEvent,
  type GeofenceMemory,
  type GeofenceSettings,
  type GeofenceState,
} from '@sentryops/domain';

import type { AppDeps } from '../deps.ts';
import { uuidv7 } from '../ids.ts';
import { numberSetting } from '../repositories/organizations.ts';
import { insertShiftEvent, type ShiftRow } from '../repositories/shifts.ts';
import { geofenceMemory, pointsAfter, saveGeofenceMemory } from '../repositories/tracking.ts';
import { clearAlert, raiseAlert, reopenSuppressionMs } from './alerts.ts';

const MAX_POINTS_PER_RUN = 5_000;
/** A departure confirmed from points older than this at receipt was detected late. */
const LATE_MS = 5 * 60_000;

export function geofenceSettingsFrom(settings: Record<string, unknown>): GeofenceSettings {
  return {
    maxUsableAccuracyM: numberSetting(settings, 'geofence.max_usable_accuracy_m', 100),
    outsideBufferM: numberSetting(settings, 'geofence.outside_buffer_m', 25),
    departurePersistenceS: numberSetting(settings, 'geofence.departure_persistence_s', 300),
    departureMinPoints: numberSetting(settings, 'geofence.departure_min_points', 3),
    returnAccuracyM: numberSetting(settings, 'geofence.return_accuracy_m', 50),
  };
}

export async function evaluateGeofence(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  shift: ShiftRow,
  settings: Record<string, unknown>,
): Promise<GeofenceEvent[]> {
  const stored = await geofenceMemory(trx, organizationId, shift.id);
  if (!stored) return [];
  const points = await pointsAfter(trx, organizationId, shift.id, stored.watermarkAt, MAX_POINTS_PER_RUN);
  if (points.length === 0) return [];

  const s = geofenceSettingsFrom(settings);
  let memory: GeofenceMemory = {
    ...INITIAL_GEOFENCE,
    state: stored.state as GeofenceState,
    outsideSince: stored.outsideSince,
    outsidePoints: stored.outsidePoints,
    insideStreak: stored.insideStreak,
  };
  const events: GeofenceEvent[] = [];
  for (const p of points) {
    const step = stepGeofence(
      memory,
      shift.siteBoundary,
      { lat: p.latitude, lng: p.longitude, accuracyM: p.accuracy_m, capturedAt: p.captured_at },
      s,
    );
    memory = step.memory;
    if (step.event) events.push(step.event);
  }
  const now = deps.clock.now();
  const last = points.at(-1);
  await saveGeofenceMemory(
    trx,
    organizationId,
    shift.id,
    { ...memory, watermarkAt: last ? last.captured_at : stored.watermarkAt },
    now,
  );

  const suppressionMs = reopenSuppressionMs(settings);
  for (const [i, e] of events.entries()) {
    const next = events[i + 1];
    const previous = events[i - 1];
    // A departure and its return in the same delivery: history only (PROD §8.4).
    const pastExcursion =
      (e.type === 'LEFT_SITE' && next?.type === 'ENTERED_SITE') ||
      (e.type === 'ENTERED_SITE' && previous?.type === 'LEFT_SITE');
    await insertShiftEvent(trx, {
      id: uuidv7(deps.clock),
      organizationId,
      shiftId: shift.id,
      type: e.type,
      actorType: 'SYSTEM',
      actorUserId: null,
      deviceId: null,
      clientEventId: null,
      occurredAt: e.at,
      clientRecordedAt: null,
      payload:
        e.type === 'LEFT_SITE'
          ? { since: e.since.toISOString(), detectedAfterSync: pastExcursion }
          : { outsideSeconds: e.outsideSeconds, detectedAfterSync: pastExcursion },
    });
    if (pastExcursion) continue;
    if (e.type === 'LEFT_SITE') {
      await raiseAlert(
        trx,
        deps,
        organizationId,
        {
          type: 'GUARD_LEFT_SITE',
          dedupeKey: alertKey.leftSite(shift.id),
          summary: `Guard left site: ${shift.guardName} (${shift.siteName})`,
          guardId: shift.guardId,
          siteId: shift.siteId,
          shiftId: shift.id,
          details: { outsideSince: e.since.toISOString() },
          detectedLate: now.getTime() - e.at.getTime() > LATE_MS,
        },
        suppressionMs,
      );
    } else {
      await clearAlert(trx, deps, organizationId, alertKey.leftSite(shift.id), 'CONDITION_CLEARED', {
        outsideSeconds: e.outsideSeconds,
      });
    }
  }
  // Starting off site clears once the guard is seen inside (PROD §12.1).
  if (memory.state === 'INSIDE') {
    await clearAlert(trx, deps, organizationId, alertKey.offSiteStart(shift.id), 'CONDITION_CLEARED');
  }
  return events;
}
