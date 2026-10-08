// DEVICE_STATUS (ARCH §8.4): what the phone says about itself. Sent at once when something that
// matters changes (permission, precise location, location services, notifications, power saver,
// charging, battery thresholds, the tracking service), and periodically with the heartbeats. Only
// the fields of the contract's deviceStatusSchema, nothing else about the phone (SEC §16.2).
import type { DeviceStatus, LOCATION_PERMISSIONS, TRACKING_SERVICE_STATES } from '@sentryops/contracts';

export type LocationPermissionLevel = (typeof LOCATION_PERMISSIONS)[number];
export type TrackingServiceState = (typeof TRACKING_SERVICE_STATES)[number];

/** What the platform adapters read from the phone. */
export type DeviceProbe = {
  readonly locationPermission: LocationPermissionLevel;
  readonly preciseLocation: boolean;
  readonly locationServicesEnabled: boolean;
  readonly notificationsEnabled?: boolean | undefined;
  /** 0–100, or undefined when the platform does not report it. */
  readonly batteryPct?: number | undefined;
  readonly isCharging?: boolean | undefined;
  readonly powerSaveMode?: boolean | undefined;
  readonly batteryOptimizationExempt?: boolean | null | undefined;
  readonly osVersion?: string | undefined;
};

export type QueueFacts = {
  readonly pendingQueueCount: number;
  readonly oldestPendingAt: string | null;
  readonly lastSuccessfulSyncAt: string | null;
};

/** Battery thresholds that count as a change worth reporting at once (PROD §12.1 LOW_BATTERY at 15 %). */
export const BATTERY_THRESHOLDS = [50, 25, 20, 15, 10, 5] as const;

export function batteryBand(pct: number | undefined): number | null {
  if (pct === undefined || !Number.isFinite(pct)) return null;
  let band = 100;
  for (const t of BATTERY_THRESHOLDS) if (pct <= t) band = t;
  return band;
}

/** How the phone describes its tracking service to the server. */
export function trackingServiceState(probe: DeviceProbe, running: boolean | null): TrackingServiceState {
  const permissionOk = probe.locationPermission === 'ALWAYS' || probe.locationPermission === 'WHEN_IN_USE';
  if (!permissionOk || !probe.locationServicesEnabled) return 'PERMISSION_PROBLEM';
  if (running === null) return 'UNKNOWN';
  return running ? 'RUNNING' : 'STOPPED';
}

export function buildDeviceStatus(
  probe: DeviceProbe,
  service: TrackingServiceState,
  queue: QueueFacts | null,
): DeviceStatus {
  const status: DeviceStatus = {
    locationPermission: probe.locationPermission,
    preciseLocation: probe.preciseLocation,
    locationServicesEnabled: probe.locationServicesEnabled,
    trackingServiceState: service,
  };
  if (probe.notificationsEnabled !== undefined) status.notificationsEnabled = probe.notificationsEnabled;
  if (probe.batteryPct !== undefined && probe.batteryPct >= 0 && probe.batteryPct <= 100) {
    status.batteryPct = Math.round(probe.batteryPct);
  }
  if (probe.isCharging !== undefined) status.isCharging = probe.isCharging;
  if (probe.powerSaveMode !== undefined) status.powerSaveMode = probe.powerSaveMode;
  if (probe.batteryOptimizationExempt !== undefined)
    status.batteryOptimizationExempt = probe.batteryOptimizationExempt;
  if (probe.osVersion) status.osVersion = probe.osVersion.slice(0, 40);
  if (queue) {
    status.pendingQueueCount = queue.pendingQueueCount;
    status.oldestPendingAt = queue.oldestPendingAt;
    status.lastSuccessfulSyncAt = queue.lastSuccessfulSyncAt;
  }
  return status;
}

/** True when `next` differs from what was last sent in a way the server should hear about now. */
export function significantChange(previous: DeviceStatus | null, next: DeviceStatus): boolean {
  if (!previous) return true;
  return (
    previous.locationPermission !== next.locationPermission ||
    previous.preciseLocation !== next.preciseLocation ||
    previous.locationServicesEnabled !== next.locationServicesEnabled ||
    previous.trackingServiceState !== next.trackingServiceState ||
    previous.notificationsEnabled !== next.notificationsEnabled ||
    previous.powerSaveMode !== next.powerSaveMode ||
    previous.isCharging !== next.isCharging ||
    previous.batteryOptimizationExempt !== next.batteryOptimizationExempt ||
    batteryBand(previous.batteryPct) !== batteryBand(next.batteryPct)
  );
}

/** A tracking problem the guard must see (PROD §7.6), most serious first; null when none. */
export type TrackingProblem =
  'LOCATION_SERVICES_OFF' | 'PERMISSION_DENIED' | 'NOT_ALWAYS' | 'APPROXIMATE_ONLY';

export function trackingProblem(probe: DeviceProbe): TrackingProblem | null {
  if (!probe.locationServicesEnabled) return 'LOCATION_SERVICES_OFF';
  if (probe.locationPermission !== 'ALWAYS' && probe.locationPermission !== 'WHEN_IN_USE')
    return 'PERMISSION_DENIED';
  if (!probe.preciseLocation) return 'APPROXIMATE_ONLY';
  if (probe.locationPermission !== 'ALWAYS') return 'NOT_ALWAYS';
  return null;
}
