// The permission flow (PROD §7.3), each step started by the guard on a screen that explains it first:
// notifications, then location (precise), then "Allow all the time" (Android sends the guard to
// Settings), then the battery-optimization settings page. The app never requests
// REQUEST_IGNORE_BATTERY_OPTIMIZATIONS itself (EXT-33); it opens the settings screen.
import * as Location from 'expo-location';
import { Linking, PermissionsAndroid, Platform } from 'react-native';

export async function requestNotifications(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
  const result = await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS');
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export async function requestForegroundLocation(): Promise<boolean> {
  return (await Location.requestForegroundPermissionsAsync()).granted;
}

export async function requestBackgroundLocation(): Promise<boolean> {
  return (await Location.requestBackgroundPermissionsAsync()).granted;
}

export function openAppSettings(): Promise<void> {
  return Linking.openSettings();
}

export async function openBatteryOptimizationSettings(): Promise<void> {
  if (Platform.OS !== 'android') return openAppSettings();
  try {
    await Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
  } catch {
    await openAppSettings();
  }
}

export async function openLocationSettings(): Promise<void> {
  if (Platform.OS !== 'android') return openAppSettings();
  try {
    await Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS');
  } catch {
    await openAppSettings();
  }
}

/**
 * Opens the phone's dialer with the supervisor's number (`sos.emergency_call_number`), or empty
 * when none is set. The guard still presses call.
 */
export async function openDialer(number: string | null = null): Promise<void> {
  try {
    await Linking.openURL(number ? `tel:${number}` : 'tel:');
  } catch {
    // no dialer on this device
  }
}
