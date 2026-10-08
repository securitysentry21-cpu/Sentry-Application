// In-memory stand-ins for the phone (secure store, location, device) used by the unit tests.
import { randomBytes } from 'node:crypto';

import type { RandomBytes } from '../../src/core/ids.ts';
import { createLogger, type LogLevel, type Logger } from '../../src/core/log.ts';
import type {
  DeviceInfo,
  DevicePort,
  LocationPort,
  LocationUpdateOptions,
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
