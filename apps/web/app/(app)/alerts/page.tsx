'use client';

// Alerts (PROD §12, §14.2): severity first, then age. Dispatchers acknowledge; supervisors and above
// resolve or dismiss (a reason is required, and SOS and critical incidents can only be resolved).
// The server decides every permission; buttons are only hidden when they would be refused. Polls
// every 10 seconds until the realtime stream arrives (Phase 6). Phone-width friendly for duty officers.
import type { Alert } from '@sentryops/contracts';
import { useCallback, useEffect, useState } from 'react';

import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import { ALERT_TYPE_LABEL as TYPE_LABEL, formatRelative } from '../../../lib/format';
import { useSession } from '../../../lib/session';

const POLL_MS = 10_000;
const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
const SEVERITY_BADGE = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warn', LOW: 'info' } as const;
const STATUS_BADGE = { OPEN: 'danger', ACKNOWLEDGED: 'warn', RESOLVED: 'ok', DISMISSED: 'plain' } as const;
const RESOLUTION_LABEL = {
  MANUAL: 'resolved by a person',
  CONDITION_CLEARED: 'condition cleared',
  SHIFT_ENDED: 'shift ended',
  SUPERSEDED: 'superseded',
} as const;

type Acting = { id: string; kind: 'resolve' | 'dismiss' } | null;

function minutesOutside(a: Alert, now: Date): string | null {
  if (a.type !== 'GUARD_LEFT_SITE') return null;
  const seconds =
    typeof a.details.outsideSeconds === 'number'
      ? a.details.outsideSeconds
      : typeof a.details.outsideSince === 'string' && a.status !== 'RESOLVED'
        ? (now.getTime() - new Date(a.details.outsideSince).getTime()) / 1000
        : null;
  return seconds === null ? null : `${Math.max(1, Math.round(seconds / 60))} min outside`;
}

export default function AlertsPage() {
  const { can, membership } = useSession();
  const [view, setView] = useState<'active' | 'closed'>('active');
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<Acting>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await api<{ alerts: Alert[] }>(`/alerts?status=${view}&limit=200`);
      setAlerts(r.alerts);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [view]);

  useEffect(() => {
    setAlerts(null);
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    const clock = window.setInterval(() => setTick(Date.now()), 15_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [load, membership.organizationId]);

  async function act(
    alert: Alert,
    kind: 'acknowledge' | 'resolve' | 'dismiss',
    body: Record<string, string> = {},
  ) {
    setBusy(alert.id);
    try {
      await api(`/alerts/${alert.id}/${kind}`, { method: 'POST', body });
      setActing(null);
      setText('');
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const now = new Date(tick);
  const sorted = [...(alerts ?? [])].sort((a, b) =>
    view === 'active'
      ? SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.openedAt.localeCompare(b.openedAt)
      : b.openedAt.localeCompare(a.openedAt),
  );
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  if (view === 'active') for (const a of alerts ?? []) counts[a.severity]++;

  return (
    <>
      <PageHead title="Alerts" description="Exceptions that need someone: most severe first, then oldest." />
      {error ? <div className="banner error">{error}</div> : null}
      <div className="grid cols-4">
        {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((s) => (
          <div className="card stat" key={s}>
            <span className="label">{s.toLowerCase()}</span>
            <span className="value">{view === 'active' ? counts[s] : '–'}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            className={`btn small${view === 'active' ? ' primary' : ''}`}
            onClick={() => setView('active')}
          >
            Active
          </button>
          <button
            type="button"
            className={`btn small${view === 'closed' ? ' primary' : ''}`}
            onClick={() => setView('closed')}
          >
            Closed
          </button>
        </div>
        {!alerts ? (
          <div className="loading">Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="empty">{view === 'active' ? 'No active alerts.' : 'No closed alerts yet.'}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Alert</th>
                  <th>Guard · site</th>
                  <th>Opened</th>
                  <th>Status</th>
                  {view === 'active' ? <th aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {sorted.map((a) => {
                  const outside = minutesOutside(a, now);
                  return (
                    <tr key={a.id}>
                      <td>
                        <span className={`badge ${SEVERITY_BADGE[a.severity]}`}>
                          {a.severity.toLowerCase()}
                        </span>{' '}
                        <strong>{TYPE_LABEL[a.type]}</strong>
                        {a.triggerCount > 1 ? <span className="faint"> ×{a.triggerCount}</span> : null}
                        {outside ? <div className="faint">{outside}</div> : null}
                        {a.detectedLate ? <div className="faint">detected after sync</div> : null}
                      </td>
                      <td>
                        {a.guard?.displayName ?? '—'}
                        <div className="faint">{a.site?.name ?? ''}</div>
                      </td>
                      <td title={a.openedAt}>{formatRelative(a.openedAt, now)}</td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[a.status]}`}>{a.status.toLowerCase()}</span>
                        {a.acknowledgedBy ? <div className="faint">by {a.acknowledgedBy.name}</div> : null}
                        {a.resolutionType ? (
                          <div className="faint">{RESOLUTION_LABEL[a.resolutionType]}</div>
                        ) : null}
                        {a.resolutionNote ? <div className="faint">“{a.resolutionNote}”</div> : null}
                        {a.dismissReason ? <div className="faint">dismissed: “{a.dismissReason}”</div> : null}
                      </td>
                      {view === 'active' ? (
                        <td>
                          {acting?.id === a.id ? (
                            <form
                              style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
                              onSubmit={(e) => {
                                e.preventDefault();
                                if (acting.kind === 'dismiss')
                                  void act(a, 'dismiss', { reason: text.trim() });
                                else void act(a, 'resolve', text.trim() ? { note: text.trim() } : {});
                              }}
                            >
                              <input
                                aria-label={acting.kind === 'dismiss' ? 'Reason' : 'Note'}
                                placeholder={
                                  acting.kind === 'dismiss' ? 'Reason (required)' : 'Note (optional)'
                                }
                                value={text}
                                maxLength={1000}
                                onChange={(e) => setText(e.target.value)}
                                required={acting.kind === 'dismiss'}
                              />
                              <button type="submit" className="btn small primary" disabled={busy === a.id}>
                                {acting.kind === 'dismiss' ? 'Dismiss' : 'Resolve'}
                              </button>
                              <button
                                type="button"
                                className="btn small ghost"
                                onClick={() => setActing(null)}
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {a.status === 'OPEN' && can('alerts.acknowledge') ? (
                                <button
                                  type="button"
                                  className="btn small primary"
                                  disabled={busy === a.id}
                                  onClick={() => void act(a, 'acknowledge')}
                                >
                                  Acknowledge
                                </button>
                              ) : null}
                              {can('alerts.resolve') ? (
                                <button
                                  type="button"
                                  className="btn small"
                                  onClick={() => {
                                    setActing({ id: a.id, kind: 'resolve' });
                                    setText('');
                                  }}
                                >
                                  Resolve
                                </button>
                              ) : null}
                              {can('alerts.resolve') && a.dismissible ? (
                                <button
                                  type="button"
                                  className="btn small ghost"
                                  onClick={() => {
                                    setActing({ id: a.id, kind: 'dismiss' });
                                    setText('');
                                  }}
                                >
                                  Dismiss
                                </button>
                              ) : null}
                            </div>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
