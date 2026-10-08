import { fixSchema } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import {
  batteryBand,
  buildDeviceStatus,
  significantChange,
  trackingProblem,
  trackingServiceState,
} from '../src/core/tracking/device-status.ts';
import { bestFix, captureAgeMs, distanceM, toContractFix } from '../src/core/tracking/fix.ts';
import { readiness } from '../src/core/tracking/readiness.ts';
import { initialSamplerState, sample, type SamplerState } from '../src/core/tracking/sampler.ts';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import { fixAt, GOOD_PROBE, north } from './support/fakes.ts';

const settings = DEFAULT_SETTINGS.tracking; // 20 m, 15 s, 60 s, 300 s
const T0 = Date.parse('2026-10-08T15:00:00.000Z');

function feed(readings: { offsetMs: number; metres: number; accuracyM?: number }[]): {
  recorded: number[];
  state: SamplerState;
} {
  let state = initialSamplerState;
  const recorded: number[] = [];
  const origin = fixAt(T0);
  for (const r of readings) {
    const fix = { ...north(origin, r.metres, T0 + r.offsetMs), accuracyM: r.accuracyM ?? 8 };
    const decision = sample(state, fix, T0 + r.offsetMs, settings);
    state = decision.state;
    if (decision.record) recorded.push(r.offsetMs);
  }
  return { recorded, state };
}

describe('sampling (PROD §8.2)', () => {
  it('moving: a point every 20 m but never more than one per 15 s', () => {
    // Walking 2 m/s, a reading every 5 s.
    const readings = Array.from({ length: 13 }, (_, i) => ({ offsetMs: i * 5_000, metres: i * 10 }));
    const { recorded } = feed(readings);
    expect(recorded).toEqual([0, 15_000, 30_000, 45_000, 60_000]);
  });

  it('moving slowly: at least one point per 60 s, and never “stationary” while drifting away', () => {
    // 0.25 m/s for 3 minutes: never 20 m between points within a minute, never 2 minutes within 20 m.
    const readings = Array.from({ length: 37 }, (_, i) => ({ offsetMs: i * 5_000, metres: i * 1.25 }));
    const { recorded, state } = feed(readings);
    expect(recorded).toEqual([0, 60_000, 120_000, 180_000]);
    expect(state.mode).toBe('MOVING');
  });

  it('becomes stationary after 2 minutes within 20 m, then records one point per 5 minutes', () => {
    const readings = Array.from({ length: 121 }, (_, i) => ({ offsetMs: i * 5_000, metres: (i % 2) * 3 })); // 10 min, jitter 3 m
    const { recorded, state } = feed(readings);
    expect(state.mode).toBe('STATIONARY');
    // 0 s, then 60 s while still "moving"; stationary from 2 min; next point 5 min after the last one.
    expect(recorded).toEqual([0, 60_000, 360_000]);
  });

  it('is moving again on the first fix more than 20 m from where it stood', () => {
    const still = Array.from({ length: 40 }, (_, i) => ({ offsetMs: i * 5_000, metres: 0 }));
    const { state } = feed([...still, { offsetMs: 200_000, metres: 30 }]);
    expect(state.mode).toBe('MOVING');
    const result = feed([...still, { offsetMs: 200_000, metres: 30 }]).recorded;
    expect(result.at(-1)).toBe(200_000);
  });

  it('poor-accuracy readings never switch moving/stationary, but still follow the time rules', () => {
    const still = Array.from({ length: 40 }, (_, i) => ({ offsetMs: i * 5_000, metres: 0 }));
    const { state } = feed([...still, { offsetMs: 200_000, metres: 400, accuracyM: 500 }]);
    expect(state.mode).toBe('STATIONARY');
  });
});

describe('fixes from the platform (SEC §8)', () => {
  it('keeps unknown accuracy as null and leaves invalid optional readings out', () => {
    const fix = toContractFix({
      ...fixAt(T0),
      accuracyM: -1,
      speedMps: -1,
      headingDeg: 360,
      altitudeM: 20_000,
    });
    expect(fix).toEqual({ lat: 24.8607, lon: 67.0011, accuracyM: null, isMock: false });
    expect(fixSchema.safeParse(fix).success).toBe(true);
  });

  it('records the mock-location flag and the provider, and passes the contract', () => {
    const fix = toContractFix(
      { ...fixAt(T0), mocked: true, speedMps: 1.4, headingDeg: 90 },
      { provider: 'FUSED', fixAgeS: 2.345 },
    );
    expect(fix).toMatchObject({
      isMock: true,
      provider: 'FUSED',
      speedMps: 1.4,
      headingDeg: 90,
      fixAgeS: 2.3,
    });
    expect(fixSchema.safeParse(fix).success).toBe(true);
  });

  it('trusts a fix timestamp only up to 10 minutes back (GPS time vs a wrong phone clock)', () => {
    expect(captureAgeMs({ timestampMs: T0 - 4_000 }, T0)).toBe(4_000);
    expect(captureAgeMs({ timestampMs: T0 + 60_000 }, T0)).toBe(0);
    expect(captureAgeMs({ timestampMs: T0 - 2 * 3_600_000 }, T0)).toBe(0);
  });

  it('picks the most accurate of the readings collected for an on-demand fix', () => {
    const best = bestFix([
      { ...fixAt(T0), accuracyM: 60 },
      { ...fixAt(T0 + 1), accuracyM: null },
      { ...fixAt(T0 + 2), accuracyM: 12 },
      { ...fixAt(T0 + 3), latitude: 0, longitude: 0, accuracyM: 1 }, // "null island" is never a real fix
    ]);
    expect(best?.accuracyM).toBe(12);
    expect(bestFix([])).toBeNull();
  });

  it('measures distance in metres', () => {
    expect(distanceM(fixAt(T0), north(fixAt(T0), 100, T0))).toBeCloseTo(100, 0);
  });
});

