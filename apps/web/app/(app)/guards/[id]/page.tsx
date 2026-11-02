'use client';

// Guard detail (PROD §14.4): the guard, their current shift and site, tracking health and location
// age (PROD §8.3), the phone's own report and devices, the disclosure they accepted, recent shifts,
// patrol rounds and alerts. The live part follows the realtime stream. Location history opens on its
// own, audited page; each round and shift opens on the Patrols page. Incidents join with Phase 8.
import type { Alert, Guard, LiveGuard, PatrolRun, Shift } from '@sentryops/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { GuardPanel } from '../../../../components/guard-panel';
import { RunsTable } from '../../../../components/patrol-runs';
import { PageHead } from '../../../../components/shell';
import { api, errorText } from '../../../../lib/api';
import { ALERT_TYPE_LABEL, formatDateTime, formatRelative, siteTime } from '../../../../lib/format';
import { useLive } from '../../../../lib/live';
import { guardView } from '../../../../lib/live-model';
import { useSession } from '../../../../lib/session';

type Device = {
  id: string;
  platform: string;
  manufacturer: string | null;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  status: 'ACTIVE' | 'REVOKED';
  revokedReason: string | null;
  lastSeenAt: string | null;
};

type Location = {
  serverTime: string;
  live: LiveGuard | null;
  consent: { version: string; locale: string; acceptedAt: string } | null;
};

const DAY = 86_400_000;
/** Patrol history: the latest rounds due in the last week. */
const PATROL_HISTORY = { days: 7, limit: 20 } as const;
const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'ok',
  SCHEDULED: 'info',
  COMPLETED: 'plain',
  MISSED: 'danger',
  CANCELLED: 'plain',
};

