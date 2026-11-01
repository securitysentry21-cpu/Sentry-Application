'use client';

// Home, exceptions first (PROD §14.2): who is on duty and how their phones are reporting, how many
// dashboards are watching (PROD §11.5), then the active alerts, most severe first. Every number
// opens the matching list. Live through the realtime stream; freshness ticks against server time.
// Each section appears only with its permission; the server decides.
import Link from 'next/link';

import { PageHead } from '../../../components/shell';
import { formatRelative, ROLE_LABELS } from '../../../lib/format';
import { useLive } from '../../../lib/live';
import { alertsBySeverity, guardView, homeCounts } from '../../../lib/live-model';
import { useSession } from '../../../lib/session';

const SEVERITY_BADGE = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warn', LOW: 'info' } as const;

export default function DashboardPage() {
  const { me, membership, can } = useSession();
  const { model, now, error } = useLive();
  const canLive = can('live.read');
  const canAlerts = can('alerts.read');

  const views = model ? [...model.guards.values()].map((g) => guardView(g, now, model.freshness)) : [];
  const counts = homeCounts(views);
  const alerts = model ? alertsBySeverity(model.alerts.values()) : [];
  const critical = alerts.filter((a) => a.severity === 'CRITICAL').length;
  const watching = model ? model.coverage.desktop + model.coverage.phone : 0;
  const value = (n: number) => (model ? n : '–');

  const tiles: { label: string; value: number; href: string; tone?: 'warn' | 'danger' }[] = [
    { label: 'active guards', value: counts.active, href: '/live' },
    { label: 'on site', value: counts.onSite, href: '/live?show=on-site' },
    { label: 'off site', value: counts.offSite, href: '/live?show=off-site', tone: 'danger' },
    { label: 'delayed / offline', value: counts.delayedOrOffline, href: '/live?show=not-live', tone: 'warn' },
    { label: 'tracking problems', value: counts.trackingProblems, href: '/live?show=problems', tone: 'warn' },
    {
      label: 'shifts not started',
      value: model?.shiftsNotStarted ?? 0,
      href: can('shifts.read') ? '/shifts' : '/dashboard',
      tone: 'warn',
    },
  ];

  return (
    <>
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
          <div className="grid cols-6">
            {tiles.map((t) => (
              <Link
                className={`card stat${t.tone && model && t.value > 0 ? ` tone-${t.tone}` : ''}`}
                href={t.href}
                key={t.label}
              >
                <span className="label">{t.label}</span>
                <span className="value">{value(t.value)}</span>
              </Link>
            ))}
          </div>
          <div className="card monitoring">
            <span className="label">Monitoring now</span>
            <span>
              {model
                ? `${model.coverage.desktop} dashboard${model.coverage.desktop === 1 ? '' : 's'}, ${model.coverage.phone} phone${model.coverage.phone === 1 ? '' : 's'}`
                : '–'}{' '}
              <span className="faint">(this screen included)</span>
            </span>
          </div>
        </>
      ) : null}
      {canAlerts ? (
        <div className="card">
          <div className="card-head">
            <h2>
              Active alerts <span className="faint">({model ? alerts.length : '…'})</span>
            </h2>
            <span className="faint">Most severe first, then oldest</span>
          </div>
          {!model ? (
            <div className="loading">Loading…</div>
          ) : alerts.length === 0 ? (
            <div className="empty">No active alerts.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {alerts.slice(0, 10).map((a) => (
                    <tr key={a.id}>
                      <td>
                        <span className={`badge ${SEVERITY_BADGE[a.severity]}`}>
                          {a.severity.toLowerCase()}
                        </span>
                      </td>
                      <td>{a.summary}</td>
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
          <Link className="btn" href="/alerts">
            All alerts
          </Link>
        </div>
      ) : null}
      <div className="grid cols-3">
        <div className="card">
          <span className="label">Organization</span>
          <dl className="kv">
            <dt>Time zone</dt>
            <dd>{membership.organizationTimezone}</dd>
            <dt>Your role</dt>
            <dd>{ROLE_LABELS[membership.role]}</dd>
          </dl>
        </div>
        {can('members.manage') ? (
          <div className="card">
            <span className="label">Team</span>
            <p className="muted">
              Invite supervisors, dispatchers and administrators, and manage their roles.
            </p>
            <Link className="btn" href="/members">
              Manage members
            </Link>
          </div>
        ) : null}
        {can('org.settings.read') ? (
          <div className="card">
            <span className="label">Settings</span>
            <p className="muted">Shift, geofence and alert thresholds for this organization.</p>
            <Link className="btn" href="/settings">
              Open settings
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}
