import type { Alert, IncidentSummary, LiveGuard, Snapshot } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import { locationLine, trackingLine } from '../components/guard-panel';
import {
  applyEvent,
  fromSnapshot,
  guardView,
  homeCounts,
  type Envelope,
  type LiveModel,
} from '../lib/live-model';
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

function snapshot(guards: LiveGuard[], lastEventId = 10, openIncidents = 0): Snapshot {
  return {
    serverTime: iso(0),
    lastEventId,
    freshness: FRESHNESS,
    guards,
    shiftsNotStarted: 0,
    openIncidents,
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
    sosEventId: null,
    incidentId: null,
    isDrill: false,
    drillId: null,
    escalationLevel: 0,
    version: 1,
    ...overrides,
  };
}

function incident(overrides: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    id: '0190a0d2-7c5e-7000-8000-0000000000dd',
    referenceNumber: 'INC-000001',
    type: 'THEFT',
    severity: 'MEDIUM',
    status: 'OPEN',
    title: 'Theft',
    guard: null,
    reportedBy: null,
    site: null,
    checkpoint: null,
    shiftId: null,
    sosEventId: null,
    occurredAt: iso(-7200),
    reportedAt: iso(-7200),
    receivedAt: iso(-7200),
    acknowledgedAt: null,
    resolvedAt: null,
    photoCount: 0,
    isDrill: false,
    version: 1,
    ...overrides,
  };
}