export default function GuardDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, membership } = useSession();
  const live = useLive();
  const [guard, setGuard] = useState<Guard | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [runs, setRuns] = useState<PatrolRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canHistory = can('location.history.read');
  const canPatrols = can('patrols.read');

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const guarded = <T,>(promise: Promise<T>, set: (value: T) => void) =>
      promise.then((v) => !cancelled && set(v)).catch((e: unknown) => !cancelled && setError(errorText(e)));
    void guarded(api<Guard>(`/guards/${id}`), setGuard);
    if (can('live.read')) void guarded(api<Location>(`/guards/${id}/location`), setLocation);
    if (can('devices.read'))
      void guarded(api<{ devices: Device[] }>(`/guards/${id}/devices`), (r) => setDevices(r.devices));
    if (can('shifts.read')) {
      const from = new Date(now - 14 * DAY).toISOString();
      const to = new Date(now + 2 * DAY).toISOString();
      void guarded(api<{ shifts: Shift[] }>(`/shifts?from=${from}&to=${to}&guardId=${id}`), (r) =>
        setShifts([...r.shifts].reverse()),
      );
    }
    if (can('alerts.read'))
      void guarded(api<{ alerts: Alert[] }>(`/alerts?status=all&guardId=${id}&limit=20`), (r) =>
        setAlerts(r.alerts),
      );
    if (can('patrols.read')) {
      // Rounds already due: the ones still ahead in a shift are not history yet.
      const query = new URLSearchParams({
        guardId: id,
        from: new Date(now - PATROL_HISTORY.days * DAY).toISOString(),
        to: new Date(now).toISOString(),
        limit: String(PATROL_HISTORY.limit),
      });
      void guarded(api<{ runs: PatrolRun[] }>(`/patrol-runs?${query.toString()}`), (r) => setRuns(r.runs));
    }
    return () => {
      cancelled = true;
    };
  }, [id, can, membership.organizationId]);

  // The stream's copy is the freshest; the page's own fetch covers the moment before it arrives.
  const current = useMemo(() => {
    const streamed = live.model ? [...live.model.guards.values()].find((g) => g.guard.id === id) : undefined;
    const base = streamed ?? location?.live ?? null;
    return base && live.model ? guardView(base, live.now, live.model.freshness) : null;
  }, [live.model, live.now, location, id]);

  if (error && !guard) return <div className="banner error">{error}</div>;
  if (!guard) return <div className="loading">Loading…</div>;

  return (
    <>
      <PageHead
        title={guard.displayName}
        description={`Employee ${guard.employeeNumber} · ${guard.status.toLowerCase()}${guard.enrolled ? ' · phone enrolled' : ' · no phone enrolled'}`}
        actions={
          canHistory ? (
            <Link className="btn" href={`/guards/${guard.id}/history`}>
              Location history
            </Link>
          ) : null
        }
      />
      {error ? <div className="banner error">{error}</div> : null}
      <div className="grid cols-2">
        <div className="card">
          {current ? (
            <GuardPanel guard={current} now={live.now} />
          ) : (
            <>
              <h2>Now</h2>
              <p className="muted">Off duty: no active shift.</p>
            </>
          )}
        </div>
        <div className="card">
          <h2>Tracking disclosure</h2>
          {location?.consent ? (
            <p>
              Accepted version {location.consent.version} (
              {location.consent.locale === 'ur' ? 'Urdu' : 'English'}) on{' '}
              {formatDateTime(location.consent.acceptedAt, membership.organizationTimezone)}.
            </p>
          ) : (
            <p className="muted">
              Not accepted yet. Tracking can't start until the guard accepts it in the app.
            </p>
          )}
          {devices ? (
            <>
              <h2>Phones</h2>
              {devices.length === 0 ? (
                <p className="muted">No phone enrolled.</p>
              ) : (
                <ul className="plain-list">
                  {devices.map((d) => (
                    <li key={d.id}>
                      <span className={`badge ${d.status === 'ACTIVE' ? 'ok' : 'plain'}`}>
                        {d.status === 'ACTIVE'
                          ? 'active'
                          : `revoked${d.revokedReason ? ` (${d.revokedReason.toLowerCase()})` : ''}`}
                      </span>{' '}
                      {[d.manufacturer, d.model].filter(Boolean).join(' ') || d.platform}
                      {d.osVersion ? ` · ${d.platform === 'IOS' ? 'iOS' : 'Android'} ${d.osVersion}` : ''}
                      {d.appVersion ? ` · App ${d.appVersion}` : ''}
                      {d.lastSeenAt ? (
                        <span className="faint"> · seen {formatRelative(d.lastSeenAt, live.now)}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </div>
      </div>
      {shifts ? (
        <div className="card">
          <h2>Shifts, last two weeks</h2>
          {shifts.length === 0 ? (
            <div className="empty">No shifts in this period.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Scheduled</th>
                    <th>Status</th>
                    {canHistory || canPatrols ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {shifts.map((s) => (
                    <tr key={s.id}>
                      <td>{s.site.name}</td>
                      <td>
                        {formatDateTime(s.startsAt, s.site.timezone)} – {siteTime(s.endsAt, s.site.timezone)}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[s.status] ?? 'plain'}`}>
                          {s.status.toLowerCase()}
                        </span>
                      </td>
                      {canHistory || canPatrols ? (
                        <td>
                          {s.actualStartedAt ? (
                            <div className="row">
                              {canHistory ? (
                                <Link
                                  className="btn small"
                                  href={`/guards/${guard.id}/history?shift=${s.id}`}
                                >
                                  History
                                </Link>
                              ) : null}
                              {canPatrols ? (
                                <Link className="btn small" href={`/patrols?shiftId=${s.id}`}>
                                  Patrols
                                </Link>
                              ) : null}
                            </div>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
      {runs ? (
        <div className="card">
          <div className="card-head">
            <h2>Patrol history</h2>
            <Link className="btn small" href={`/patrols?guardId=${guard.id}`}>
              All patrols
            </Link>
          </div>
          <p className="faint">
            Rounds due in the last {PATROL_HISTORY.days} days, latest first (up to {PATROL_HISTORY.limit}).
          </p>
          {runs.length === 0 ? (
            <div className="empty">No rounds in this period.</div>
          ) : (
            <RunsTable
              runs={runs}
              showGuard={false}
              withDate
              href={(r) => `/patrols?shiftId=${r.shiftId}&run=${r.id}`}
            />
          )}
        </div>
      ) : null}
      {alerts ? (
        <div className="card">
          <h2>Recent alerts</h2>
          {alerts.length === 0 ? (
            <div className="empty">No alerts.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {alerts.map((a) => (
                    <tr key={a.id}>
                      <td>{ALERT_TYPE_LABEL[a.type]}</td>
                      <td className="faint">{a.site?.name ?? ''}</td>
                      <td className="faint">{formatDateTime(a.openedAt, membership.organizationTimezone)}</td>
                      <td>
                        <span className="badge plain">{a.status.toLowerCase()}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
