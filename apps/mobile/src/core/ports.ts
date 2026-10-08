// What the core needs from the phone. src/platform/* implements these with Expo modules; the tests
// implement them with fakes. Nothing in src/core imports React Native or Expo.
import type { DeviceProbe } from './tracking/device-status.ts';
import type { RawFix } from './tracking/fix.ts';

/** Keychain / Android Keystore-backed storage for secrets (expo-secure-store). */
export interface SecureKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type LocationUpdateOptions = {
  /** Android: the update interval. iOS ignores it. */
  readonly timeIntervalMs: number;
  /** 0 = every change (keeps heartbeats coming while stationary). */
  readonly distanceIntervalM: number;
  /** The persistent Android foreground-service notification (ARCH §8.2). */
  readonly notificationTitle: string;
  readonly notificationBody: string;
};

export interface LocationPort {
  /** Starts background updates (an Android foreground service). Must be called from a user action. */
  startUpdates(options: LocationUpdateOptions): Promise<void>;
  stopUpdates(): Promise<void>;
  /** Null when the platform cannot tell. */
  isRunning(): Promise<boolean | null>;
  /** An on-demand fix: the best reading within `timeoutMs`, stopping early at `targetAccuracyM`. */
  currentFix(options: { timeoutMs: number; targetAccuracyM: number }): Promise<RawFix | null>;
}

export type DeviceInfo = {
  readonly platform: 'ANDROID' | 'IOS';
  readonly osVersion: string;
  readonly manufacturer?: string | undefined;
  readonly model?: string | undefined;
};

export interface DevicePort {
  /** Permissions, location services, battery, notifications (cheap native reads). */
  probe(): Promise<DeviceProbe>;
  /** The OS's network flag: a hint for the readiness check, never proof that data was sent. */
  networkAvailable(): Promise<boolean | null>;
  readonly info: DeviceInfo;
}
