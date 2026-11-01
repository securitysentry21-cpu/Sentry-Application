'use client';

// The Live map (PROD §14.3, D-36). Guards on duty, updated by the realtime stream, with tracking
// health (when the server last heard from the phone) and location age (when the newest fix was
// taken) as separate signals, both recomputed every second against server time, so a guard turns
// DELAYED and OFFLINE on time even when nothing new arrives (ADV-U01). A last-known position is
// never styled as live (INV-09). Markers cluster at about 1,000 guards; details open in a
// plain-text panel, never a map popup (ADV-W01). Phone-width friendly (D-04).
import type { Alert, Site } from '@sentryops/contracts';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { GuardPanel, locationLine, trackingLine } from '../../../components/guard-panel';
import { BoundaryMap, type MapPoint, type MapShape } from '../../../components/map';
import { PageHead } from '../../../components/shell';
import { api } from '../../../lib/api';
import { ALERT_TYPE_LABEL, shortAge } from '../../../lib/format';
import { useLive } from '../../../lib/live';
import { guardView, homeCounts, type GuardView } from '../../../lib/live-model';
import { useSession } from '../../../lib/session';

const HEALTH_BADGE = { LIVE: 'ok', DELAYED: 'warn', OFFLINE: 'danger' } as const;

/** What the list and map show. The home page's numbers link here with one of these (?show=…). */
const LIVE_FILTERS = {
  all: { label: 'Everyone on duty', test: () => true },
  'not-live': { label: 'Delayed or offline', test: (g: GuardView) => g.health !== 'LIVE' },
  live: { label: 'Live', test: (g: GuardView) => g.health === 'LIVE' },
  delayed: { label: 'Delayed', test: (g: GuardView) => g.health === 'DELAYED' },
  offline: { label: 'Offline', test: (g: GuardView) => g.health === 'OFFLINE' },
  'last-known': { label: 'Last known location only', test: (g: GuardView) => g.age === 'LAST_KNOWN' },
  'no-location': { label: 'No location yet', test: (g: GuardView) => g.age === 'UNKNOWN' },
  'on-site': { label: 'On site', test: (g: GuardView) => g.onSite === 'ON_SITE' },
  'off-site': { label: 'Off site', test: (g: GuardView) => g.onSite === 'OFF_SITE' },
  problems: { label: 'Tracking problems', test: (g: GuardView) => g.trackingProblem },
} as const;
type FilterKey = keyof typeof LIVE_FILTERS | 'alerts';

export default function LivePage() {
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      <LiveMap />
    </Suspense>
  );
}

