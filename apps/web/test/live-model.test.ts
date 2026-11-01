import type { Alert, LiveGuard, Snapshot } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import { locationLine, trackingLine } from '../components/guard-panel';
import { applyEvent, fromSnapshot, guardView, homeCounts, type Envelope } from '../lib/live-model';
import { parseFrames } from '../lib/stream';

const T0 = Date.parse('2026-10-20T21:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const iso = (seconds: number) => at(seconds).toISOString();
const FRESHNESS = { healthLiveMaxS: 90, offlineAfterS: 300, locationCurrentMaxS: 150 };

function guard(overrides: Partial<LiveGuard> = {}): LiveGuard {
  return {
    shiftId: '0190a0d2-7c5e-7000-8000-000000000001',
    guard: { id: '0190a0d2-7c5e-7000-8000-0000000000aa', displayName: 'Ahmed Khan', employeeNumber: 'E-1' },
    site: { id: '0190a0d2-7c5e-7000-8000-0000000000bb', name: 'ABC Warehouse', timezone: 'Asia/Karachi' },
    startsAt: iso(-3600),
    startedAt: iso(-3600),
    endsAt: iso(8 * 3600),
    manualStart: false,
    startFlags: [],
    lastFix: { lat: 31.47, lng: 74.4, accuracyM: 8, capturedAt: iso(0) },
    lastContactAt: iso(0),
    trackingHealth: 'LIVE',
    locationAge: 'CURRENT',
    geofenceState: 'INSIDE',
    trackingServiceState: 'RUNNING',
    locationPermission: 'ALWAYS',
    batteryPct: 64,
    isCharging: false,
    appVersion: '1.4.2',
    pendingQueueCount: 0,
    deviceReportAt: iso(0),
    ...overrides,
  };
}

function snapshot(guards: LiveGuard[], lastEventId = 10): Snapshot {
  return {
    serverTime: iso(0),
    lastEventId,
    freshness: FRESHNESS,
    guards,
    shiftsNotStarted: 0,
    coverage: { desktop: 1, phone: 0 },
  };
}

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: '0190a0d2-7c5e-7000-8000-0000000000cc',
    type: 'GUARD_LEFT_SITE',
    severity: 'HIGH',
    status: 'OPEN',
    summary: 'Left site: Ahmed Khan (ABC Warehouse)',
    guard: null,
    site: null,
    shiftId: null,
    details: {},
    openedAt: iso(0),
    lastTriggeredAt: iso(0),
    triggerCount: 1,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolutionType: null,
    resolutionNote: null,
    dismissedAt: null,
    dismissReason: null,
    detectedLate: false,
    dismissible: true,
    version: 1,
    ...overrides,
  };
}

describe('the dashboard keeps time on its own (D-36, INV-09)', () => {
  it('ADV-U01 with no events for 6 minutes after a current fix from a live phone: DELAYED, then OFFLINE, and LAST KNOWN, never live', () => {
    const model = fromSnapshot(snapshot([guard()]), []);
    const g = model.guards.values().next().value!;
    // No event arrives; only the clock moves.
    const fresh = guardView(g, at(10), model.freshness);
    expect([fresh.health, fresh.age]).toEqual(['LIVE', 'CURRENT']);
    const delayed = guardView(g, at(120), model.freshness);
    expect(delayed.health).toBe('DELAYED');
    const later = guardView(g, at(360), model.freshness);
    expect([later.health, later.age]).toEqual(['OFFLINE', 'LAST_KNOWN']);
    expect(locationLine(later, at(360))).toBe('Last known location · 6 min ago · ±8 m');
    expect(trackingLine(later, at(360))).toBe('last update 6 min ago');
    expect(homeCounts([later]).delayedOrOffline).toBe(1);
  });
});

describe('applying the stream (ARCH §14)', () => {
  it('updates a guard, and a late copy never rolls the picture back', () => {
    let model = fromSnapshot(snapshot([guard()]), []);
    const newer = guard({
      lastContactAt: iso(30),
      lastFix: { lat: 31.48, lng: 74.4, accuracyM: 5, capturedAt: iso(30) },
    });
    model = applyEvent(model, {
      id: '11',
      type: 'guard.state',
      occurredAt: iso(30),
      data: { shiftId: newer.shiftId, guard: newer },
    }).model;
    expect(model.guards.get(newer.shiftId)?.lastContactAt).toBe(iso(30));
    expect(model.lastEventId).toBe(11);
    const stale = guard({ lastContactAt: iso(5) });
    model = applyEvent(model, {
      id: '12',
      type: 'guard.state',
      occurredAt: iso(5),
      data: { shiftId: stale.shiftId, guard: stale },
    }).model;
    expect(model.guards.get(newer.shiftId)?.lastContactAt).toBe(iso(30));
  });

  it('removes a guard whose shift ended, and reloads the snapshot only when it must', () => {
    let model = fromSnapshot(snapshot([guard()]), []);
    const ended = applyEvent(model, {
      id: '11',
      type: 'shift.updated',
      occurredAt: iso(40),
      data: { shiftId: guard().shiftId, status: 'COMPLETED' },
    });
    expect(ended.model.guards.size).toBe(0);
    // Only the count of shifts not started may have changed: refreshed at most once a minute.
    expect(ended.reload).toBe('counts');
    model = ended.model;
    // A start the model doesn't know yet: wait for its guard.state before reloading for it.
    const started = applyEvent(model, {
      id: '12',
      type: 'shift.updated',
      occurredAt: iso(42),
      data: { shiftId: guard().shiftId, status: 'ACTIVE' },
    });
    expect(started.reload).toEqual({ missing: guard().shiftId });
    expect(applyEvent(model, { id: '13', type: 'resync', occurredAt: iso(43), data: {} }).reload).toBe('now');
  });

  it('keeps only active alerts, and an older copy of an alert never replaces a newer one', () => {
    let model = fromSnapshot(snapshot([]), []);
    const open = alert();
    const event = (
      a: Alert,
      id: string,
      type: 'alert.opened' | 'alert.updated' = 'alert.updated',
    ): Envelope => ({
      id,
      type,
      occurredAt: iso(1),
      data: { alertId: a.id, alert: a },
    });
    model = applyEvent(model, event(open, '11', 'alert.opened')).model;
    expect(model.alerts.size).toBe(1);
    const acknowledged = alert({ status: 'ACKNOWLEDGED', version: 2 });
    model = applyEvent(model, event(acknowledged, '12')).model;
    model = applyEvent(model, event(open, '13')).model;
    expect(model.alerts.get(open.id)?.status).toBe('ACKNOWLEDGED');
    model = applyEvent(model, event(alert({ status: 'RESOLVED', version: 3 }), '14')).model;
    expect(model.alerts.size).toBe(0);
  });

  it('reads the stream format: frames, keep-alives and a frame split across chunks', () => {
    const frame = (seq: number) =>
      `id: ${seq}\nevent: coverage.updated\ndata: ${JSON.stringify({ id: String(seq), type: 'coverage.updated', occurredAt: iso(0), data: { coverage: { desktop: 2, phone: 1 } } })}\n\n`;
    const whole = `retry: 3000\n\n: keep-alive\n\n${frame(5)}${frame(6)}`;
    const cut = whole.length - 10;
    const first = parseFrames(whole.slice(0, cut));
    expect(first.events.map((e) => e.id)).toEqual(['5']);
    const second = parseFrames(first.rest + whole.slice(cut));
    expect(second.events.map((e) => e.id)).toEqual(['6']);
    expect(second.rest).toBe('');
  });
});
