// Shared geography shapes. Site boundaries are a circle (posts, gates) or a polygon drawn on the map
// (patrol beats), D-38.
import { z } from 'zod';

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const latLngSchema = z.strictObject({ lat: latitudeSchema, lng: longitudeSchema });
export type LatLng = z.infer<typeof latLngSchema>;

export const CIRCLE_RADIUS_M = { min: 50, max: 5000 } as const;
export const POLYGON_POINTS = { min: 3, max: 200 } as const;
/** Largest beat a polygon may describe (D-38). The pilot colony is about 400 km² in total. */
export const POLYGON_MAX_AREA_KM2 = 100;

export const siteBoundarySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('CIRCLE'),
    center: latLngSchema,
    radiusM: z.int().min(CIRCLE_RADIUS_M.min).max(CIRCLE_RADIUS_M.max),
  }),
  z.strictObject({
    kind: z.literal('POLYGON'),
    /** Outer ring, without repeating the first point at the end. */
    points: z.array(latLngSchema).min(POLYGON_POINTS.min).max(POLYGON_POINTS.max),
  }),
]);
export type SiteBoundary = z.infer<typeof siteBoundarySchema>;
