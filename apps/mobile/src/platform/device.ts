// What the phone says about itself (ARCH §8.4; only deviceStatusSchema's fields, SEC §16.2):
// location permission and precision (expo-location), notifications (Android's POST_NOTIFICATIONS),
// battery, power saver and battery-optimization exemption (expo-battery), and the OS network flag
// (expo-network), which is only ever a hint for the readiness check.
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import { PermissionsAndroid, Platform } from 'react-native';

import type { DeviceInfo, DevicePort } from '../core/ports.ts';
import type { DeviceProbe, LocationPermissionLevel } from '../core/tracking/device-status.ts';

function deviceInfo(): DeviceInfo {
  if (Platform.OS === 'android') {
    const c = Platform.constants;
    return {
      platform: 'ANDROID',
      osVersion: String(c.Release),
      manufacturer: c.Manufacturer,
      model: c.Model,
    };
  }
  return { platform: 'IOS', osVersion: String(Platform.Version) };
}

async function locationPermission(): Promise<{ level: LocationPermissionLevel; precise: boolean }> {
  const foreground = await Location.getForegroundPermissionsAsync();
  let level: LocationPermissionLevel;
  if (foreground.granted) {
    const background = await Location.getBackgroundPermissionsAsync();
    level = background.granted || foreground.ios?.scope === 'always' ? 'ALWAYS' : 'WHEN_IN_USE';
  } else {
    level = foreground.status === Location.PermissionStatus.UNDETERMINED ? 'NOT_DETERMINED' : 'DENIED';
  }
  const precise =
    Platform.OS === 'android'
      ? foreground.android?.accuracy === 'fine'
      : foreground.ios?.accuracy !== 'reduced';
  return { level, precise: foreground.granted && precise };
}

async function notificationsEnabled(): Promise<boolean | undefined> {
  if (Platform.OS !== 'android') return undefined; // iOS needs expo-notifications (Phase 5)
  if (Number(Platform.Version) < 33) return true; // granted at install before Android 13
  return PermissionsAndroid.check('android.permission.POST_NOTIFICATIONS');
}

async function settle<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

async function probe(): Promise<DeviceProbe> {
  const [permission, services, notifications, power, optimized] = await Promise.all([
    settle(locationPermission),
    settle(() => Location.hasServicesEnabledAsync()),
    settle(notificationsEnabled),
    settle(() => Battery.getPowerStateAsync()),
    Platform.OS === 'android'
      ? settle(() => Battery.isBatteryOptimizationEnabledAsync())
      : Promise.resolve(undefined),
  ]);
  const level = power?.batteryLevel;
  return {
    locationPermission: permission?.level ?? 'NOT_DETERMINED',
    preciseLocation: permission?.precise ?? false,
    locationServicesEnabled: services ?? false,
    notificationsEnabled: notifications,
    batteryPct: level !== undefined && level >= 0 ? Math.round(level * 100) : undefined,
    isCharging:
      power === undefined
        ? undefined
        : power.batteryState === Battery.BatteryState.CHARGING ||
          power.batteryState === Battery.BatteryState.FULL,
    powerSaveMode: power?.lowPowerMode,
    batteryOptimizationExempt: optimized === undefined ? undefined : !optimized,
    osVersion: deviceInfo().osVersion,
  };
}

async function networkAvailable(): Promise<boolean | null> {
  const state = await Network.getNetworkStateAsync();
  if (state.isConnected === undefined) return null;
  return state.isConnected && state.isInternetReachable !== false;
}

export const expoDevice: DevicePort = { probe, networkAvailable, info: deviceInfo() };