function LiveMap() {
  const { can, membership } = useSession();
  const live = useLive();
  const search = useSearchParams();
  const initial = search.get('show');
  const [show, setShow] = useState<FilterKey>(
    initial && (initial === 'alerts' || initial in LIVE_FILTERS) ? (initial as FilterKey) : 'all',
  );
  const [siteFilter, setSiteFilter] = useState<string>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);

  useEffect(() => {
    if (!can('sites.read')) return;
    void api<{ sites: Site[] }>('/sites')
      .then((r) => setSites(r.sites))
      .catch(() => undefined);
  }, [can, membership.organizationId]);

  const { model, now } = live;
  const views = useMemo(
    () => (model ? [...model.guards.values()].map((g) => guardView(g, now, model.freshness)) : []),
    [model, now],
  );
  const alertsByShift = useMemo(() => {
    const map = new Map<string, Alert[]>();
    for (const a of model?.alerts.values() ?? []) {
      if (a.shiftId) map.set(a.shiftId, [...(map.get(a.shiftId) ?? []), a]);
    }
    return map;
  }, [model]);

  const rows = views
    .filter((v) => siteFilter === 'all' || v.site.id === siteFilter)
    .filter((v) => (show === 'alerts' ? alertsByShift.has(v.shiftId) : LIVE_FILTERS[show].test(v)))
    .sort((a, b) => a.guard.displayName.localeCompare(b.guard.displayName));
  const counts = homeCounts(views);
  const current = selected ? views.find((v) => v.shiftId === selected) : undefined;

  const points: MapPoint[] = rows
    .filter((r) => r.lastFix)
    .map((r) => ({
      id: r.shiftId,
      label: `${r.guard.displayName} · ${shortAge(r.lastFix!.capturedAt, now)}`,
      lat: r.lastFix!.lat,
      lng: r.lastFix!.lng,
      health: r.health,
      current: r.age === 'CURRENT',
      accuracyM: r.lastFix!.accuracyM,
      selected: r.shiftId === selected,
    }));
  const shapes = useMemo<MapShape[]>(
    () =>
      sites
        .filter((s) => siteFilter === 'all' || s.id === siteFilter)
        .map((s) => ({ id: s.id, name: s.name, boundary: s.boundary })),
    [sites, siteFilter],
  );
  const siteOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const s of sites) byId.set(s.id, s.name);
    for (const v of views) byId.set(v.site.id, v.site.name);
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [sites, views]);
  const first = points[0];

  return (
    <>
      <PageHead
        title="Live map"
        description="Guards on duty now. Tracking health and location age are separate signals."
      />
      {live.error ? <div className="banner error">{live.error}</div> : null}
      <div className="grid cols-4">
        {(
          [
            ['live', 'live', views.filter((v) => v.health === 'LIVE').length],
            ['delayed', 'delayed', views.filter((v) => v.health === 'DELAYED').length],
            ['offline', 'offline', views.filter((v) => v.health === 'OFFLINE').length],
            ['problems', 'tracking problems', counts.trackingProblems],
          ] as const
        ).map(([key, label, value]) => (
          <button
            className="card stat"
            key={key}
            onClick={() => setShow(show === key ? 'all' : key)}
            aria-pressed={show === key}
          >
            <span className="label">{label}</span>
            <span className="value">{model ? value : '–'}</span>
          </button>
        ))}
      </div>
      <div className="row filters">
        <label className="field">
          <span>Show</span>
          <select value={show} onChange={(e) => setShow(e.target.value as FilterKey)}>
            {Object.entries(LIVE_FILTERS).map(([key, f]) => (
              <option key={key} value={key}>
                {f.label}
              </option>
            ))}
            <option value="alerts">With active alerts</option>
          </select>
        </label>
        <label className="field">
          <span>Site</span>
          <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="all">All sites</option>
            {siteOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span className="faint">{model ? `${rows.length} of ${views.length} on duty` : 'Loading…'}</span>
      </div>
      <div className="live-layout">
        <div className="card">
          <BoundaryMap
            shapes={shapes}
            points={points}
            onSelect={setSelected}
            height="min(560px, 60vh)"
            {...(first ? { center: { lat: first.lat, lng: first.lng } } : {})}
          />
          <p className="faint">
            Filled dot: current position. Hollow dot: last known position only. Colour and word: live,
            delayed, offline. Each label shows how old the position is.
          </p>
        </div>
        <div className="live-side">
          {current ? <GuardPanel guard={current} now={now} onClose={() => setSelected(null)} /> : null}
          <div className="card">
            <h2>On duty {model ? <span className="faint">({rows.length})</span> : null}</h2>
            {!model ? (
              <div className="loading">Loading…</div>
            ) : rows.length === 0 ? (
              <div className="empty">
                {views.length === 0 ? 'Nobody is on an active shift.' : 'Nobody matches.'}
              </div>
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
                      <tr
                        key={r.shiftId}
                        className={r.shiftId === selected ? 'selected' : undefined}
                        onClick={() => setSelected(r.shiftId)}
                      >
                        <td>
                          <button className="link" onClick={() => setSelected(r.shiftId)}>
                            {r.guard.displayName}
                          </button>
                          <div className="faint">{r.site.name}</div>
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
                          <div className="faint">{trackingLine(r, now)}</div>
                        </td>
                        <td>
                          {r.age === 'UNKNOWN' ? (
                            <span className="badge plain">no location</span>
                          ) : r.age === 'CURRENT' ? (
                            <span className="badge ok">current</span>
                          ) : (
                            <span className="badge warn">last known</span>
                          )}
                          <div className="faint">{locationLine(r, now)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
