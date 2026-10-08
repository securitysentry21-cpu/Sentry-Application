import { describe, expect, it } from 'vitest';

import { batteryCondition, freshnessConditions, trackingDisabled } from '../src/alerts.ts';
import { INITIAL_GEOFENCE, stepGeofence, type GeofenceMemory, type GeofenceEvent } from '../src/geofence.ts';

const CENTER = { lat: 31.47, lng: 74.4 };
const CIRCLE = { kind: 'CIRCLE' as const, center: CENTER, radiusM: 100 };
const S = {
  maxUsableAccuracyM: 100,
  outsideBufferM: 25,
  departurePersistenceS: 300,
  departureMinPoints: 3,
  returnAccuracyM: 50,
};
const T0 = new Date('2026-10-20T15:00:00Z');
const northOf = (metres: number) => ({ lat: CENTER.lat + metres / 111_195, lng: CENTER.lng });

/** Runs fixes (metres north of the centre, accuracy, seconds after T0) through the state machine. */
function run(
  fixes: [number, number | null, number][],
  start: GeofenceMemory = { ...INITIAL_GEOFENCE, state: 'INSIDE' },
) {
  let memory = start;
  const events: GeofenceEvent[] = [];
  for (const [north, accuracyM, seconds] of fixes) {
    const step = stepGeofence(
      memory,
      CIRCLE,
      { ...northOf(north), accuracyM, capturedAt: new Date(T0.getTime() + seconds * 1000) },
      S,
    );
    memory = step.memory;
    if (step.event) events.push(step.event);
  }
  return { memory, events };
}

describe('geofence (PROD §8.4)', () => {
  it('ADV-G01 a single outside point raises nothing', () => {
    const { events, memory } = run([
      [400, 10, 0],
      [20, 10, 60],
    ]);
    expect(events).toEqual([]);
    expect(memory.state).toBe('INSIDE');
  });

  it('ADV-G02 sustained outside beyond persistence confirms exactly one departure', () => {
    const { events, memory } = run([
      [400, 10, 0],
      [420, 10, 120],
      [430, 10, 240],
      [440, 10, 300],
      [450, 10, 420],
      [460, 10, 540],
    ]);
    expect(events).toEqual([{ type: 'LEFT_SITE', at: new Date(T0.getTime() + 300_000), since: T0 }]);
    expect(memory.state).toBe('OUTSIDE_CONFIRMED');
  });

  it('ADV-G03 flapping across the boundary never confirms a departure', () => {
    const fixes: [number, number, number][] = [];
    for (let i = 0; i < 20; i++) fixes.push([i % 2 === 0 ? 400 : 20, 10, i * 60]);
    expect(run(fixes).events).toEqual([]);
  });

  it('ADV-G04 outside points with poor or unknown accuracy cause no departure', () => {
    const { events, memory } = run([
      [400, 150, 0],
      [420, 300, 200],
      [430, null, 400],
      [440, 500, 600],
    ]);
    expect(events).toEqual([]);
    expect(memory.state).toBe('INSIDE');
    // Outside "by distance" but within the accuracy circle is uncertain, not outside.
    expect(
      run([
        [150, 60, 0],
        [150, 60, 200],
        [150, 60, 400],
      ]).events,
    ).toEqual([]);
  });

  it('ADV-G05 a return is confirmed by one accurate inside fix, with the time spent outside', () => {
    const out: [number, number, number][] = [
      [400, 10, 0],
      [420, 10, 150],
      [430, 10, 300],
    ];
    const one = run([...out, [10, 30, 900]]);
    expect(one.events.at(-1)).toEqual({
      type: 'ENTERED_SITE',
      at: new Date(T0.getTime() + 900_000),
      outsideSeconds: 900,
    });
    // With mediocre accuracy, two consecutive inside fixes are needed.
    const two = run([...out, [10, 70, 900]]);
    expect(two.events.at(-1)?.type).toBe('LEFT_SITE');
    expect(run([...out, [10, 70, 900], [5, 70, 960]]).events.at(-1)?.type).toBe('ENTERED_SITE');
  });

  it('ADV-L07 accuracy bands: 5 m and 50 m fixes count, 500 m and unknown accuracy never change the state', () => {
    // Departure sequences at 400 m north of a 100 m circle, three fixes over five minutes.
    const away = (accuracyM: number | null) =>
      run([
        [400, accuracyM, 0],
        [410, accuracyM, 150],
        [420, accuracyM, 300],
      ]);
    expect(away(5).events.map((e) => e.type)).toEqual(['LEFT_SITE']);
    expect(away(50).events.map((e) => e.type)).toEqual(['LEFT_SITE']);
    expect(away(500).events).toEqual([]);
    expect(away(500).memory.state).toBe('INSIDE');
    expect(away(null).events).toEqual([]);
    // At 160 m with ±50 m the fix may still be inside the buffer: uncertain, not outside.
    expect(
      run([
        [160, 50, 0],
        [160, 50, 150],
        [160, 50, 300],
      ]).events,
    ).toEqual([]);
  });

  it('ADV-G06 when fixes stop while the guard is inside, the state stays inside: never "left site"', () => {
    const { memory, events } = run([
      [10, 8, 0],
      [12, 8, 60],
    ]);
    // No further fixes: the evaluator has nothing to step, so nothing changes, however long it is.
    expect(memory.state).toBe('INSIDE');
    expect(events).toEqual([]);
  });
});

