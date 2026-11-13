// Where the map's style and tile worker come from. Kept apart from components/map.tsx so the
// Content-Security-Policy (lib/csp.ts) can allow exactly these without loading MapLibre.

/**
 * D-12 revised: OpenFreeMap's dark vector style, recoloured by lib/map-style.ts; its tiles, fonts and
 * sprites come from the same host.
 */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
/** MapLibre's tile worker, served by the dashboard (scripts/copy-map-worker.mjs). */
export const MAP_WORKER_URL = '/maplibre/maplibre-gl-worker.mjs';
