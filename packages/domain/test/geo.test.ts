import { describe, expect, it } from 'vitest';

import {
  circlePolygon,
  classifyFix,
  distanceToPolygonEdgeM,
  haversineM,
  isSimplePolygon,
  pointInPolygon,
  polygonAreaKm2,
  type Point,
} from '../src/geo.ts';

// A 1 km × 1 km square beat near Lahore (31.5° N), built from metre offsets.
const ORIGIN: Point = { lat: 31.5, lng: 74.3 };
const metres = (east: number, north: number): Point => ({
  lat: ORIGIN.lat + north / 111_195,
  lng: ORIGIN.lng + east / (111_195 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
});
const SQUARE = [metres(0, 0), metres(1000, 0), metres(1000, 1000), metres(0, 1000)];

describe('geometry (D-38, ARCH §10)', () => {
  it('haversine distance matches a known value', () => {
    // Karachi → Lahore is about 1,030 km.
    const d = haversineM({ lat: 24.8607, lng: 67.0011 }, { lat: 31.5204, lng: 74.3587 });
    expect(d / 1000).toBeGreaterThan(1020);
    expect(d / 1000).toBeLessThan(1040);
  });

  it('polygon area and inside test', () => {
    expect(polygonAreaKm2(SQUARE)).toBeCloseTo(1, 2);
    expect(pointInPolygon(metres(500, 500), SQUARE)).toBe(true);
    expect(pointInPolygon(metres(1500, 500), SQUARE)).toBe(false);
    expect(distanceToPolygonEdgeM(metres(500, 900), SQUARE)).toBeCloseTo(100, 0);
  });

  it('self-crossing polygons and repeated points are not simple', () => {
    expect(isSimplePolygon(SQUARE)).toBe(true);
    const bowTie = [metres(0, 0), metres(1000, 1000), metres(1000, 0), metres(0, 1000)];
    expect(isSimplePolygon(bowTie)).toBe(false);
    expect(isSimplePolygon([metres(0, 0), metres(0, 0), metres(10, 10)])).toBe(false);
    expect(isSimplePolygon([metres(0, 0), metres(10, 0)])).toBe(false);
  });

  it('a circle drawn as a polygon stays on its radius', () => {
    for (const p of circlePolygon(ORIGIN, 250)) expect(haversineM(ORIGIN, p)).toBeCloseTo(250, 0);
  });

  it('INSIDE needs the whole accuracy circle inside; OUTSIDE needs it wholly outside', () => {
    const circle = { kind: 'CIRCLE' as const, center: ORIGIN, radiusM: 100 };
    expect(classifyFix(circle, metres(0, 50), 10)).toBe('INSIDE');
    expect(classifyFix(circle, metres(0, 95), 10)).toBe('UNCERTAIN');
    expect(classifyFix(circle, metres(0, 105), 10)).toBe('UNCERTAIN');
    expect(classifyFix(circle, metres(0, 150), 10)).toBe('OUTSIDE');
    expect(classifyFix(circle, metres(0, 150), 10, 60)).toBe('UNCERTAIN'); // buffer
    expect(classifyFix(circle, metres(0, 10), null)).toBe('UNCERTAIN'); // no accuracy, no claim
    const beat = { kind: 'POLYGON' as const, points: SQUARE };
    expect(classifyFix(beat, metres(500, 500), 30)).toBe('INSIDE');
    expect(classifyFix(beat, metres(500, 1200), 30)).toBe('OUTSIDE');
    expect(classifyFix(beat, metres(500, 990), 30)).toBe('UNCERTAIN');
  });

  it('a worse accuracy never turns OUTSIDE into INSIDE (property over a grid)', () => {
    const circle = { kind: 'CIRCLE' as const, center: ORIGIN, radiusM: 300 };
    for (let east = -600; east <= 600; east += 37) {
      for (let north = -600; north <= 600; north += 41) {
        const fix = metres(east, north);
        for (const beat of [circle, { kind: 'POLYGON' as const, points: SQUARE }]) {
          let sawInside = false;
          for (const accuracy of [500, 200, 50, 10, 1]) {
            const c = classifyFix(beat, fix, accuracy);
            if (c === 'INSIDE') sawInside = true;
            // Once OUTSIDE at some accuracy, never INSIDE at a worse (larger) one.
            if (c === 'OUTSIDE') expect(sawInside).toBe(false);
          }
        }
      }
    }
  });
});