describe('alert conditions (PROD §12.1)', () => {
  const settings = { deviceOfflineAfterS: 600, locationStaleAfterS: 420, detectorIntervalS: 60 };

  it('a silent phone is offline; a connected phone without fixes is stale; never both', () => {
    const now = new Date(T0.getTime() + 3_600_000);
    expect(freshnessConditions(now, T0, new Date(now.getTime() - 700_000), null, settings)).toEqual({
      deviceOffline: true,
      locationStale: false,
    });
    expect(
      freshnessConditions(
        now,
        T0,
        new Date(now.getTime() - 5_000),
        new Date(now.getTime() - 500_000),
        settings,
      ),
    ).toEqual({ deviceOffline: false, locationStale: true });
  });

  it('stale needs the condition on two consecutive detector runs', () => {
    const now = new Date(T0.getTime() + 3_600_000);
    const contact = new Date(now.getTime() - 5_000);
    // Older than the threshold now, but not yet at the previous run (60 s ago).
    expect(
      freshnessConditions(now, T0, contact, new Date(now.getTime() - 450_000), settings).locationStale,
    ).toBe(false);
    expect(
      freshnessConditions(now, T0, contact, new Date(now.getTime() - 481_000), settings).locationStale,
    ).toBe(true);
  });

  it('a shift that only just started is judged from its start', () => {
    const now = new Date(T0.getTime() + 60_000);
    expect(freshnessConditions(now, T0, null, null, settings)).toEqual({
      deviceOffline: false,
      locationStale: false,
    });
  });

  it('tracking is disabled by any of the listed problems, and battery follows its thresholds', () => {
    const ok = {
      locationPermission: 'ALWAYS',
      preciseLocation: true,
      locationServicesEnabled: true,
      trackingServiceState: 'RUNNING',
    };
    expect(trackingDisabled(ok)).toBe(false);
    expect(trackingDisabled({ ...ok, locationPermission: 'WHEN_IN_USE' })).toBe(true);
    expect(trackingDisabled({ ...ok, preciseLocation: false })).toBe(true);
    expect(trackingDisabled({ ...ok, locationServicesEnabled: false })).toBe(true);
    expect(trackingDisabled({ ...ok, trackingServiceState: 'STOPPED' })).toBe(true);
    expect(batteryCondition({ ...ok, batteryPct: 14, isCharging: false }, 15)).toBe('LOW');
    expect(batteryCondition({ ...ok, batteryPct: 14, isCharging: true }, 15)).toBe('CLEARED');
    expect(batteryCondition({ ...ok, batteryPct: 20, isCharging: false }, 15)).toBe('UNCHANGED');
    expect(batteryCondition({ ...ok, batteryPct: 26, isCharging: false }, 15)).toBe('CLEARED');
    expect(batteryCondition(ok, 15)).toBe('UNCHANGED');
  });
});
