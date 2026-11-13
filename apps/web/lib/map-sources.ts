// Where the map's style and tile worker come from. Kept apart from components/map.tsx so the
// Content-Security-Policy (lib/csp.ts) can allow exactly these without loading MapLibre.

/** D-12 revised: OpenFreeMap's vector style; its tiles, fonts and sprites come from the same host. */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
/** MapLibre's tile worker, served by the dashboard (scripts/copy-map-worker.mjs). */
export const MAP_WORKER_URL = '/maplibre/maplibre-gl-worker.mjs';
