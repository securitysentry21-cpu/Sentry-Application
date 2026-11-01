// User text renders as text (SEC §8): guard names, site names and anything else people type are
// never interpreted as HTML in the dashboard, on desktops or phones, or in the map's details.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { LiveGuard } from '@sentryops/contracts';
import type { AnchorHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { GuardPanel } from '../components/guard-panel';
import { guardView } from '../lib/live-model';

vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={props.href}>{props.children}</a>,
}));

const ROOT = join(import.meta.dirname, '..');
const PAYLOAD = '<img src=x onerror=alert(1)>';
const SCRIPT = '<script>alert(1)</script>';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('plain text only (SEC §8)', () => {
  it('ADV-W01 script payloads in guard and site names render as text in the guard details (the map’s panel)', () => {
    const now = new Date('2026-10-20T21:00:10Z');
    const g: LiveGuard = {
      shiftId: '0190a0d2-7c5e-7000-8000-000000000001',
      guard: { id: '0190a0d2-7c5e-7000-8000-0000000000aa', displayName: PAYLOAD, employeeNumber: SCRIPT },
      site: { id: '0190a0d2-7c5e-7000-8000-0000000000bb', name: SCRIPT, timezone: 'Asia/Karachi' },
      startsAt: '2026-10-20T15:00:00Z',
      startedAt: '2026-10-20T15:00:00Z',
      endsAt: '2026-10-21T03:00:00Z',
      manualStart: false,
      startFlags: [],
      lastFix: { lat: 31.47, lng: 74.4, accuracyM: 8, capturedAt: '2026-10-20T21:00:00Z' },
      lastContactAt: '2026-10-20T21:00:00Z',
      trackingHealth: 'LIVE',
      locationAge: 'CURRENT',
      geofenceState: 'INSIDE',
      trackingServiceState: 'RUNNING',
      locationPermission: 'ALWAYS',
      batteryPct: 64,
      isCharging: false,
      appVersion: '<b>1.4.2</b>',
      pendingQueueCount: 0,
      deviceReportAt: '2026-10-20T21:00:00Z',
    };
    const html = renderToStaticMarkup(
      <GuardPanel
        guard={guardView(g, now, { healthLiveMaxS: 90, offlineAfterS: 300, locationCurrentMaxS: 150 })}
        now={now}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('ADV-W01 the dashboard has no HTML sink: no innerHTML, map popup HTML or dangerouslySetInnerHTML', () => {
    const SINKS = [
      /dangerouslySetInnerHTML/,
      /\.innerHTML\s*=/,
      /\.outerHTML\s*=/,
      /insertAdjacentHTML/,
      /document\.write/,
      // MapLibre popups: HTML content is how map labels become markup.
      /\.setHTML\s*\(/,
      /new\s+\w*\.?Popup\s*\(/,
    ];
    const found: string[] = [];
    for (const dir of ['app', 'components', 'lib']) {
      for (const file of sources(join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        for (const sink of SINKS) if (sink.test(text)) found.push(`${relative(ROOT, file)}: ${sink.source}`);
      }
    }
    expect(found).toEqual([]);
  });
});
