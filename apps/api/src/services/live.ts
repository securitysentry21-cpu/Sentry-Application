// Live state for the dashboard (PROD §8.3, §14; D-36): one shape for the snapshot, the realtime
// stream and a guard's live location, so the three can never disagree.
import type { LiveGuard } from '@sentryops/contracts';
import { locationAge, trackingHealth, type FreshnessSettings } from '@sentryops/domain';

import { numberSetting } from '../repositories/organizations.ts';
import type { LiveRow } from '../repositories/tracking.ts';

export function freshnessFrom(settings: Record<string, unknown>): FreshnessSettings {
  return {
    healthLiveMaxS: numberSetting(settings, 'freshness.health_live_max_s', 90),
    offlineAfterS: numberSetting(settings, 'freshness.offline_after_s', 300),
    locationCurrentMaxS: numberSetting(settings, 'freshness.location_current_max_s', 150),
  };
}

export function liveGuardDto(r: LiveRow, now: Date, f: FreshnessSettings): LiveGuard {
  return {
    shiftId: r.shift_id,
    guard: { id: r.guard_id, displayName: r.display_name, employeeNumber: r.employee_number },
    site: { id: r.site_id, name: r.site_name, timezone: r.site_timezone },
    startsAt: r.starts_at.toISOString(),
    startedAt: r.actual_started_at?.toISOString() ?? null,
    endsAt: r.ends_at.toISOString(),
    manualStart: r.start_source === 'SUPERVISOR_MANUAL',
    startFlags: r.start_flags,
    lastFix:
      r.last_fix_latitude !== null && r.last_fix_longitude !== null && r.last_fix_captured_at
        ? {
            lat: r.last_fix_latitude,
            lng: r.last_fix_longitude,
            accuracyM: r.last_fix_accuracy_m,
            capturedAt: r.last_fix_captured_at.toISOString(),
          }
        : null,
    lastContactAt: r.last_contact_at?.toISOString() ?? null,
    trackingHealth: trackingHealth(now, r.last_contact_at, f),
    locationAge: locationAge(now, r.last_fix_captured_at, f),
    geofenceState: (r.geofence_state ?? 'UNKNOWN') as LiveGuard['geofenceState'],
    trackingServiceState: r.tracking_service_state,
    locationPermission: r.location_permission,
    batteryPct: r.battery_pct,
    isCharging: r.is_charging,
    appVersion: r.app_version,
    pendingQueueCount: r.pending_queue_count,
    deviceReportAt: r.device_report_at?.toISOString() ?? null,
  };
}
