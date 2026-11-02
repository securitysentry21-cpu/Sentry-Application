// User text renders as text (SEC §8): guard names, site names and anything else people type are
// never interpreted as HTML in the dashboard, on desktops or phones, or in the map's details.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type {
  Checkpoint,
  CheckpointVisit,
  LiveGuard,
  PatrolRoute,
  PatrolRun,
  Site,
} from '@sentryops/contracts';
import type { AnchorHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CheckpointEditor } from '../components/checkpoint-editor';
import { GuardPanel } from '../components/guard-panel';
import { RouteEditor, RouteTable } from '../components/patrol-routes';
import { RunDetail, RunsTable, VisitsTable } from '../components/patrol-runs';
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

  it('ADV-W01 script payloads in checkpoint, route, guard and site names render as text in the patrol views and editors', () => {
    const id = (n: number) => `0190a0d2-7c5e-7000-8000-${String(n).padStart(12, '0')}`;
    const site: Site = {
      id: id(1),
      name: SCRIPT,
      clientName: PAYLOAD,
      addressLine1: null,
      city: null,
      country: 'PK',
      timezone: 'Asia/Karachi',
      boundary: { kind: 'CIRCLE', center: { lat: 31.47, lng: 74.4 }, radiusM: 150 },
      center: { lat: 31.47, lng: 74.4 },
      status: 'ACTIVE',
      notes: null,
      checkpointCount: 2,
      version: 1,
      createdAt: '2026-10-20T12:00:00Z',
      updatedAt: '2026-10-20T12:00:00Z',
    };
    const gate: Checkpoint = {
      id: id(2),
      siteId: site.id,
      name: PAYLOAD,
      description: SCRIPT,
      location: null,
      verificationRadiusM: 30,
      qrVersion: 1,
      qrRotatedAt: null,
      status: 'INACTIVE',
      version: 1,
    };
    const office: Checkpoint = { ...gate, id: id(3), name: SCRIPT, location: { lat: 31.4701, lng: 74.4001 } };
    const spare: Checkpoint = { ...gate, id: id(4), name: `${PAYLOAD} spare`, status: 'ACTIVE' };
    const route: PatrolRoute = {
      id: id(5),
      siteId: site.id,
      name: PAYLOAD,
      description: SCRIPT,
      enforceOrder: true,
      schedule: { intervalMinutes: 60, firstRunOffsetMinutes: 0, completionWindowMinutes: 30 },
      status: 'ACTIVE',
      checkpoints: [
        { checkpointId: gate.id, name: gate.name, sequence: 1, required: true },
        { checkpointId: office.id, name: office.name, sequence: 2, required: false },
      ],
      version: 1,
      updatedAt: '2026-10-20T12:00:00Z',
    };
    const run: PatrolRun = {
      id: id(6),
      shiftId: id(7),
      guard: { id: id(8), displayName: PAYLOAD },
      site: { id: site.id, name: SCRIPT, timezone: 'Asia/Karachi' },
      route: { id: route.id, name: PAYLOAD },
      sequenceNo: 2,
      dueAt: '2026-10-20T16:00:00Z',
      windowEndsAt: '2026-10-20T16:30:00Z',
      status: 'INCOMPLETE',
      startedAt: '2026-10-20T16:05:00Z',
      completedAt: null,
      closedAt: '2026-10-20T16:32:00Z',
      requiredCount: 2,
      countedCount: 1,
      unconfirmedCount: 1,
      missing: [SCRIPT],
    };
    const visit: CheckpointVisit = {
      id: id(9),
      shiftId: run.shiftId,
      runId: run.id,
      checkpoint: { id: gate.id, name: PAYLOAD },
      scannedAt: '2026-10-20T16:05:00Z',
      receivedAt: '2026-10-20T16:20:00Z',
      outcome: 'LOCATION_UNCONFIRMED',
      reason: 'NO_FIX',
      counted: true,
      distanceM: null,
      accuracyM: null,
      // An unknown code still renders as words, as text.
      flags: ['OUT_OF_ORDER', '<b>NEW_FLAG</b>'],
      late: true,
    };
    const stray: CheckpointVisit = {
      ...visit,
      id: id(10),
      runId: null,
      checkpoint: null,
      outcome: 'INVALID_QR',
    };
    const html = renderToStaticMarkup(
      <>
        <RunsTable runs={[run]} onSelect={() => undefined} />
        <RunsTable runs={[run]} showGuard={false} withDate href={(r) => `/patrols?run=${r.id}`} />
        <RunDetail
          detail={{
            run,
            enforceOrder: true,
            checkpoints: [
              {
                checkpointId: gate.id,
                name: PAYLOAD,
                sequence: 1,
                required: true,
                location: null,
                done: 'QR_ONLY',
              },
              {
                checkpointId: office.id,
                name: SCRIPT,
                sequence: 2,
                required: true,
                location: office.location,
                done: null,
              },
            ],
            visits: [visit],
          }}
          onClose={() => undefined}
        />
        <VisitsTable
          visits={[visit, stray]}
          timezone="Asia/Karachi"
          rounds={new Map([[run.id, `${PAYLOAD} · round 2`]])}
        />
        <RouteTable routes={[route]} onEdit={() => undefined} />
        <RouteEditor
          siteId={site.id}
          route={route}
          checkpoints={[gate, office, spare]}
          routes={[route, { ...route, id: id(11), name: SCRIPT }]}
          onClose={() => undefined}
          onSaved={() => undefined}
        />
        <CheckpointEditor
          site={site}
          checkpoint={gate}
          checkpoints={[gate, office, spare]}
          routes={[route]}
          onClose={() => undefined}
          onSaved={() => undefined}
        />
      </>,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The words around them are there: outcomes, reasons, flags and progress.
    expect(html).toContain('QR only');
    expect(html).toContain('no GPS fix');
    expect(html).toContain('out of order');
    expect(html).toContain('sent late');
    expect(html).toContain('1 of 2 (1 QR only)');
    expect(html).toContain('Unknown or old label');
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
