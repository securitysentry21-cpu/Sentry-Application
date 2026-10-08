// The pre-shift readiness check (PROD §7.4): shown before Start Shift and on demand. Blocking items
// stop the guard from starting on this phone (a supervisor's manual start is the override); warnings
// are shown but allow the start. The fresh-fix item is checked as part of starting (the fix taken
// for the start itself), and readiness fixes never leave the phone (SEC §16.2).
import type { MobileConfig } from '@sentryops/contracts';

import type { DeviceProbe } from './device-status.ts';

export type ReadinessKey =
  | 'SIGNED_IN'
  | 'APP_VERSION'
  | 'CONSENT'
  | 'LOCATION_SERVICES'
  | 'LOCATION_ALWAYS'
  | 'PRECISE_LOCATION'
  | 'NOTIFICATIONS'
  | 'BATTERY_OPTIMIZATION'
  | 'BATTERY_LEVEL'
  | 'NETWORK'
  | 'CLOCK';

export type ReadinessLevel = 'OK' | 'WARNING' | 'BLOCKING';
export type ReadinessItem = { readonly key: ReadinessKey; readonly level: ReadinessLevel };

export type ReadinessInput = {
  readonly signedIn: boolean;
  readonly versionBlocked: boolean;
  readonly consentCurrent: boolean;
  readonly probe: DeviceProbe | null;
  /** From the OS; only a hint, never proof that data will get through. */
  readonly networkAvailable: boolean | null;
  readonly clockSkewed: boolean;
  readonly platform: 'ANDROID' | 'IOS';
};

export function readiness(input: ReadinessInput, shift: MobileConfig['shift']): ReadinessItem[] {
  const permissionPolicy: ReadinessLevel =
    shift.requireBackgroundPermission === 'BLOCK' ? 'BLOCKING' : 'WARNING';
  const items: ReadinessItem[] = [
    { key: 'SIGNED_IN', level: input.signedIn ? 'OK' : 'BLOCKING' },
    { key: 'APP_VERSION', level: input.versionBlocked ? 'BLOCKING' : 'OK' },
    { key: 'CONSENT', level: input.consentCurrent ? 'OK' : 'BLOCKING' },
  ];
  const probe = input.probe;
  if (!probe) {
    items.push({ key: 'LOCATION_SERVICES', level: 'BLOCKING' });
  } else {
    const foreground = probe.locationPermission === 'ALWAYS' || probe.locationPermission === 'WHEN_IN_USE';
    items.push(
      { key: 'LOCATION_SERVICES', level: probe.locationServicesEnabled ? 'OK' : 'BLOCKING' },
      {
        key: 'LOCATION_ALWAYS',
        level: probe.locationPermission === 'ALWAYS' ? 'OK' : foreground ? permissionPolicy : 'BLOCKING',
      },
      { key: 'PRECISE_LOCATION', level: probe.preciseLocation ? 'OK' : permissionPolicy },
      { key: 'NOTIFICATIONS', level: probe.notificationsEnabled === false ? 'WARNING' : 'OK' },
    );
    if (input.platform === 'ANDROID') {
      items.push({
        key: 'BATTERY_OPTIMIZATION',
        level: probe.batteryOptimizationExempt === false ? 'WARNING' : 'OK',
      });
    }
    const lowBattery = probe.batteryPct !== undefined && probe.batteryPct < 20 && probe.isCharging !== true;
    items.push({ key: 'BATTERY_LEVEL', level: lowBattery ? 'WARNING' : 'OK' });
  }
  items.push(
    { key: 'NETWORK', level: input.networkAvailable === false ? 'WARNING' : 'OK' },
    { key: 'CLOCK', level: input.clockSkewed ? 'WARNING' : 'OK' },
  );
  return items;
}

export const blockingItems = (items: readonly ReadinessItem[]): ReadinessItem[] =>
  items.filter((i) => i.level === 'BLOCKING');
