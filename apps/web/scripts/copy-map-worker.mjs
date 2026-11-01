// MapLibre GL 6 starts its tile worker from a file next to its own module (maplibre-gl-worker.mjs).
// Next bundles MapLibre into its own chunks, so that file isn't where MapLibre looks, and the map
// stays blank ("Worker failed to load"). The dashboard serves the worker itself, from
// public/maplibre/, and components/map.tsx points MapLibre at it with setWorkerUrl(). This runs
// before `next dev` and `next build`, so the copy always matches the installed MapLibre version.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = join(dirname(require.resolve('maplibre-gl/package.json')), 'dist', 'maplibre-gl-worker.mjs');
const target = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'maplibre',
  'maplibre-gl-worker.mjs',
);

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
