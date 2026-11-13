import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { StyleSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import { MAP_TILE_ORIGIN } from '../lib/csp';
import { MAP_PALETTE, tintMapStyle } from '../lib/map-style';

/** The shape of OpenFreeMap's "dark" style, cut down to a few layers. */
function served(): StyleSpecification {
  return {
    version: 8,
    glyphs: `${MAP_TILE_ORIGIN}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${MAP_TILE_ORIGIN}/sprites/ofm_f384/ofm`,
    sources: { openmaptiles: { type: 'vector', url: `${MAP_TILE_ORIGIN}/planet` } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': 'rgb(12,12,12)' } },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        paint: { 'fill-color': 'rgb(27 ,27 ,29)', 'fill-antialias': false },
      },
      {
        id: 'place_city',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        layout: { 'text-field': '{name}', 'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': 'rgb(101,101,101)' },
      },
      {
        id: 'landcover_wood',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landcover',
        paint: { 'fill-color': 'rgb(32,32,32)', 'fill-pattern': 'wood-pattern' },
      },
      {
        id: 'place_town',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        layout: { 'text-field': '{name}', 'icon-image': ['step', ['zoom'], 'circle-11', 9, ''] },
        paint: { 'text-color': 'rgb(101,101,101)' },
      },
      {
        id: 'a_layer_added_later',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        paint: { 'line-color': '#123456' },
      },
    ],
  };
}

describe('the map colours (lib/map-style.ts)', () => {
  it('recolour the base map layers it knows and leave any other layer as served', () => {
    const style = tintMapStyle(served());
    const paint = (id: string) => style.layers.find((l) => l.id === id)?.paint as Record<string, unknown>;
    expect(paint('background')['background-color']).toBe(MAP_PALETTE.land);
    expect(paint('water')['fill-color']).toBe(MAP_PALETTE.water);
    // Only the colour changes; other paint and the layout are kept.
    expect(paint('water')['fill-antialias']).toBe(false);
    expect(style.layers.find((l) => l.id === 'place_city')).toMatchObject({
      layout: { 'text-font': ['Noto Sans Regular'] },
    });
    expect(paint('a_layer_added_later')).toEqual({ 'line-color': '#123456' });
  });

  it('drop the images the served sprite lacks, keeping the colour and the names', () => {
    const style = tintMapStyle(served());
    type Props = { paint?: Record<string, unknown>; layout?: Record<string, unknown> };
    const layer = (id: string) => style.layers.find((l) => l.id === id) as Props | undefined;
    expect(layer('landcover_wood')?.paint).not.toHaveProperty('fill-pattern');
    expect(layer('landcover_wood')?.paint?.['fill-color']).not.toBe('rgb(32,32,32)');
    expect(layer('place_town')?.layout).toEqual({ 'text-field': '{name}' });
  });

  it('SEC §10 keep every source, font and sprite address as served: the map still loads from the one tile host the policy allows', () => {
    const before = served();
    const style = tintMapStyle(before);
    expect(style.sources).toEqual(before.sources);
    expect(style.glyphs).toBe(before.glyphs);
    expect(style.sprite).toBe(before.sprite);
    // The served style is not changed in place.
    expect(before).toEqual(served());
  });

  it('draw tracking health on the map in the same colours as the rest of the dashboard', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'app', 'globals.css'), 'utf8');
    const token = (name: string) =>
      new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1]?.toLowerCase();
    expect(token('live')).toBe(MAP_PALETTE.live);
    expect(token('delayed')).toBe(MAP_PALETTE.delayed);
    expect(token('offline')).toBe(MAP_PALETTE.offline);
  });
});
