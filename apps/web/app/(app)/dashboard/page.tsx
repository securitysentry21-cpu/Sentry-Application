'use client';

// Home, exceptions first (PROD §14.2): who is on duty and how their phones are reporting, then
// the active alerts, most severe first. Each section appears only with its permission; the server
// decides. Polls every 15 seconds until the realtime stream arrives (Phase 6).
import type { Alert } from '@sentryops/contracts';
import { trackingHealth, type FreshnessSettings } from '@sentryops/domain';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import { formatRelative, ROLE_LABELS } from '../../../lib/format';
import { useSession } from '../../../lib/session';

type Snapshot = {
  serverTime: string;
  freshness: FreshnessSettings;
  guards: { shiftId: string; lastContactAt: string | null; manualStart: boolean }[];
};

const POLL_MS = 15_000;
const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
const SEVERITY_BADGE = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warn', LOW: 'info' } as const;

export default function DashboardPage() {
  const { me, membership, can } = useSession();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canLive = can('live.read');
  const canAlerts = can('alerts.read');

  const load = useCallback(async () => {
    try {
      if (canLive) {
        const s = await api<Snapshot>('/dashboard/snapshot');
        setOffsetMs(new Date(s.serverTime).getTime() - Date.now());
        setSnapshot(s);
      }
      if (canAlerts) setAlerts((await api<{ alerts: Alert[] }>('/alerts?status=active&limit=200')).alerts);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [canLive, canAlerts]);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(poll);
  }, [load, membership.organizationId]);

  // Judged by server time, never this computer's clock.
  const now = new Date(Date.now() + offsetMs);
  const health = { LIVE: 0, DELAYED: 0, OFFLINE: 0 };
  for (const g of snapshot?.guards ?? []) {
    health[trackingHealth(now, g.lastContactAt ? new Date(g.lastContactAt) : null, snapshot!.freshness)]++;
  }
  const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const a of alerts ?? []) bySeverity[a.severity]++;
  const urgent = [...(alerts ?? [])]
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.openedAt.localeCompare(b.openedAt),
    )
    .slice(0, 6);

  return (
    <>
      <PageHead
        title={membership.organizationName}
        description={`Welcome, ${me.user.name}. You are signed in as ${ROLE_LABELS[membership.role] ?? membership.role}.`}
      />
      {error ? <div className="banner error">{error}</div> : null}
      {bySeverity.CRITICAL > 0 ? (
        <div className="banner error">
          <strong>
            {bySeverity.CRITICAL} critical alert{bySeverity.CRITICAL > 1 ? 's' : ''}
          </strong>{' '}
          — <Link href="/alerts">open Alerts</Link>
        </div>
      ) : null}
      {canLive ? (
        <div className="grid cols-4">
          <Link className="card stat" href="/live">
            <span className="label">on duty</span>
            <span className="value">{snapshot ? snapshot.guards.length : '–'}</span>
          </Link>
          {(['LIVE', 'DELAYED', 'OFFLINE'] as const).map((h) => (
            <Link className="card stat" href="/live" key={h}>
              <span className="label">{h.toLowerCase()}</span>
              <span className="value">{snapshot ? health[h] : '–'}</span>
            </Link>
          ))}
        </div>
      ) : null}
      {canAlerts ? (
        <div className="card">
          <div className="card-head">
            <h2>
              Active alerts <span className="faint">({alerts ? alerts.length : '…'})</span>
            </h2>
            <span className="faint">
              {(['HIGH', 'MEDIUM', 'LOW'] as const)
                .map((s) => `${bySeverity[s]} ${s.toLowerCase()}`)
                .join(' · ')}
            </span>
          </div>
          {!alerts ? (
            <div className="loading">Loading…</div>
          ) : urgent.length === 0 ? (
            <div className="empty">No active alerts.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {urgent.map((a) => (
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
