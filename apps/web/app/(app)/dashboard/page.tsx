'use client';

// Home, exceptions first (PROD §14.2): an SOS banner at the top until someone acknowledges it, who
// is on duty and how their phones are reporting, open incidents, how many dashboards are watching
// (PROD §11.5), then the active alerts, most severe first. Every number opens the matching list.
// Live through the realtime stream; freshness ticks against server time. A drill is marked DRILL and
// alarms only its participants (ADV-S10). Each section appears only with its permission; the server
// decides. The meters only draw numbers that are printed beside them.
import type { Alert } from '@sentryops/contracts';
import Link from 'next/link';
import { useState } from 'react';

import { useAlarms } from '../../../components/alarm';
import { Icon } from '../../../components/icons';
import { TickMeter, type MeterTone } from '../../../components/meter';
import { PageHead } from '../../../components/shell';
import { alarmPath } from '../../../lib/alarm';
import { errorText } from '../../../lib/api';
import { formatRelative, ROLE_LABELS } from '../../../lib/format';
import { useLive } from '../../../lib/live';
import { alertsBySeverity, guardView, homeCounts } from '../../../lib/live-model';
import { useSession } from '../../../lib/session';

const SEVERITY_BADGE = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warn', LOW: 'info' } as const;
/** How many alerts the home page lists; the Alerts page has them all. */
const ALERTS_SHOWN = 10;

/** PROD §14.2: "SOS — Ahmed Khan — ABC Warehouse — 40 s ago [ACKNOWLEDGE]", until acknowledged. */
function SosBanners({ now }: { now: Date }) {
  const { alarms, acknowledge } = useAlarms();
  const { can } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sos = alarms.filter((a) => a.type === 'SOS_ACTIVATED');
  if (sos.length === 0) return null;
  const onAcknowledge = (alert: Alert) => {
    setBusy(alert.id);
    setError(null);
    void acknowledge(alert)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(null));
  };
  return (
    <>
      {sos.map((a) => (
        <div className="banner error sos-banner" role="alert" key={a.id}>
          <span>
            {a.isDrill ? <span className="badge drill">DRILL</span> : null} <strong>SOS</strong> —{' '}
            {a.guard?.displayName ?? 'Guard'} — {a.site?.name ?? 'off shift'} —{' '}
            {formatRelative(a.openedAt, now)}
            {a.triggerCount > 1 ? ` · pressed again ×${a.triggerCount - 1}` : ''}
          </span>
          <span className="row">
            {can('alerts.acknowledge') ? (
              <button
                type="button"
                className="btn primary small"
                disabled={busy === a.id}
                onClick={() => onAcknowledge(a)}
              >
                {busy === a.id ? 'Acknowledging…' : 'Acknowledge'}
              </button>
            ) : null}
            <Link className="btn small" href={alarmPath(a)}>
              Open SOS
            </Link>
          </span>
        </div>
      ))}
      {error ? <div className="banner error">{error}</div> : null}
    </>
  );
}

/** "Open the full page" in a card's corner. */
function CornerLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className="corner-link" href={href} aria-label={label} title={label}>
      <Icon name="open" size={16} />
    </Link>
  );
}

