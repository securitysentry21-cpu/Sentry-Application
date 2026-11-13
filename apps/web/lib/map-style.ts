// The dashboard's map colours (D-12 revised: OpenFreeMap's "dark" style, recoloured here). The base
// map stays quiet, a graphite with an olive cast, so that what SENTRY draws on it reads first: sites
// as translucent shapes with a fine lichen outline, guards as dots in their tracking colour. Only
// paint changes: sources, sprites and glyphs are left exactly as served, so the map still loads
// from the one tile host the Content-Security-Policy allows (lib/csp.ts).
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

/** What SENTRY draws over the base map, and the map's own ground and water. */
export const MAP_PALETTE = {
  land: '#1a1c19',
  water: '#0f1214',
  /** Site boundaries. Not a tracking colour: a site is a place, not a state. */
  site: '#b9c97e',
  /** A highlighted site, a history track, a shape being drawn. */
  bone: '#edece7',
  /** The ring between overlapping marks and the halo behind text. */
  ink: '#121316',
  /** Tracking health (D-36), the same as the dashboard's status colours (app/globals.css). */
  live: '#80e2ac',
  delayed: '#e8a346',
  offline: '#e3455a',
} as const;

type Paint = Record<string, unknown>;

const ROAD = { minor: '#2b2d27', casing: '#30332b', major: '#3a3d33', motorway: '#45493c' };
const LABEL = { text: '#9a9f8f', faint: '#7a7f71', halo: 'rgba(16, 17, 15, 0.9)' };

/** Paint for each layer of OpenFreeMap's "dark" style, by layer id. A layer not listed keeps its own. */
const PAINT: Record<string, Paint> = {
  background: { 'background-color': MAP_PALETTE.land },
  water: { 'fill-color': MAP_PALETTE.water },
  landcover_ice_shelf: { 'fill-color': '#1e201d' },
  landcover_glacier: { 'fill-color': '#1e201d' },
  landuse_residential: { 'fill-color': '#1e211c', 'fill-opacity': 0.7 },
  landcover_wood: { 'fill-color': '#202819' },
  landuse_park: { 'fill-color': '#212a1b' },
  waterway: { 'line-color': '#141a1d' },
  water_name: { 'text-color': '#5f6c70', 'text-halo-color': MAP_PALETTE.water },
  building: { 'fill-color': '#22241f', 'fill-outline-color': '#2b2e27' },
  'aeroway-taxiway': { 'line-color': ROAD.minor },
  'aeroway-runway-casing': { 'line-color': ROAD.casing },
  'aeroway-area': { 'fill-color': '#1e201c' },
  'aeroway-runway': { 'line-color': ROAD.minor },
  road_area_pier: { 'fill-color': MAP_PALETTE.land },
  road_pier: { 'line-color': MAP_PALETTE.land },
  highway_path: { 'line-color': '#282a24' },
  highway_minor: { 'line-color': ROAD.minor },
  highway_major_casing: { 'line-color': ROAD.casing },
  highway_major_inner: { 'line-color': ROAD.major },
  highway_major_subtle: { 'line-color': ROAD.casing },
  highway_motorway_casing: { 'line-color': ROAD.motorway },
  highway_motorway_inner: { 'line-color': ROAD.major },
  highway_motorway_subtle: { 'line-color': ROAD.casing },
  railway_transit: { 'line-color': '#2d2f2a' },
  railway_transit_dashline: { 'line-color': MAP_PALETTE.land },
  railway_minor: { 'line-color': '#2d2f2a' },
  railway_minor_dashline: { 'line-color': MAP_PALETTE.land },
  railway: { 'line-color': '#2d2f2a' },
  railway_dashline: { 'line-color': MAP_PALETTE.land },
  highway_name_other: { 'text-color': LABEL.faint, 'text-halo-color': LABEL.halo },
  highway_name_motorway: { 'text-color': LABEL.text },
  boundary_state: { 'line-color': '#3a3d34' },
  'boundary_country_z0-4': { 'line-color': '#3a3d34' },
  'boundary_country_z5-': { 'line-color': '#3a3d34' },
};
for (const id of ['place_other', 'place_suburb', 'place_village', 'place_town', 'place_state']) {
  PAINT[id] = { 'text-color': LABEL.text, 'text-halo-color': LABEL.halo };
}
for (const id of ['place_city', 'place_city_large', 'place_country_other', 'place_country_minor']) {
  PAINT[id] = { 'text-color': '#b3b7a8', 'text-halo-color': LABEL.halo };
}
PAINT.place_country_major = { 'text-color': '#c4c8b9', 'text-halo-color': LABEL.halo };

/**
 * Images the served style asks for that its sprite does not have (checked 2026-11-10): the woods'
 * fill pattern, and the dots before town and city names when zoomed out. Dropped, so the woods take
 * their colour above and MapLibre has no missing image to complain about in the console.
 */
const MISSING_IMAGES: Record<string, { paint?: string[]; layout?: string[] }> = {
  landcover_wood: { paint: ['fill-pattern'] },
  place_town: { layout: ['icon-image'] },
  place_city: { layout: ['icon-image'] },
  place_city_large: { layout: ['icon-image'] },
};

function without(properties: object | undefined, keys: readonly string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties ?? {}).filter(([key]) => !keys.includes(key)));
}

function repaint(layer: LayerSpecification): LayerSpecification {
  const paint = PAINT[layer.id];
  const missing = MISSING_IMAGES[layer.id];
  if (!paint && !missing) return layer;
  const next: Record<string, unknown> = {
    ...layer,
    paint: { ...without(layer.paint, missing?.paint), ...paint },
  };
  if ('layout' in layer && missing?.layout) next.layout = without(layer.layout, missing.layout);
  return next as LayerSpecification;
}

/** The served style with SENTRY's colours: a new object; the original is left as it was. */
export function tintMapStyle(style: StyleSpecification): StyleSpecification {
  return { ...style, layers: style.layers.map(repaint) };
}
