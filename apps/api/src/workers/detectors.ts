// Shift detectors (ARCH §16.2, PROD §6.6–§6.7), every 60 seconds:
//   SCHEDULED past its start deadline → MISSED;  ACTIVE past end + auto_end_after → COMPLETED.
// The sweep only enumerates due work across organizations, as system_worker (read-only policy on a
// few columns). Each change then runs in that organization's own tenant transaction as app_runtime,
// through the shared state machine (ARCH §4.5, ADV-T07). Missed runs are harmless: the conditions
// compare with now, so the next run catches up.
import { withTenantTransaction, type Database } from '@sentryops/db';
import { alertKey, freshnessConditions, SHIFT_SCOPED_ALERT_TYPES } from '@sentryops/domain';

import type { AppDeps } from '../deps.ts';
import {
  activeShiftsForDetectors,
  lateScheduledShifts,
  openAlertsOnShiftsNotIn,
  staleNotStartedAlerts,
} from '../repositories/alerts.ts';
import { numberSetting, organizationSettings } from '../repositories/organizations.ts';
import { dueShifts, organizationsWithLiveShifts, type DueShift } from '../repositories/sweeps.ts';
import { clearAlert, ensureAlert, reopenSuppressionMs } from '../services/alerts.ts';
import { systemTransition } from '../services/shifts.ts';

export type DetectorDeps = AppDeps & { readonly sweep: Database };

/** The minimum auto-end delay any organization may set (PROD App. B: 15–240 min). */
const MIN_AUTO_END_MS = 15 * 60_000;
const BATCH = 500;

/** Applies due transitions for one organization; a shift of another organization is never touched. */
export async function applyForOrganization(
  deps: AppDeps,
  organizationId: string,
  due: readonly DueShift[],
): Promise<number> {
  return withTenantTransaction(deps.db, organizationId, async (trx) => {
    let changed = 0;
    for (const item of due) {
      if (await systemTransition(trx, deps, organizationId, item.id, { type: item.kind })) changed++;
    }
    return changed;
  });
}

export async function runShiftDetectors(deps: DetectorDeps): Promise<{ examined: number; changed: number }> {
  const now = deps.clock.now();
  const due = await dueShifts(deps.sweep, now, new Date(now.getTime() - MIN_AUTO_END_MS), BATCH);
  const byOrganization = new Map<string, DueShift[]>();
  for (const item of due) {
    byOrganization.set(item.organization_id, [...(byOrganization.get(item.organization_id) ?? []), item]);
  }
  let changed = 0;
  for (const [organizationId, items] of byOrganization) {
    changed += await applyForOrganization(deps, organizationId, items);
  }
  return { examined: due.length, changed };
}

/** How often the detectors run; LOCATION_STALE needs two consecutive runs (PROD §12.1). */
export const DETECTOR_INTERVAL_S = 60;

/**
 * Alert detectors for one organization (PROD §12.1, ARCH §16.2): DEVICE_OFFLINE, LOCATION_STALE,
 * SHIFT_OVERRUN and SHIFT_NOT_STARTED, plus a sweep that closes anything a shift change missed.
 * Each condition is re-checked every run; ensureAlert makes that idempotent.
 */
