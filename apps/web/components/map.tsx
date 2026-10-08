'use client';

// The dashboard map (D-12 revised: MapLibre GL with OpenFreeMap vector tiles, behind this one
// component so the provider can change). It shows site boundaries and, in editing mode, lets the
// user place a circle's centre or draw a polygon's corners by clicking. Labels come only from
// MapLibre's text rendering, never HTML popups (SEC §8).
import 'maplibre-gl/dist/maplibre-gl.css';

import type { SiteBoundary } from '@sentryops/contracts';
import { circlePolygon } from '@sentryops/domain';
import type { Feature, FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';

export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
/** The pilot colony's area, Lahore (Q-19, about 400 km²): the default view until sites exist. */
export const DEFAULT_CENTER = { lat: 31.4697, lng: 74.4078 };

type LatLng = { lat: number; lng: number };

export type MapShape = { id: string; name: string; boundary: SiteBoundary; highlight?: boolean };

/** A guard on the map: coloured by tracking health; a last-known location is drawn hollow (INV-09). */
export type MapPoint = {
  id: string;
  label: string;
  lat: number;
  lng: number;
  health: 'LIVE' | 'DELAYED' | 'OFFLINE';
  current: boolean;
};

function pointsGeoJson(points: MapPoint[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      properties: { id: p.id, label: p.label, health: p.health, current: p.current ? 1 : 0 },
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    })),
  };
}

function ring(boundary: SiteBoundary): [number, number][] {
  const points =
    boundary.kind === 'CIRCLE' ? circlePolygon(boundary.center, boundary.radiusM) : boundary.points;
  const coords = points.map((p) => [p.lng, p.lat] as [number, number]);
  const first = coords[0];
  return first ? [...coords, first] : coords;
}

function shapesGeoJson(shapes: MapShape[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: shapes.map((s) => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name, highlight: s.highlight ? 1 : 0 },
      geometry: { type: 'Polygon', coordinates: [ring(s.boundary)] },
    })),
  };
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
  return { type: 'FeatureCollection', features };
}

export function BoundaryMap(props: {
  shapes: MapShape[];
  /** Editing: clicks report a point; the parent decides what it means. */
  onPick?: (point: LatLng) => void;
  draft?: LatLng[];
  points?: MapPoint[];
  center?: LatLng;
  height?: number;
}) {
  const { shapes, onPick, draft, points, center, height = 420 } = props;
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const maplibre = await import('maplibre-gl');
        if (disposed || !container.current) return;
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
            layout: { 'text-field': ['get', 'name'], 'text-size': 12 },
            paint: { 'text-color': '#12161b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
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
          instance.addSource('points', { type: 'geojson', data: pointsGeoJson([]) });
          instance.addLayer({
            id: 'points',
            type: 'circle',
            source: 'points',
            paint: {
              'circle-radius': 7,
              'circle-color': [
                'match',
                ['get', 'health'],
                'LIVE',
                '#2fbf71',
                'DELAYED',
                '#f0a33a',
                '#ef5350',
              ],
              // Hollow when the position is only last-known: never styled as live (INV-09).
              'circle-opacity': ['case', ['==', ['get', 'current'], 1], 1, 0],
              'circle-stroke-color': [
                'match',
                ['get', 'health'],
                'LIVE',
                '#2fbf71',
                'DELAYED',
                '#f0a33a',
                '#ef5350',
              ],
              'circle-stroke-width': 2.5,
            },
          });
          instance.addLayer({
            id: 'points-label',
            type: 'symbol',
            source: 'points',
            layout: {
              'text-field': ['get', 'label'],
              'text-size': 11,
              'text-offset': [0, 1.3],
              'text-anchor': 'top',
            },
            paint: { 'text-color': '#12161b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
          });
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
  }, [ready, points]);

  useEffect(() => {
    if (ready && center && map.current)
      map.current.easeTo({ center: [center.lng, center.lat], duration: 400 });
  }, [ready, center?.lat, center?.lng]);

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={container}
        style={{
          height,
          borderRadius: 10,
          overflow: 'hidden',
          border: '1px solid var(--border)',
          cursor: onPick ? 'crosshair' : undefined,
        }}
        aria-label="Map"
      />
      {failed ? <div className="banner error">The map could not be loaded.</div> : null}
    </div>
  );
}