describe('device status (ARCH §8.4)', () => {
  it('reports only the contract’s fields, and treats permission, power and battery thresholds as changes', () => {
    const base = buildDeviceStatus(GOOD_PROBE, 'RUNNING', null);
    expect(significantChange(null, base)).toBe(true);
    expect(
      significantChange(base, buildDeviceStatus({ ...GOOD_PROBE, batteryPct: 79 }, 'RUNNING', null)),
    ).toBe(false);
    expect(
      significantChange(base, buildDeviceStatus({ ...GOOD_PROBE, batteryPct: 14 }, 'RUNNING', null)),
    ).toBe(true);
    expect(
      significantChange(base, buildDeviceStatus({ ...GOOD_PROBE, preciseLocation: false }, 'RUNNING', null)),
    ).toBe(true);
    expect(
      significantChange(base, buildDeviceStatus({ ...GOOD_PROBE, powerSaveMode: true }, 'RUNNING', null)),
    ).toBe(true);
    expect(significantChange(base, buildDeviceStatus(GOOD_PROBE, 'STOPPED', null))).toBe(true);
    expect(batteryBand(16)).toBe(20);
    expect(batteryBand(15)).toBe(15);
    expect(batteryBand(undefined)).toBeNull();
  });

  it('names the tracking problem the guard must fix (PROD §7.6)', () => {
    expect(trackingProblem(GOOD_PROBE)).toBeNull();
    expect(trackingProblem({ ...GOOD_PROBE, locationServicesEnabled: false })).toBe('LOCATION_SERVICES_OFF');
    expect(trackingProblem({ ...GOOD_PROBE, locationPermission: 'DENIED' })).toBe('PERMISSION_DENIED');
    expect(trackingProblem({ ...GOOD_PROBE, preciseLocation: false })).toBe('APPROXIMATE_ONLY');
    expect(trackingProblem({ ...GOOD_PROBE, locationPermission: 'WHEN_IN_USE' })).toBe('NOT_ALWAYS');
    expect(trackingServiceState({ ...GOOD_PROBE, locationPermission: 'DENIED' }, true)).toBe(
      'PERMISSION_PROBLEM',
    );
    expect(trackingServiceState(GOOD_PROBE, null)).toBe('UNKNOWN');
  });

  it('readiness: location “all the time” and precise block under BLOCK; battery and network only warn', () => {
    const input = {
      signedIn: true,
      versionBlocked: false,
      consentCurrent: true,
      probe: { ...GOOD_PROBE, batteryPct: 10, isCharging: false },
      networkAvailable: false,
      clockSkewed: false,
      platform: 'ANDROID' as const,
    };
    const ok = readiness(input, DEFAULT_SETTINGS.shift);
    expect(ok.filter((i) => i.level === 'BLOCKING')).toEqual([]);
    expect(
      ok
        .filter((i) => i.level === 'WARNING')
        .map((i) => i.key)
        .sort(),
    ).toEqual(['BATTERY_LEVEL', 'NETWORK']);
    const approx = readiness(
      { ...input, probe: { ...GOOD_PROBE, preciseLocation: false } },
      DEFAULT_SETTINGS.shift,
    );
    expect(approx).toContainEqual({ key: 'PRECISE_LOCATION', level: 'BLOCKING' });
    const warnOnly = readiness(
      { ...input, probe: { ...GOOD_PROBE, locationPermission: 'WHEN_IN_USE' } },
      { ...DEFAULT_SETTINGS.shift, requireBackgroundPermission: 'WARN' },
    );
    expect(warnOnly).toContainEqual({ key: 'LOCATION_ALWAYS', level: 'WARNING' });
    const denied = readiness(
      { ...input, probe: { ...GOOD_PROBE, locationPermission: 'DENIED' } },
      DEFAULT_SETTINGS.shift,
    );
    expect(denied).toContainEqual({ key: 'LOCATION_ALWAYS', level: 'BLOCKING' });
  });
});