export async function alertsForOrganization(
  deps: AppDeps,
  organizationId: string,
  intervalS = DETECTOR_INTERVAL_S,
): Promise<void> {
  await withTenantTransaction(deps.db, organizationId, async (trx) => {
    const settings = await organizationSettings(trx, organizationId);
    const suppressionMs = reopenSuppressionMs(settings);
    const now = deps.clock.now();
    const freshness = {
      deviceOfflineAfterS: numberSetting(settings, 'alerts.device_offline_after_s', 600),
      locationStaleAfterS: numberSetting(settings, 'freshness.location_stale_after_s', 420),
      detectorIntervalS: intervalS,
    };
    const overrunMs = numberSetting(settings, 'shift.overrun_alert_after_minutes', 15) * 60_000;
    const lateMs = numberSetting(settings, 'shift.late_alert_after_minutes', 10) * 60_000;

    for (const sh of await activeShiftsForDetectors(trx, organizationId)) {
      const startedAt = sh.actual_started_at ?? sh.starts_at;
      const subject = { guardId: sh.guard_id, siteId: sh.site_id, shiftId: sh.id };
      const who = `${sh.guard_name} (${sh.site_name})`;
      const c = freshnessConditions(now, startedAt, sh.last_contact_at, sh.last_fix_captured_at, freshness);
      if (c.deviceOffline) {
        await ensureAlert(
          trx,
          deps,
          organizationId,
          {
            type: 'DEVICE_OFFLINE',
            dedupeKey: alertKey.offline(sh.id),
            summary: `Device offline: ${who}`,
            ...subject,
            details: { lastContactAt: sh.last_contact_at?.toISOString() ?? null },
            since: sh.last_contact_at ?? startedAt,
          },
          suppressionMs,
        );
      } else {
        await clearAlert(trx, deps, organizationId, alertKey.offline(sh.id), 'CONDITION_CLEARED');
        // Suppressed while offline: only judged with contact (PROD §12.1).
        if (c.locationStale) {
          await ensureAlert(
            trx,
            deps,
            organizationId,
            {
              type: 'LOCATION_STALE',
              dedupeKey: alertKey.stale(sh.id),
              summary: `Location stale: ${who}`,
              ...subject,
              details: { lastFixAt: sh.last_fix_captured_at?.toISOString() ?? null },
              since: sh.last_fix_captured_at ?? startedAt,
            },
            suppressionMs,
          );
        } else {
          await clearAlert(trx, deps, organizationId, alertKey.stale(sh.id), 'CONDITION_CLEARED');
        }
      }
      if (now.getTime() >= sh.ends_at.getTime() + overrunMs) {
        await ensureAlert(
          trx,
          deps,
          organizationId,
          {
            type: 'SHIFT_OVERRUN',
            dedupeKey: alertKey.overrun(sh.id),
            summary: `Shift not ended: ${who}`,
            ...subject,
            details: { endsAt: sh.ends_at.toISOString() },
            since: sh.ends_at,
          },
          suppressionMs,
        );
      }
    }

    const lateBefore = new Date(now.getTime() - lateMs);
    for (const sh of await lateScheduledShifts(trx, organizationId, lateBefore, now)) {
      await ensureAlert(
        trx,
        deps,
        organizationId,
        {
          type: 'SHIFT_NOT_STARTED',
          dedupeKey: alertKey.notStarted(sh.id),
          summary: `Shift not started: ${sh.guard_name} (${sh.site_name})`,
          guardId: sh.guard_id,
          siteId: sh.site_id,
          shiftId: sh.id,
          details: { startsAt: sh.starts_at.toISOString() },
          since: sh.starts_at,
        },
        suppressionMs,
      );
    }

    // Safety net for paths that changed a shift without the alert hook.
    for (const a of await openAlertsOnShiftsNotIn(trx, organizationId, SHIFT_SCOPED_ALERT_TYPES, [
      'ACTIVE',
    ])) {
      await clearAlert(trx, deps, organizationId, a.dedupe_key, 'SHIFT_ENDED');
    }
    for (const a of await staleNotStartedAlerts(trx, organizationId, lateBefore)) {
      await clearAlert(
        trx,
        deps,
        organizationId,
        a.dedupe_key,
        a.shift_status === 'MISSED' ? 'SUPERSEDED' : 'CONDITION_CLEARED',
      );
    }
  });
}

export async function runAlertDetectors(deps: DetectorDeps): Promise<{ organizations: number }> {
  const organizations = await organizationsWithLiveShifts(deps.sweep, deps.clock.now(), BATCH);
  for (const organizationId of organizations) await alertsForOrganization(deps, organizationId);
  return { organizations: organizations.length };
}
