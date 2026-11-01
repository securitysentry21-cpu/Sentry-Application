// The dashboard's live picture (PROD §8.3, §14; D-36). Pure, so it can be tested without a browser:
// the provider (live.tsx) feeds it the snapshot and the stream's events, and freshness is recomputed
// from server time every second. A guard therefore turns DELAYED and OFFLINE on time even when
// nothing arrives, and a last-known position is never shown as live (ADV-U01, INV-09).
import type { Alert, Coverage, LiveGuard, Snapshot, StreamEvent } from '@sentryops/contracts';
import {
  hasTrackingProblem,
  locationAge,
  siteStatus,
  trackingHealth,
  type FreshnessSettings,
  type LocationAge,
  type SiteStatus,
  type TrackingHealth,
} from '@sentryops/domain';

export type Envelope = StreamEvent & { readonly id: string | null };

export type LiveModel = {
  /** Guards on active shifts, by shift ID. */
  readonly guards: ReadonlyMap<string, LiveGuard>;
  /** Active (open or acknowledged) alerts, by ID. */
  readonly alerts: ReadonlyMap<string, Alert>;
  readonly freshness: FreshnessSettings;
  readonly coverage: Coverage;
  readonly shiftsNotStarted: number;
  /** The stream's position: every change up to here is in this model. */
  readonly lastEventId: number;
};

const ACTIVE_ALERT = new Set<Alert['status']>(['OPEN', 'ACKNOWLEDGED']);

export function fromSnapshot(snapshot: Snapshot, alerts: readonly Alert[]): LiveModel {
  return {
    guards: new Map(snapshot.guards.map((g) => [g.shiftId, g])),
    alerts: new Map(alerts.filter((a) => ACTIVE_ALERT.has(a.status)).map((a) => [a.id, a])),
    freshness: snapshot.freshness,
    coverage: snapshot.coverage,
    shiftsNotStarted: snapshot.shiftsNotStarted,
    lastEventId: snapshot.lastEventId,
  };
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : -Infinity);

/** True when `next` is no older than `current`: a late event never rolls the picture back. */
function newerGuard(current: LiveGuard | undefined, next: LiveGuard): boolean {
  if (!current) return true;
  return (
    time(next.lastContactAt) >= time(current.lastContactAt) &&
    time(next.lastFix?.capturedAt) >= time(current.lastFix?.capturedAt) &&
    time(next.deviceReportAt) >= time(current.deviceReportAt)
  );
}

/**
 * What the event says the model can't work out alone. The snapshot is large at pilot scale (about
 * 800 KB for 1,000 guards), so the provider reloads it as rarely as this allows:
 * - `now`: the stream lost its place (resync);
 * - `missing`: a shift started that the model doesn't know yet. A guard who starts from the app
 *   arrives with their next `guard.state` a moment later; only if it doesn't is a reload needed;
 * - `counts`: only a count may have changed (shifts not started); at most once a minute.
 */
export type Reload = false | 'now' | 'counts' | { readonly missing: string };

export type Applied = { readonly model: LiveModel; readonly reload: Reload };

export function applyEvent(model: LiveModel, event: Envelope): Applied {
  const lastEventId = event.id === null ? model.lastEventId : Math.max(model.lastEventId, Number(event.id));
  switch (event.type) {
    case 'guard.state': {
      const guards = new Map(model.guards);
      const { shiftId, guard } = event.data;
      if (!guard) guards.delete(shiftId);
      else if (newerGuard(guards.get(shiftId), guard)) guards.set(shiftId, guard);
      return { model: { ...model, guards, lastEventId }, reload: false };
    }
    case 'alert.opened':
    case 'alert.updated': {
      const alert = event.data.alert;
      if (!alert) return { model: { ...model, lastEventId }, reload: false };
      const current = model.alerts.get(alert.id);
      if (current && current.version > alert.version)
        return { model: { ...model, lastEventId }, reload: false };
      const alerts = new Map(model.alerts);
      if (ACTIVE_ALERT.has(alert.status)) alerts.set(alert.id, alert);
      else alerts.delete(alert.id);
      return { model: { ...model, alerts, lastEventId }, reload: false };
    }
    case 'shift.updated': {
      // A shift that ended leaves the picture now. One that started arrives with its guard.state.
      const { shiftId, status } = event.data;
      if (status === 'ACTIVE') {
        const reload: Reload = model.guards.has(shiftId) ? false : { missing: shiftId };
        return { model: { ...model, lastEventId }, reload };
      }
      const guards = new Map(model.guards);
      guards.delete(shiftId);
      return { model: { ...model, guards, lastEventId }, reload: 'counts' };
    }
    case 'coverage.updated':
      return { model: { ...model, coverage: event.data.coverage, lastEventId }, reload: false };
    case 'resync':
      return { model: { ...model, lastEventId }, reload: 'now' };
  }
}

/** A live guard as the dashboard shows them now: both freshness signals worked out locally. */
export type GuardView = LiveGuard & {
  readonly health: TrackingHealth;
  readonly age: LocationAge;
  readonly onSite: SiteStatus;
  readonly trackingProblem: boolean;
};

export function guardView(g: LiveGuard, now: Date, f: FreshnessSettings): GuardView {
  return {
    ...g,
    health: trackingHealth(now, g.lastContactAt ? new Date(g.lastContactAt) : null, f),
    age: locationAge(now, g.lastFix ? new Date(g.lastFix.capturedAt) : null, f),
    onSite: siteStatus(g.geofenceState),
    trackingProblem: hasTrackingProblem(g),
  };
}

export type HomeCounts = {
  readonly active: number;
  readonly onSite: number;
  readonly offSite: number;
  readonly delayedOrOffline: number;
  readonly trackingProblems: number;
};

/** The exceptions-first numbers (PROD §14.2). */
export function homeCounts(views: readonly GuardView[]): HomeCounts {
  return {
    active: views.length,
    onSite: views.filter((v) => v.onSite === 'ON_SITE').length,
    offSite: views.filter((v) => v.onSite === 'OFF_SITE').length,
    delayedOrOffline: views.filter((v) => v.health !== 'LIVE').length,
    trackingProblems: views.filter((v) => v.trackingProblem).length,
  };
}

const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;

/** Severity first, then the oldest (PROD §14.2). */
export function alertsBySeverity(alerts: Iterable<Alert>): Alert[] {
  return [...alerts].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.openedAt.localeCompare(b.openedAt),
  );
}
