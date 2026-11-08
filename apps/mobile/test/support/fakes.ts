// In-memory stand-ins for the phone (secure store, location, device) used by the unit tests.
import { randomBytes } from 'node:crypto';

import type { RandomBytes } from '../../src/core/ids.ts';
import { createLogger, type LogLevel, type Logger } from '../../src/core/log.ts';
import type {
  DeviceInfo,
  DevicePort,
  LocationPort,
  LocationUpdateOptions,
  PhotoPort,
  PreparedPhoto,
  PushPort,
  SecureKV,
} from '../../src/core/ports.ts';
import type { DeviceProbe } from '../../src/core/tracking/device-status.ts';
import type { RawFix } from '../../src/core/tracking/fix.ts';

export const cryptoRandom: RandomBytes = (n) => new Uint8Array(randomBytes(n));

/** Deterministic [0, 1) source for backoff tests. */
export function sequence01(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0.5;
}

export class MemoryKV implements SecureKV {
  readonly values = new Map<string, string>();
  writes: string[] = [];
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    this.writes.push(key);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

export class FakeLocation implements LocationPort {
  running = false;
  starts: LocationUpdateOptions[] = [];
  stops = 0;
  /** What the next on-demand fix returns. */
  nextFix: RawFix | null = null;
  /** How many on-demand fixes were asked for. */
  fixRequests = 0;
  failStart = false;

  startUpdates(options: LocationUpdateOptions): Promise<void> {
    if (this.failStart) return Promise.reject(new Error('ForegroundServiceStartNotAllowedException'));
    this.running = true;
    this.starts.push(options);
    return Promise.resolve();
  }
  stopUpdates(): Promise<void> {
    this.running = false;
    this.stops++;
    return Promise.resolve();
  }
  isRunning(): Promise<boolean | null> {
    return Promise.resolve(this.running);
  }
  currentFix(): Promise<RawFix | null> {
    this.fixRequests++;
    return Promise.resolve(this.nextFix);
  }
}

export const GOOD_PROBE: DeviceProbe = {
  locationPermission: 'ALWAYS',
  preciseLocation: true,
  locationServicesEnabled: true,
  notificationsEnabled: true,
  batteryPct: 80,
  isCharging: false,
  powerSaveMode: false,
  batteryOptimizationExempt: true,
  osVersion: '15',
};

export class FakeDevice implements DevicePort {
  probeValue: DeviceProbe = GOOD_PROBE;
  network: boolean | null = true;
  readonly info: DeviceInfo = { platform: 'ANDROID', osVersion: '15', manufacturer: 'TestCo', model: 'T1' };
  probe(): Promise<DeviceProbe> {
    return Promise.resolve(this.probeValue);
  }
  networkAvailable(): Promise<boolean | null> {
    return Promise.resolve(this.network);
  }
}

/** A fix at the test site (Karachi), taken at `atMs`. */
export function fixAt(atMs: number, options: Partial<RawFix> = {}): RawFix {
  return {
    latitude: 24.8607,
    longitude: 67.0011,
    accuracyM: 8,
    altitudeM: 12,
    speedMps: 0,
    headingDeg: null,
    timestampMs: atMs,
    mocked: false,
    ...options,
  };
}

/** Moves a point north by `metres` (for sampler tests). */
export function north(fix: RawFix, metres: number, atMs: number): RawFix {
  return { ...fix, latitude: fix.latitude + metres / 111_195, timestampMs: atMs };
}

export type CapturedLine = { level: LogLevel; event: string; fields: Record<string, unknown> };

export function capturingLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  return { logger: createLogger((level, event, fields) => lines.push({ level, event, fields })), lines };
}

/** Incident photos (D-18) without a camera: prepared photos are remembered; uploads answer on command. */
export class FakePhotos implements PhotoPort {
  readonly prepared: { sourceUri: string; uri: string }[] = [];
  readonly uploads: { uri: string; url: string; headers: Readonly<Record<string, string>> }[] = [];
  readonly removed: string[] = [];
  /** The HTTP status the storage answers an upload with. */
  uploadStatus = 200;
  /** When set, an upload has no response (offline). */
  offline = false;

  prepare(sourceUri: string, _width: number, _height: number, name: string): Promise<PreparedPhoto> {
    const uri = `file:///app/documents/incident-photo-${name}.jpg`;
    this.prepared.push({ sourceUri, uri });
    return Promise.resolve({ uri, sizeBytes: 123_456, sha256: 'ab'.repeat(32), contentType: 'image/jpeg' });
  }

  upload(uri: string, url: string, headers: Readonly<Record<string, string>>): Promise<number> {
    if (this.offline) return Promise.reject(new Error('offline'));
    this.uploads.push({ uri, url, headers });
    return Promise.resolve(this.uploadStatus);
  }

  remove(uri: string): Promise<void> {
    this.removed.push(uri);
    return Promise.resolve();
  }
}

/** The phone's Firebase token (D-26): hand out a token, or none, and announce a new one on command. */
export class FakePush implements PushPort {
  token: string | null = `fcm-${'a'.repeat(40)}`;
  readonly listeners = new Set<(token: string) => void>();
  getToken(): Promise<string | null> {
    return Promise.resolve(this.token);
  }
  onTokenChange(listener: (token: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** The system issues a new token. */
  refresh(token: string): void {
    this.token = token;
    for (const listener of this.listeners) listener(token);
  }
}
