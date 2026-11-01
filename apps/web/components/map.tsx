'use client';

// The dashboard map (D-12 revised: MapLibre GL with OpenFreeMap vector tiles, behind this one
// component so the provider can change). It shows site boundaries; guards on duty, clustered when
// many share the view, with accuracy circles when zoomed in; and a location-history track. In
// editing mode it lets the user place a circle's centre or draw a polygon's corners by clicking.
// Labels come only from MapLibre's text rendering; there are no HTML popups (SEC §8, ADV-W01):
// details open in the page's own plain-text panel.
import 'maplibre-gl/dist/maplibre-gl.css';

import type { SiteBoundary } from '@sentryops/contracts';
import { circlePolygon } from '@sentryops/domain';
import type { Feature, FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';

export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
/** MapLibre's tile worker, served by the dashboard (scripts/copy-map-worker.mjs). */
export const MAP_WORKER_URL = '/maplibre/maplibre-gl-worker.mjs';
/** Without a loaded map by then, say so rather than show an empty box. */
const LOAD_TIMEOUT_MS = 15_000;
/** The pilot colony's area, Lahore (Q-19, about 400 km²): the default view until sites exist. */
export const DEFAULT_CENTER = { lat: 31.4697, lng: 74.4078 };

type LatLng = { lat: number; lng: number };

export type MapShape = { id: string; name: string; boundary: SiteBoundary; highlight?: boolean };

/**
 * A guard on the map: coloured by tracking health; hollow when the position is only last known
 * (INV-09). The label carries the position's age as text (PROD §8.3).
 */
export type MapPoint = {
  id: string;
  label: string;
  lat: number;
  lng: number;
  health: 'LIVE' | 'DELAYED' | 'OFFLINE';
  current: boolean;
  accuracyM?: number | null;
  selected?: boolean;
};

/** A location-history track: broken into segments at every gap (PROD §14.5). */
export type MapTrack = {
  segments: LatLng[][];
  /** Points with flags (mock location, implausible jump), drawn in red. */
  flagged: LatLng[];
  /** The playback position. */
  cursor: LatLng | null;
};

const HEALTH_COLOUR = ['match', ['get', 'health'], 'LIVE', '#2fbf71', 'DELAYED', '#f0a33a', '#ef5350'];

const collection = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

function pointsGeoJson(points: MapPoint[]): FeatureCollection {
  return collection(
    points.map((p) => ({
      type: 'Feature',
      properties: {
        id: p.id,
        label: p.label,
        health: p.health,
        current: p.current ? 1 : 0,
        selected: p.selected ? 1 : 0,
      },
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    })),
  );
}

function accuracyGeoJson(points: MapPoint[]): FeatureCollection {
  return collection(
    points
      .filter((p) => p.current && p.accuracyM && p.accuracyM > 0)
      .map((p) => ({
        type: 'Feature',
        properties: { health: p.health },
        geometry: {
          type: 'Polygon',
          coordinates: [ring(circlePolygon({ lat: p.lat, lng: p.lng }, p.accuracyM!, 32))],
        },
      })),
  );
}

function ring(points: LatLng[]): [number, number][] {
  const coords = points.map((p) => [p.lng, p.lat] as [number, number]);
  const first = coords[0];
  return first ? [...coords, first] : coords;
}

function boundaryRing(boundary: SiteBoundary): [number, number][] {
  return ring(
    boundary.kind === 'CIRCLE' ? circlePolygon(boundary.center, boundary.radiusM) : boundary.points,
  );
}

function shapesGeoJson(shapes: MapShape[]): FeatureCollection {
  return collection(
    shapes.map((s) => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name, highlight: s.highlight ? 1 : 0 },
      geometry: { type: 'Polygon', coordinates: [boundaryRing(s.boundary)] },
    })),
  );
}

function draftGeoJson(points: LatLng[]): FeatureCollection {
  const coords = points.map((p) => [p.lng, p.lat]);
  const features: Feature[] = points.map((p) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  }));
  if (coords.length >= 2) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  }
  return collection(features);
}

function trackGeoJson(track: MapTrack | null | undefined): FeatureCollection {
  if (!track) return collection([]);
  const features: Feature[] = track.segments
    .filter((s) => s.length >= 2)
    .map((s) => ({
      type: 'Feature',
      properties: { kind: 'line' },
      geometry: { type: 'LineString', coordinates: s.map((p) => [p.lng, p.lat]) },
    }));
  // A lone point between two gaps still shows.
  for (const s of track.segments.filter((x) => x.length === 1)) {
    features.push({
      type: 'Feature',
      properties: { kind: 'point' },
      geometry: { type: 'Point', coordinates: [s[0]!.lng, s[0]!.lat] },
    });
  }
  for (const p of track.flagged) {
    features.push({
      type: 'Feature',
      properties: { kind: 'flag' },
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    });
  }
  if (track.cursor) {
    features.push({
      type: 'Feature',
      properties: { kind: 'cursor' },
      geometry: { type: 'Point', coordinates: [track.cursor.lng, track.cursor.lat] },
    });
  }
  return collection(features);
}