const incidentEvent = (
  i: IncidentSummary,
  id: string,
  type: 'incident.created' | 'incident.updated' = 'incident.updated',
): Envelope => ({ id, type, occurredAt: iso(1), data: { incidentId: i.id, incident: i } });

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

  it('an export event leaves the picture as it is and only moves the stream position on', () => {
    const model = fromSnapshot(snapshot([guard()], 10, 1), [alert()]);
    const applied = applyEvent(model, {
      id: '11',
      type: 'export.updated',
      occurredAt: iso(1),
      data: { exportId: '0190a0d2-7c5e-7000-8000-0000000000ff' },
    });
    // The Exports page reloads its own list; the live picture needs no snapshot for it.
    expect(applied.reload).toBe(false);
    expect(applied.model).toEqual({ ...model, lastEventId: 11 });
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

describe('SOS and incident events (ARCH §14, PROD §11.6, §14.2)', () => {
  const SOS = '0190a0d2-7c5e-7000-8000-0000000000ee';
  const sosAlert = (overrides: Partial<Alert> = {}) =>
    alert({
      type: 'SOS_ACTIVATED',
      severity: 'CRITICAL',
      summary: 'SOS: Ahmed Khan (ABC Warehouse)',
      sosEventId: SOS,
      dismissible: false,
      ...overrides,
    });
  const sosEvent = (
    a: Alert | null,
    id: string,
    type: 'sos.activated' | 'sos.updated' = 'sos.updated',
  ): Envelope => ({
    id,
    type,
    occurredAt: iso(1),
    data: { sosEventId: SOS, alert: a, position: null, positionOnly: false },
  });

  it('an SOS event carries its alert: it opens, is acknowledged, pressed again and resolved, and a late copy never rolls it back', () => {
    let model = fromSnapshot(snapshot([]), []);
    let applied = applyEvent(model, sosEvent(sosAlert(), '11', 'sos.activated'));
    expect(applied.reload).toBe(false);
    model = applied.model;
    expect(model.alerts.get(sosAlert().id)?.status).toBe('OPEN');
    expect(model.lastEventId).toBe(11);
    model = applyEvent(model, sosEvent(sosAlert({ status: 'ACKNOWLEDGED', version: 2 }), '12')).model;
    // The activation again, from a replay: older, ignored.
    model = applyEvent(model, sosEvent(sosAlert(), '13', 'sos.activated')).model;
    expect(model.alerts.get(sosAlert().id)?.status).toBe('ACKNOWLEDGED');
    // Pressed again after the acknowledgement: open again (owner decision 2026-11-02).
    model = applyEvent(
      model,
      sosEvent(sosAlert({ status: 'OPEN', triggerCount: 2, version: 3 }), '14'),
    ).model;
    expect(model.alerts.get(sosAlert().id)?.triggerCount).toBe(2);
    expect(model.alerts.get(sosAlert().id)?.status).toBe('OPEN');
    model = applyEvent(model, sosEvent(sosAlert({ status: 'RESOLVED', version: 4 }), '15')).model;
    expect(model.alerts.size).toBe(0);
    // An SOS event whose alert isn't visible to this dashboard only moves the position on.
    applied = applyEvent(model, sosEvent(null, '16'));
    expect(applied.model.alerts.size).toBe(0);
    expect(applied.model.lastEventId).toBe(16);
  });

  it('an alert the server returned (after an acknowledgement) applies like an event, without moving the stream position', () => {
    let model = fromSnapshot(snapshot([], 20), [sosAlert()]);
    model = applyEvent(model, {
      id: null,
      type: 'alert.updated',
      occurredAt: iso(2),
      data: { alertId: sosAlert().id, alert: sosAlert({ status: 'ACKNOWLEDGED', version: 2 }) },
    }).model;
    expect(model.alerts.get(sosAlert().id)?.status).toBe('ACKNOWLEDGED');
    expect(model.lastEventId).toBe(20);
  });

  it('a new incident counts once, however often its events arrive, and leaves the count when resolved', () => {
    let model: LiveModel = fromSnapshot(snapshot([], 10, 2), []);
    expect(model.openIncidents).toBe(2);
    const fresh = incident({ receivedAt: iso(5), reportedAt: iso(5), occurredAt: iso(4) });
    let applied = applyEvent(model, incidentEvent(fresh, '11', 'incident.created'));
    expect(applied.reload).toBe(false);
    model = applied.model;
    expect(model.openIncidents).toBe(3);
    // The same event replayed after a reconnection changes nothing.
    model = applyEvent(model, incidentEvent(fresh, '11', 'incident.created')).model;
    expect(model.openIncidents).toBe(3);
    // A note, then an acknowledgement: still open.
    model = applyEvent(model, incidentEvent({ ...fresh, version: 2 }, '12')).model;
    model = applyEvent(model, incidentEvent({ ...fresh, status: 'ACKNOWLEDGED', version: 3 }, '13')).model;
    expect(model.openIncidents).toBe(3);
    applied = applyEvent(
      model,
      incidentEvent({ ...fresh, status: 'RESOLVED', resolvedAt: iso(30), version: 4 }, '14'),
    );
    expect(applied.reload).toBe(false);
    model = applied.model;
    expect(model.openIncidents).toBe(2);
    // Reopened: back in the count.
    model = applyEvent(
      model,
      incidentEvent({ ...fresh, status: 'OPEN', resolvedAt: null, version: 5 }, '15'),
    ).model;
    expect(model.openIncidents).toBe(3);
    expect(model.lastEventId).toBe(15);
  });

  it('an incident older than the snapshot moves the count only by what changed since the snapshot', () => {
    const base = fromSnapshot(snapshot([], 10, 2), []);
    // Resolved after the snapshot: it was open in its count.
    const resolvedSince = applyEvent(
      base,
      incidentEvent(incident({ status: 'RESOLVED', resolvedAt: iso(10), version: 3 }), '11'),
    );
    expect(resolvedSince.model.openIncidents).toBe(1);
    expect(resolvedSince.reload).toBe(false);
    // Resolved before the snapshot and given a note since: the count already left it out.
    const noteOnResolved = applyEvent(
      base,
      incidentEvent(incident({ status: 'RESOLVED', resolvedAt: iso(-60), version: 4 }), '11'),
    );
    expect(noteOnResolved.model.openIncidents).toBe(2);
    expect(noteOnResolved.reload).toBe(false);
    // Acknowledged since: open then, open now.
    const acknowledged = applyEvent(
      base,
      incidentEvent(incident({ status: 'ACKNOWLEDGED', acknowledgedAt: iso(10), version: 2 }), '11'),
    );
    expect(acknowledged.model.openIncidents).toBe(2);
    expect(acknowledged.reload).toBe(false);
    // Open, with a note or a reopen since: the count stays and is checked against a fresh snapshot.
    const openNow = applyEvent(base, incidentEvent(incident({ version: 2 }), '11'));
    expect(openNow.model.openIncidents).toBe(2);
    expect(openNow.reload).toBe('counts');
    // Created just as the snapshot was read: it may be in its count already. Checked, not guessed.
    const justBefore = applyEvent(
      base,
      incidentEvent(incident({ receivedAt: iso(-1) }), '11', 'incident.created'),
    );
    expect(justBefore.model.openIncidents).toBe(2);
    expect(justBefore.reload).toBe('counts');
  });

  it('the open-incident count never goes below zero, and an incident this dashboard may not see only moves the position on', () => {
    const base = fromSnapshot(snapshot([], 10, 0), []);
    const resolved = applyEvent(
      base,
      incidentEvent(incident({ status: 'RESOLVED', resolvedAt: iso(10), version: 3 }), '11'),
    );
    expect(resolved.model.openIncidents).toBe(0);
    const hidden = applyEvent(base, {
      id: '12',
      type: 'incident.updated',
      occurredAt: iso(1),
      data: { incidentId: incident().id, incident: null },
    });
    expect(hidden.model.openIncidents).toBe(0);
    expect(hidden.model.lastEventId).toBe(12);
    // A new snapshot starts over from its own count.
    expect(fromSnapshot(snapshot([], 30, 5), []).openIncidents).toBe(5);
    expect(fromSnapshot(snapshot([], 30, 5), []).incidents.size).toBe(0);
  });
});
