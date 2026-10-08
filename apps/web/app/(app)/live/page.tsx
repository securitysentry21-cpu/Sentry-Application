'use client';

// The live view (PROD §14, D-36). Tracking health (when the server last heard from the phone) and
// location age (when the newest fix was taken) are shown separately and recomputed every second
// against server time, so a guard turns DELAYED and OFFLINE on time even when nothing new arrives
// (ADV-U01). A last-known position is never styled as live (INV-09). Snapshot polling now; the
// realtime stream replaces the polling in Phase 6.
import type { Alert, Site } from '@sentryops/contracts';
import { locationAge, trackingHealth, type FreshnessSettings } from '@sentryops/domain';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { BoundaryMap, type MapPoint, type MapShape } from '../../../components/map';
import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import { ALERT_TYPE_LABEL, formatRelative } from '../../../lib/format';
import { useSession } from '../../../lib/session';

type LiveGuard = {
  shiftId: string;
  guard: { id: string; displayName: string; employeeNumber: string };
  site: { id: string; name: string };
  startedAt: string | null;
  endsAt: string;
  manualStart: boolean;
  startFlags: string[];
  lastFix: { lat: number; lng: number; accuracyM: number | null; capturedAt: string } | null;
  lastContactAt: string | null;
  trackingServiceState: string | null;
  locationPermission: string | null;
  batteryPct: number | null;
  pendingQueueCount: number | null;
};

type Snapshot = { serverTime: string; freshness: FreshnessSettings; guards: LiveGuard[] };

const HEALTH_BADGE = { LIVE: 'ok', DELAYED: 'warn', OFFLINE: 'danger' } as const;
const POLL_MS = 15_000;

export default function LivePage() {
  const { can, membership } = useSession();
  const canAlerts = can('alerts.read');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [sites, setSites] = useState<Site[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const s = await api<Snapshot>('/dashboard/snapshot');
      // Freshness is judged by server time, never this computer's clock.
      setOffsetMs(new Date(s.serverTime).getTime() - Date.now());
      setSnapshot(s);
      if (canAlerts) setAlerts((await api<{ alerts: Alert[] }>('/alerts?status=active&limit=500')).alerts);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [canAlerts]);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    const clock = window.setInterval(() => setTick(Date.now()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [load, membership.organizationId]);

  useEffect(() => {
    if (!can('sites.read')) return;
    void api<{ sites: Site[] }>('/sites')
      .then((r) => setSites(r.sites))
      .catch(() => undefined);
  }, [can, membership.organizationId]);

  const now = new Date(tick + offsetMs);
  const rows = (snapshot?.guards ?? []).map((g) => ({
    ...g,
    health: trackingHealth(now, g.lastContactAt ? new Date(g.lastContactAt) : null, snapshot!.freshness),
    age: locationAge(now, g.lastFix ? new Date(g.lastFix.capturedAt) : null, snapshot!.freshness),
  }));

  const points: MapPoint[] = rows
    .filter((r) => r.lastFix)
    .map((r) => ({
      id: r.shiftId,
      label: r.guard.displayName,
      lat: r.lastFix!.lat,
      lng: r.lastFix!.lng,
      health: r.health,
      current: r.age === 'CURRENT',
    }));
  const shapes = useMemo<MapShape[]>(
    () => sites.map((s) => ({ id: s.id, name: s.name, boundary: s.boundary })),
    [sites],
  );
  // Active alerts next to the guard they concern (server-generated plain text).
  const alertsByShift = new Map<string, Alert[]>();
  for (const a of alerts) {
    if (a.shiftId) alertsByShift.set(a.shiftId, [...(alertsByShift.get(a.shiftId) ?? []), a]);
  }
  const counts = { LIVE: 0, DELAYED: 0, OFFLINE: 0 };
  for (const r of rows) counts[r.health]++;

  return (
    <>
      <PageHead
        title="Live map"
        description="Guards on duty now. Tracking health and location age are separate signals."
      />
      {error ? <div className="banner error">{error}</div> : null}
      <div className="grid cols-3">
        {(['LIVE', 'DELAYED', 'OFFLINE'] as const).map((h) => (
          <div className="card stat" key={h}>
            <span className="label">{h.toLowerCase()}</span>
            <span className="value">{counts[h]}</span>
          </div>
        ))}
      </div>
      <div className="grid cols-2">
        <div className="card">
          <BoundaryMap
            shapes={shapes}
            points={points}
            height={520}
            {...(points[0] ? { center: { lat: points[0].lat, lng: points[0].lng } } : {})}
          />
          <p className="faint">
            Filled dot: current position. Hollow dot: last known position only. Colour: green live, amber
            delayed, red offline.
          </p>
        </div>
        <div className="card">
          <h2>On duty {snapshot ? <span className="faint">({rows.length})</span> : null}</h2>
          {!snapshot ? (
            <div className="loading">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="empty">Nobody is on an active shift.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Guard</th>
                    <th>Tracking</th>
                    <th>Location</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.shiftId}>
                      <td>
                        {r.guard.displayName}
                        <div className="faint">{r.site.name}</div>
                        {r.manualStart ? <div className="faint">manual attendance — no tracking</div> : null}
                        {(alertsByShift.get(r.shiftId) ?? []).map((a) => (
                          <div key={a.id}>
                            <span
                              className={`badge ${a.severity === 'HIGH' || a.severity === 'CRITICAL' ? 'danger' : 'warn'}`}
                            >
                              {ALERT_TYPE_LABEL[a.type].toLowerCase()}
                            </span>
                          </div>
                        ))}
                      </td>
                      <td>
                        <span className={`badge ${HEALTH_BADGE[r.health]}`}>{r.health.toLowerCase()}</span>
                        <div className="faint">
                          {r.lastContactAt
                            ? `last update ${formatRelative(r.lastContactAt, now)}`
                            : 'no contact yet'}
                        </div>
                        {r.trackingServiceState && r.trackingServiceState !== 'RUNNING' ? (
                          <div className="faint">
                            tracking {r.trackingServiceState.toLowerCase().replaceAll('_', ' ')}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {r.age === 'UNKNOWN' ? (
                          <span className="badge plain">no location</span>
                        ) : r.age === 'CURRENT' ? (
                          <span className="badge ok">current</span>
                        ) : (
                          <span className="badge warn">last known</span>
                        )}
                        {r.lastFix ? (
                          <div className="faint">{formatRelative(r.lastFix.capturedAt, now)}</div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
