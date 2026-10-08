// Geometry for site boundaries (D-38) and geofencing (ARCH §10), pure and shared by the API, the
// dashboard and the app. Distances use the haversine formula on the WGS-84 mean radius; polygons are
// projected onto a local equirectangular plane around their own centroid, which is accurate to well
// under a metre for beats of a few kilometres (the largest allowed polygon is 100 km²).

export type Point = { readonly lat: number; readonly lng: number };

export const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export function haversineM(a: Point, b: Point): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

type XY = { x: number; y: number };

/** Projects onto metres east (x) and north (y) of `origin`. */
function projector(origin: Point): (p: Point) => XY {
  const kx = EARTH_RADIUS_M * RAD * Math.cos(origin.lat * RAD);
  const ky = EARTH_RADIUS_M * RAD;
  return (p) => ({ x: (p.lng - origin.lng) * kx, y: (p.lat - origin.lat) * ky });
}

export function centroid(points: readonly Point[]): Point {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

export function polygonAreaKm2(points: readonly Point[]): number {
  const project = projector(centroid(points));
  const xy = points.map(project);
  let twice = 0;
  for (let i = 0; i < xy.length; i++) {
    const a = xy[i];
    const b = xy[(i + 1) % xy.length];
    if (a && b) twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2 / 1_000_000;
}

function orientation(a: XY, b: XY, c: XY): number {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  return Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : 2;
}

function onSegment(a: XY, b: XY, c: XY): boolean {
  return (
    Math.min(a.x, c.x) - 1e-9 <= b.x &&
    b.x <= Math.max(a.x, c.x) + 1e-9 &&
    Math.min(a.y, c.y) - 1e-9 <= b.y &&
    b.y <= Math.max(a.y, c.y) + 1e-9
  );
}

function segmentsIntersect(p1: XY, q1: XY, p2: XY, q2: XY): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(p1, p2, q1)) ||
    (o2 === 0 && onSegment(p1, q2, q1)) ||
    (o3 === 0 && onSegment(p2, p1, q2)) ||
    (o4 === 0 && onSegment(p2, q1, q2))
  );
}

/** A simple polygon: no edge crosses or touches a non-adjacent edge, and no repeated points. */
export function isSimplePolygon(points: readonly Point[]): boolean {
  if (points.length < 3) return false;
  const project = projector(centroid(points));
  const xy = points.map(project);
  const n = xy.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = xy[i];
      const b = xy[j];
      if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < 0.01) return false;
    }
  }
  for (let i = 0; i < n; i++) {
    const a1 = xy[i];
    const a2 = xy[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges share a vertex by design.
      if ((j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = xy[j];
      const b2 = xy[(j + 1) % n];
      if (a1 && a2 && b1 && b2 && segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  const project = projector(centroid(polygon));
  const p = project(point);
  const xy = polygon.map(project);
  let inside = false;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const a = xy[i];
    const b = xy[j];
    if (!a || !b) continue;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Shortest distance in metres from the point to the polygon's boundary. */
export function distanceToPolygonEdgeM(point: Point, polygon: readonly Point[]): number {
  const project = projector(point);
  const xy = polygon.map(project);
  let best = Infinity;
  for (let i = 0; i < xy.length; i++) {
    const a = xy[i];
    const b = xy[(i + 1) % xy.length];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2));
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

/** Points on a circle, for drawing it (the boundary rule itself uses the exact distance). */
export function circlePolygon(center: Point, radiusM: number, segments = 64): Point[] {
  const out: Point[] = [];
  const angular = radiusM / EARTH_RADIUS_M;
  const lat1 = center.lat * RAD;
  const lng1 = center.lng * RAD;
  for (let i = 0; i < segments; i++) {
    const bearing = (2 * Math.PI * i) / segments;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
      );
    out.push({ lat: lat2 / RAD, lng: lng2 / RAD });
  }
  return out;
}

export type Boundary =
  | { readonly kind: 'CIRCLE'; readonly center: Point; readonly radiusM: number }
  | { readonly kind: 'POLYGON'; readonly points: readonly Point[] };

export type BoundaryClass = 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN';

/**
 * PROD §8.4 / D-38: INSIDE only when the fix is inside and further than its accuracy from the edge;
 * OUTSIDE only when it is outside by more than its accuracy (plus the buffer); otherwise UNCERTAIN.
 * A fix without an accuracy is never trusted to be precise.
 */
export function classifyFix(
  boundary: Boundary,
  fix: Point,
  accuracyM: number | null,
  outsideBufferM = 0,
): BoundaryClass {
  if (accuracyM === null) return 'UNCERTAIN';
  let inside: boolean;
  let edgeDistance: number;
  if (boundary.kind === 'CIRCLE') {
    const d = haversineM(boundary.center, fix);
    inside = d <= boundary.radiusM;
    edgeDistance = Math.abs(d - boundary.radiusM);
  } else {
    inside = pointInPolygon(fix, boundary.points);
    edgeDistance = distanceToPolygonEdgeM(fix, boundary.points);
  }
  if (inside) return edgeDistance >= accuracyM ? 'INSIDE' : 'UNCERTAIN';
  return edgeDistance > accuracyM + outsideBufferM ? 'OUTSIDE' : 'UNCERTAIN';
}
