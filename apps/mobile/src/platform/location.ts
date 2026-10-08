// The LocationSource (D-07): expo-location background updates delivered to an expo-task-manager task,
// behind the core's LocationPort, so the library can be replaced after Phase 0B without touching the
// outbox or the sync protocol (ARCH §8.1).
//
// Android: a foreground service of type location with a persistent notification, kept running when
// the app is swiped away (killServiceOnDestroy: false). iOS: background location with
// pausesUpdatesAutomatically = false (stationary guards must never be paused, SEC §20.16) and the
// blue background-location indicator on.
import * as Location from 'expo-location';

import type { LocationPort, LocationUpdateOptions } from '../core/ports.ts';
import { bestFix, type RawFix } from '../core/tracking/fix.ts';

export const LOCATION_TASK = 'sentry-shift-location';

export function toRawFix(location: Location.LocationObject): RawFix {
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracyM: location.coords.accuracy,
    altitudeM: location.coords.altitude,
    speedMps: location.coords.speed,
    headingDeg: location.coords.heading,
    timestampMs: location.timestamp,
    mocked: location.mocked,
  };
}

async function startUpdates(options: LocationUpdateOptions): Promise<void> {
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: options.timeIntervalMs,
    distanceInterval: options.distanceIntervalM,
    // iOS
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    activityType: Location.ActivityType.Other,
    // Android
    foregroundService: {
      notificationTitle: options.notificationTitle,
      notificationBody: options.notificationBody,
      notificationColor: '#12161B',
      killServiceOnDestroy: false,
    },
  });
}

async function isRunning(): Promise<boolean | null> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    return null;
  }
}

async function stopUpdates(): Promise<void> {
  if ((await isRunning()) !== false) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}

/**
 * An on-demand fix (PROD §8.2): readings for up to `timeoutMs`, stopping early once one is at least
 * as accurate as `targetAccuracyM`; the best one wins. Foreground only (start, end, incidents, SOS).
 */
function currentFix(options: { timeoutMs: number; targetAccuracyM: number }): Promise<RawFix | null> {
  return new Promise((resolve) => {
    const readings: RawFix[] = [];
    let subscription: Location.LocationSubscription | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription?.remove();
      resolve(bestFix(readings));
    };
    const timer = setTimeout(finish, options.timeoutMs);
    Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Highest,
        timeInterval: 1_000,
        distanceInterval: 0,
        mayShowUserSettingsDialog: false,
      },
      (location) => {
        const fix = toRawFix(location);
        readings.push(fix);
        if (fix.accuracyM !== null && fix.accuracyM > 0 && fix.accuracyM <= options.targetAccuracyM) finish();
      },
      () => finish(),
    ).then(
      (s) => {
        subscription = s;
        if (done) s.remove();
      },
      () => finish(),
    );
  });
}

export const expoLocation: LocationPort = { startUpdates, stopUpdates, isRunning, currentFix };