export default function DashboardPage() {
  const { me, membership, can } = useSession();
  const { model, now, error } = useLive();
  const canLive = can('live.read');
  const canAlerts = can('alerts.read');

  const views = model ? [...model.guards.values()].map((g) => guardView(g, now, model.freshness)) : [];
  const counts = homeCounts(views);
  const health = {
    live: views.filter((v) => v.health === 'LIVE').length,
    delayed: views.filter((v) => v.health === 'DELAYED').length,
    offline: views.filter((v) => v.health === 'OFFLINE').length,
  };
  const alerts = model ? alertsBySeverity(model.alerts.values()) : [];
  // An SOS has its own banner above; this one counts the other critical alerts.
  const critical = alerts.filter((a) => a.severity === 'CRITICAL' && a.type !== 'SOS_ACTIVATED').length;
  const watching = model ? model.coverage.desktop + model.coverage.phone : 0;
  const value = (n: number) => (model ? n : '–');

  // Shares of the guards on duty. An exception (above zero) glows in its colour; its name says what it is.
  const shares: {
    label: string;
    value: number;
    href: string;
    tone: MeterTone;
    exception?: 'warn' | 'danger';
  }[] = [
    { label: 'On site', value: counts.onSite, href: '/live?show=on-site', tone: 'live' },
    {
      label: 'Off site',
      value: counts.offSite,
      href: '/live?show=off-site',
      tone: 'offline',
      exception: 'danger',
    },
    {
      label: 'Delayed or offline',
      value: counts.delayedOrOffline,
      href: '/live?show=not-live',
      tone: 'delayed',
      exception: 'warn',
    },
    {
      label: 'Tracking problems',
      value: counts.trackingProblems,
      href: '/live?show=problems',
      tone: 'delayed',
      exception: 'warn',
    },
  ];
  const tiles: { label: string; value: number; href: string }[] = [
    {
      label: 'Shifts not started',
      value: model?.shiftsNotStarted ?? 0,
      href: can('shifts.read') ? '/shifts' : '/dashboard',
    },
    ...(can('incidents.read')
      ? [{ label: 'Open incidents', value: model?.openIncidents ?? 0, href: '/incidents' }]
      : []),
  ];

  return (
    <>
      <SosBanners now={now} />
      <PageHead
        title={membership.organizationName}
        description={`Welcome, ${me.user.name}. You are signed in as ${ROLE_LABELS[membership.role] ?? membership.role}.`}
      />
      {error ? <div className="banner error">{error}</div> : null}
      {critical > 0 ? (
        <div className="banner error" role="alert">
          <strong>
            {critical} critical alert{critical > 1 ? 's' : ''}
          </strong>{' '}
          — <Link href="/alerts">open Alerts</Link>
        </div>
      ) : null}
      {canLive && model && counts.active > 0 && watching === 0 ? (
        <div className="banner warn" role="status">
          <strong>Nobody is watching live.</strong> Guards are on duty, but no dashboard is connected right
          now.
        </div>
      ) : null}
      {canLive ? (
        <>
          <section className="card kpi-panel" aria-labelledby="on-duty">
            <div className="card-head">
              <h2 id="on-duty">Guards on duty</h2>
              <CornerLink href="/live" label="Open the live map" />
            </div>
            <div className="kpi-grid">
              <Link className="kpi hero" href="/live">
                <span className="kpi-label">Active guards</span>
                <span className="kpi-value">{value(counts.active)}</span>
                <TickMeter
                  parts={[
                    { count: health.live, tone: 'live' },
                    { count: health.delayed, tone: 'delayed' },
                    { count: health.offline, tone: 'offline' },
                  ]}
                  total={counts.active}
                  ticks={36}
                />
                <span className="legend">
                  <span>
                    <i className="swatch live" />
                    {value(health.live)} live
                  </span>
                  <span>
                    <i className="swatch delayed" />
                    {value(health.delayed)} delayed
                  </span>
                  <span>
                    <i className="swatch offline" />
                    {value(health.offline)} offline
                  </span>
                </span>
              </Link>
              {shares.map((s) => (
                <Link
                  className={`kpi${s.exception && model && s.value > 0 ? ` tone-${s.exception}` : ''}`}
                  href={s.href}
                  key={s.label}
                >
                  <span className="kpi-label">{s.label}</span>
                  <span className="kpi-value">
                    {value(s.value)}
                    {model && counts.active > 0 ? <small>of {counts.active}</small> : null}
                  </span>
                  <TickMeter parts={[{ count: s.value, tone: s.tone }]} total={counts.active} tone={s.tone} />
                </Link>
              ))}
            </div>
          </section>
          <div className="grid cols-3">
            {tiles.map((t) => (
              <Link
                className={`card stat${model && t.value > 0 ? ' tone-warn' : ''}`}
                href={t.href}
                key={t.label}
              >
                <span className="label">{t.label}</span>
                <span className="value">{value(t.value)}</span>
              </Link>
            ))}
            <div className="card stat">
              <span className="label">Monitoring now</span>
              <span className="value">{model ? watching : '–'}</span>
              <span className="faint">
                {model
                  ? `${model.coverage.desktop} dashboard${model.coverage.desktop === 1 ? '' : 's'}, ${model.coverage.phone} phone${model.coverage.phone === 1 ? '' : 's'}, this screen included`
                  : 'Counting…'}
              </span>
            </div>
          </div>
        </>
      ) : null}
      {canAlerts ? (
        <section className="card" aria-labelledby="active-alerts">
          <div className="card-head">
            <h2 id="active-alerts">
              Active alerts <span className="faint">({model ? alerts.length : '…'})</span>
            </h2>
            <div className="row">
              <span className="faint">Most severe first, then oldest</span>
              <CornerLink href="/alerts" label="All alerts" />
            </div>
          </div>
          {!model ? (
            <div className="loading">Loading…</div>
          ) : alerts.length === 0 ? (
            <div className="empty">No active alerts.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {alerts.slice(0, ALERTS_SHOWN).map((a) => (
                    <tr key={a.id}>
                      <td>
                        <span className={`badge ${SEVERITY_BADGE[a.severity]}`}>
                          {a.severity.toLowerCase()}
                        </span>{' '}
                        {a.isDrill ? <span className="badge drill">DRILL</span> : null}
                      </td>
                      <td>
                        {a.sosEventId || a.incidentId ? (
                          <Link href={alarmPath(a)}>{a.summary}</Link>
                        ) : (
                          a.summary
                        )}
                      </td>
                      <td className="faint" title={a.openedAt}>
                        {formatRelative(a.openedAt, now)}
                      </td>
                      <td className="faint">
                        {a.status === 'ACKNOWLEDGED'
                          ? `acknowledged by ${a.acknowledgedBy?.name ?? ''}`
                          : 'open'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {alerts.length > ALERTS_SHOWN ? (
            <Link className="more-link" href="/alerts">
              See all {alerts.length} active alerts
            </Link>
          ) : null}
        </section>
      ) : null}
      <div className="grid cols-3">
        <div className="card">
          <h2>Organization</h2>
          <dl className="kv">
            <dt>Time zone</dt>
            <dd>{membership.organizationTimezone}</dd>
            <dt>Your role</dt>
            <dd>{ROLE_LABELS[membership.role]}</dd>
          </dl>
        </div>
        {can('members.manage') ? (
          <div className="card">
            <div className="card-head">
              <h2>Team</h2>
              <CornerLink href="/members" label="Manage members" />
            </div>
            <p className="muted">
              Invite supervisors, dispatchers and administrators, and manage their roles.
            </p>
          </div>
        ) : null}
        {can('org.settings.read') ? (
          <div className="card">
            <div className="card-head">
              <h2>Settings</h2>
              <CornerLink href="/settings" label="Open settings" />
            </div>
            <p className="muted">Shift, geofence and alert thresholds for this organization.</p>
          </div>
        ) : null}
      </div>
    </>
  );
}
