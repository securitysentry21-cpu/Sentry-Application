// The alert catalog (PROD §12.1) and the conditions behind the detector-driven alerts, as pure data
// and rules. The API applies them (open, count a repeat, reopen, resolve) against the database.

export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const ALERT_TYPES = {
  SOS_ACTIVATED: { severity: 'CRITICAL', dismissible: false, shiftScoped: false },
  INCIDENT_CRITICAL: { severity: 'CRITICAL', dismissible: false, shiftScoped: false },
  INCIDENT_HIGH: { severity: 'HIGH', dismissible: true, shiftScoped: false },
  GUARD_LEFT_SITE: { severity: 'HIGH', dismissible: true, shiftScoped: true },
  TRACKING_DISABLED: { severity: 'HIGH', dismissible: true, shiftScoped: true },
  DEVICE_OFFLINE: { severity: 'MEDIUM', dismissible: true, shiftScoped: true },
  LOCATION_STALE: { severity: 'MEDIUM', dismissible: true, shiftScoped: true },
  SHIFT_NOT_STARTED: { severity: 'MEDIUM', dismissible: true, shiftScoped: false },
  SHIFT_MISSED: { severity: 'HIGH', dismissible: true, shiftScoped: false },
  CHECKPOINT_MISSED: { severity: 'MEDIUM', dismissible: true, shiftScoped: false },
  SUSPICIOUS_LOCATION: { severity: 'MEDIUM', dismissible: true, shiftScoped: false },
  STARTED_OFF_SITE: { severity: 'LOW', dismissible: true, shiftScoped: true },
  SHIFT_OVERRUN: { severity: 'LOW', dismissible: true, shiftScoped: true },
  LOW_BATTERY: { severity: 'LOW', dismissible: true, shiftScoped: true },
  DEVICE_CHANGED: { severity: 'LOW', dismissible: true, shiftScoped: false },
} as const satisfies Record<string, { severity: AlertSeverity; dismissible: boolean; shiftScoped: boolean }>;

export type AlertType = keyof typeof ALERT_TYPES;

export const ALERT_TYPE_NAMES = Object.keys(ALERT_TYPES) as AlertType[];

/** PROD §12.4: these resolve as "shift ended"; the rest wait for a person. */
export const SHIFT_SCOPED_ALERT_TYPES = ALERT_TYPE_NAMES.filter((t) => ALERT_TYPES[t].shiftScoped);

/** Dedupe keys (ARCH §13.2): one open alert per condition and subject. */
export const alertKey = {
  leftSite: (shiftId: string) => `left_site:${shiftId}`,
  offline: (shiftId: string) => `offline:${shiftId}`,
  stale: (shiftId: string) => `stale:${shiftId}`,
  trackingDisabled: (shiftId: string) => `tracking_disabled:${shiftId}`,
  lowBattery: (shiftId: string) => `low_battery:${shiftId}`,
  notStarted: (shiftId: string) => `not_started:${shiftId}`,
  missed: (shiftId: string) => `missed:${shiftId}`,
  offSiteStart: (shiftId: string) => `off_site_start:${shiftId}`,
  overrun: (shiftId: string) => `overrun:${shiftId}`,
  suspicious: (shiftId: string) => `suspicious:${shiftId}`,
} as const;

export type FreshnessAlertSettings = {
  readonly deviceOfflineAfterS: number; // alerts.device_offline_after_s (600)
  readonly locationStaleAfterS: number; // freshness.location_stale_after_s (420)
  /** LOCATION_STALE needs the condition on two consecutive detector runs (PROD §12.1). */
  readonly detectorIntervalS: number;
};

/**
 * Which freshness alerts hold now. DEVICE_OFFLINE: no contact for the offline threshold.
 * LOCATION_STALE: in contact, but the newest usable fix was already older than the threshold at the
 * previous detector run; never while DEVICE_OFFLINE holds. A shift is judged from its start, so one
 * that only just started is not "stale since forever".
 */
export function freshnessConditions(
  now: Date,
  startedAt: Date,
  lastContactAt: Date | null,
  lastFixAt: Date | null,
  s: FreshnessAlertSettings,
): { deviceOffline: boolean; locationStale: boolean } {
  const contactAgeS = (now.getTime() - (lastContactAt ?? startedAt).getTime()) / 1000;
  const fixAgeS = (now.getTime() - (lastFixAt ?? startedAt).getTime()) / 1000;
  const deviceOffline = contactAgeS > s.deviceOfflineAfterS;
  const locationStale = !deviceOffline && fixAgeS > s.locationStaleAfterS + s.detectorIntervalS;
  return { deviceOffline, locationStale };
}

export type DeviceReport = {
  readonly locationPermission: string;
  readonly preciseLocation: boolean;
  readonly locationServicesEnabled: boolean;
  readonly trackingServiceState: string;
  readonly batteryPct?: number | undefined;
  readonly isCharging?: boolean | undefined;
};

/**
 * TRACKING_DISABLED (PROD §12.1): background permission removed, location services off, approximate
 * location only, or the tracking service stopped.
 */
export function trackingDisabled(r: DeviceReport): boolean {
  return (
    r.locationPermission !== 'ALWAYS' ||
    !r.preciseLocation ||
    !r.locationServicesEnabled ||
    r.trackingServiceState === 'STOPPED' ||
    r.trackingServiceState === 'PERMISSION_PROBLEM'
  );
}

/** LOW_BATTERY opens at ≤ the threshold while not charging and clears when charging or above 25%. */
export function batteryCondition(r: DeviceReport, lowAlertPct: number): 'LOW' | 'CLEARED' | 'UNCHANGED' {
  if (r.batteryPct === undefined) return 'UNCHANGED';
  if (r.isCharging === true || r.batteryPct > Math.max(25, lowAlertPct)) return 'CLEARED';
  if (r.batteryPct <= lowAlertPct) return 'LOW';
  return 'UNCHANGED';
}