/** A font the tile service serves; without one MapLibre asks for a default it doesn't have. */
const LABEL_FONT = ['Noto Sans Regular'];

const LABEL_PAINT = { 'text-color': '#12161b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 };

export function BoundaryMap(props: {
  shapes: MapShape[];
  /** Editing: clicks report a point; the parent decides what it means. */
  onPick?: (point: LatLng) => void;
  draft?: LatLng[];
  points?: MapPoint[];
  /** A guard marker was clicked. */
  onSelect?: (id: string) => void;
  track?: MapTrack | null;
  center?: LatLng;
  /** Fit the view to these points once they change (e.g. a history track). */
  fit?: LatLng[];
  height?: number | string;
}) {
  const { shapes, onPick, draft, points, onSelect, track, center, fit, height = 420 } = props;
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const pick = useRef(onPick);
  pick.current = onPick;
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    let disposed = false;
    const timeout = window.setTimeout(() => setFailed(true), LOAD_TIMEOUT_MS);
    void (async () => {
      try {
        const maplibre = await import('maplibre-gl');
        if (disposed || !container.current) return;
        maplibre.setWorkerUrl(new URL(MAP_WORKER_URL, window.location.origin).href);
        const start = center ?? DEFAULT_CENTER;
        const instance = new maplibre.Map({
          container: container.current,
          style: MAP_STYLE_URL,
          center: [start.lng, start.lat],
          zoom: 13,
          attributionControl: { compact: true },
        });
        instance.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
        instance.on('load', () => {
          instance.addSource('shapes', { type: 'geojson', data: shapesGeoJson([]) });
          instance.addLayer({
            id: 'shapes-fill',
            type: 'fill',
            source: 'shapes',
            paint: {
              'fill-color': ['case', ['==', ['get', 'highlight'], 1], '#3d74ff', '#2fbf71'],
              'fill-opacity': 0.18,
            },
          });
          instance.addLayer({
            id: 'shapes-line',
            type: 'line',
            source: 'shapes',
            paint: {
              'line-color': ['case', ['==', ['get', 'highlight'], 1], '#3d74ff', '#2fbf71'],
              'line-width': 2,
            },
          });
          instance.addLayer({
            id: 'shapes-label',
            type: 'symbol',
            source: 'shapes',
            layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 12 },
            paint: LABEL_PAINT,
          });
          instance.addSource('draft', { type: 'geojson', data: draftGeoJson([]) });
          instance.addLayer({
            id: 'draft-line',
            type: 'line',
            source: 'draft',
            paint: { 'line-color': '#f0a33a', 'line-width': 2, 'line-dasharray': [2, 1] },
          });
          instance.addLayer({
            id: 'draft-points',
            type: 'circle',
            source: 'draft',
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
              'circle-radius': 5,
              'circle-color': '#f0a33a',
              'circle-stroke-color': '#12161b',
              'circle-stroke-width': 1,
            },
          });

          // Location history: the line, flagged points and the playback cursor.
          instance.addSource('track', { type: 'geojson', data: trackGeoJson(null) });
          instance.addLayer({
            id: 'track-line',
            type: 'line',
            source: 'track',
            filter: ['==', ['get', 'kind'], 'line'],
            paint: { 'line-color': '#3d74ff', 'line-width': 3 },
          });
          instance.addLayer({
            id: 'track-points',
            type: 'circle',
            source: 'track',
            filter: ['in', ['get', 'kind'], ['literal', ['point', 'flag', 'cursor']]],
            paint: {
              'circle-radius': ['match', ['get', 'kind'], 'cursor', 8, 5],
              'circle-color': ['match', ['get', 'kind'], 'flag', '#ef5350', 'cursor', '#ffffff', '#3d74ff'],
              'circle-stroke-color': ['match', ['get', 'kind'], 'cursor', '#3d74ff', '#12161b'],
              'circle-stroke-width': ['match', ['get', 'kind'], 'cursor', 3, 1],
            },
          });

          // Accuracy circles, only once zoomed in far enough for them to mean something.
          instance.addSource('accuracy', { type: 'geojson', data: accuracyGeoJson([]) });
          instance.addLayer({
            id: 'accuracy-fill',
            type: 'fill',
            source: 'accuracy',
            minzoom: 14,
            paint: { 'fill-color': HEALTH_COLOUR as never, 'fill-opacity': 0.12 },
          });

          // Guards: clustered when many share the view (about 1,000 across a large area).
          instance.addSource('points', {
            type: 'geojson',
            data: pointsGeoJson([]),
            cluster: true,
            clusterMaxZoom: 15,
            clusterRadius: 36,
            clusterProperties: {
              offline: ['+', ['case', ['==', ['get', 'health'], 'OFFLINE'], 1, 0]],
              delayed: ['+', ['case', ['==', ['get', 'health'], 'DELAYED'], 1, 0]],
            },
          });
          instance.addLayer({
            id: 'clusters',
            type: 'circle',
            source: 'points',
            filter: ['has', 'point_count'],
            paint: {
              // A cluster shows its worst member's colour, so an offline guard is never hidden.
              'circle-color': [
                'case',
                ['>', ['get', 'offline'], 0],
                '#ef5350',
                ['>', ['get', 'delayed'], 0],
                '#f0a33a',
                '#2fbf71',
              ],
              'circle-radius': ['step', ['get', 'point_count'], 14, 25, 18, 100, 24],
              'circle-stroke-color': '#12161b',
              'circle-stroke-width': 2,
            },
          });
          instance.addLayer({
            id: 'cluster-count',
            type: 'symbol',
            source: 'points',
            filter: ['has', 'point_count'],
            layout: {
              'text-field': ['get', 'point_count_abbreviated'],
              'text-font': LABEL_FONT,
              'text-size': 12,
            },
            paint: { 'text-color': '#12161b' },
          });
          instance.addLayer({
            id: 'points',
            type: 'circle',
            source: 'points',
            filter: ['!', ['has', 'point_count']],
            paint: {
              'circle-radius': ['case', ['==', ['get', 'selected'], 1], 10, 7],
              'circle-color': HEALTH_COLOUR as never,
              // Hollow when the position is only last-known: never styled as live (INV-09).
              'circle-opacity': ['case', ['==', ['get', 'current'], 1], 1, 0],
              'circle-stroke-color': HEALTH_COLOUR as never,
              'circle-stroke-width': ['case', ['==', ['get', 'selected'], 1], 4, 2.5],
            },
          });
          instance.addLayer({
            id: 'points-label',
            type: 'symbol',
            source: 'points',
            filter: ['!', ['has', 'point_count']],
            layout: {
              'text-field': ['get', 'label'],
              'text-font': LABEL_FONT,
              'text-size': 11,
              'text-offset': [0, 1.3],
              'text-anchor': 'top',
            },
            paint: LABEL_PAINT,
          });

          instance.on('click', 'clusters', (event: MapLayerMouseEvent) => {
            const feature = event.features?.[0];
            const clusterId = feature?.properties?.cluster_id as number | undefined;
            if (clusterId === undefined || feature?.geometry.type !== 'Point') return;
            const [lng, lat] = feature.geometry.coordinates as [number, number];
            void instance
              .getSource<GeoJSONSource>('points')
              ?.getClusterExpansionZoom(clusterId)
              .then((zoom) => instance.easeTo({ center: [lng, lat], zoom }));
          });
          instance.on('click', 'points', (event: MapLayerMouseEvent) => {
            const id = event.features?.[0]?.properties?.id as string | undefined;
            if (id) select.current?.(id);
          });
          for (const layer of ['clusters', 'points']) {
            instance.on('mouseenter', layer, () => (instance.getCanvas().style.cursor = 'pointer'));
            instance.on('mouseleave', layer, () => (instance.getCanvas().style.cursor = ''));
          }
          window.clearTimeout(timeout);
          setFailed(false);
          setReady(true);
        });
        instance.on('click', (event: MapMouseEvent) =>
          pick.current?.({ lat: event.lngLat.lat, lng: event.lngLat.lng }),
        );
        instance.on('error', () => undefined);
        map.current = instance;
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      map.current?.remove();
      map.current = null;
    };
    // The map is created once; data updates go through the effects below.
  }, []);

  useEffect(() => {
    if (!ready || !map.current) return;
    void map.current.getSource<GeoJSONSource>('shapes')?.setData(shapesGeoJson(shapes));
  }, [ready, shapes]);

  useEffect(() => {
    if (!ready || !map.current) return;
    void map.current.getSource<GeoJSONSource>('draft')?.setData(draftGeoJson(draft ?? []));
  }, [ready, draft]);

  useEffect(() => {
    if (!ready || !map.current) return;
    void map.current.getSource<GeoJSONSource>('points')?.setData(pointsGeoJson(points ?? []));
    void map.current.getSource<GeoJSONSource>('accuracy')?.setData(accuracyGeoJson(points ?? []));
  }, [ready, points]);

  useEffect(() => {
    if (!ready || !map.current) return;
    void map.current.getSource<GeoJSONSource>('track')?.setData(trackGeoJson(track));
  }, [ready, track]);

  useEffect(() => {
    if (ready && center && map.current)
      map.current.easeTo({ center: [center.lng, center.lat], duration: 400 });
  }, [ready, center?.lat, center?.lng]);

  useEffect(() => {
    if (!ready || !map.current || !fit || fit.length === 0) return;
    const lats = fit.map((p) => p.lat);
    const lngs = fit.map((p) => p.lng);
    map.current.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 40, maxZoom: 17, duration: 0 },
    );
  }, [ready, fit]);

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={container}
        className="map"
        style={{
          height,
          borderRadius: 10,
          overflow: 'hidden',
          border: '1px solid var(--border)',
          cursor: onPick ? 'crosshair' : undefined,
        }}
        aria-label="Map"
      />
      {failed ? (
        <div className="banner error" role="status">
          The map could not be loaded. Check the internet connection, then reload the page.
        </div>
      ) : null}
    </div>
  );
}
