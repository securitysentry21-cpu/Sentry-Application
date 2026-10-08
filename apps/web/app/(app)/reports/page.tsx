'use client';

// Reports (PROD §15). Attendance per shift (PROD §6.8) for inclusive local dates: the site's time
// zone for one site, the organization's otherwise. The CSV comes from the server, which checks the
// export permission and records the export in the audit log.
import type { AttendanceRow, Site } from '@sentryops/contracts';
import { addDays, localDate } from '@sentryops/domain';
import { useCallback, useEffect, useState } from 'react';

import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';
import { useSession } from '../../../lib/session';

type Report = { timezone: string; from: string; to: string; rows: AttendanceRow[]; truncated: boolean };

const FLAG_LABEL: Record<string, string> = {
  OFFLINE_START: 'offline start',
  MANUAL_START: 'manual start',
  AUTO_ENDED: 'auto-ended',
  FORCE_ENDED: 'force-ended',
  OFF_SITE_START: 'off-site start',
  LOW_ACCURACY_START: 'low-accuracy start',
};

const minutes = (m: number | null) =>
  m === null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;

export default function ReportsPage() {
  const { can, membership, me } = useSession();
  const timezone =
    me.memberships.find((m) => m.organizationId === membership.organizationId)?.organizationTimezone ??
    'Asia/Karachi';
  const today = localDate(new Date(), timezone);
  const [from, setFrom] = useState(() => addDays(today, -6));
  const [to, setTo] = useState(today);
  const [siteId, setSiteId] = useState('');
  const [sites, setSites] = useState<Site[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const query = `from=${from}&to=${to}${siteId ? `&siteId=${siteId}` : ''}`;

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await api<Report>(`/reports/attendance?${query}`));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load, membership.organizationId]);

  useEffect(() => {
    if (!can('sites.read')) return;
    void api<{ sites: Site[] }>('/sites')
      .then((r) => setSites(r.sites))
      .catch(() => undefined);
  }, [can, membership.organizationId]);

  async function download() {
    try {
      const res = await fetch(`/api/v1/reports/attendance/export?${query}`, {
        headers: { 'x-sentry-csrf': '1', 'x-organization-id': membership.organizationId },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('The export failed. Try a shorter range.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `attendance-${from}-to-${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export failed.');
    }
  }

  const rows = report?.rows ?? [];
  const late = rows.filter((r) => (r.lateMinutes ?? 0) > 0).length;
  const missed = rows.filter((r) => r.status === 'MISSED').length;
  const tz = report?.timezone ?? timezone;

  return (
    <>
      <PageHead
        title="Attendance"
        description="Scheduled against actual, per shift. Dates are local to the site."
      />
      {error ? <div className="banner error">{error}</div> : null}
      <div className="card">
        <form
          style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <label>
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label>
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
          </label>
          <label>
            Site
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn primary" disabled={busy}>
            Show
          </button>
          {can('exports.create') ? (
            <button
              type="button"
              className="btn"
              onClick={() => void download()}
              disabled={busy || rows.length === 0}
            >
              Download CSV
            </button>
          ) : null}
        </form>
      </div>
      <div className="grid cols-3">
        <div className="card stat">
          <span className="label">shifts</span>
          <span className="value">{rows.length}</span>
        </div>
        <div className="card stat">
          <span className="label">started late</span>
          <span className="value">{late}</span>
        </div>
        <div className="card stat">
          <span className="label">missed</span>
          <span className="value">{missed}</span>
        </div>
      </div>
      <div className="card">
        {report?.truncated ? (
          <div className="banner warn">More shifts than one report shows. Narrow the range.</div>
        ) : null}
        {!report ? (
          <div className="loading">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">No shifts in this period.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Guard</th>
                  <th>Site</th>
                  <th>Scheduled</th>
                  <th>Actual</th>
                  <th>Status</th>
                  <th>Late</th>
                  <th>Early leave</th>
                  <th>Worked</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.shiftId}>
                    <td>
                      {r.guard.displayName}
                      <div className="faint">{r.guard.employeeNumber}</div>
                    </td>
                    <td>{r.site.name}</td>
                    <td>
                      {formatDateTime(r.scheduledStart, tz)}
                      <div className="faint">to {formatDateTime(r.scheduledEnd, tz)}</div>
                    </td>
                    <td>
                      {r.actualStart ? formatDateTime(r.actualStart, tz) : '—'}
                      <div className="faint">
                        {r.actualEnd ? `to ${formatDateTime(r.actualEnd, tz)}` : ''}
                      </div>
                      {r.flags.length > 0 ? (
                        <div className="faint">{r.flags.map((f) => FLAG_LABEL[f] ?? f).join(' · ')}</div>
                      ) : null}
                    </td>
                    <td>{r.status.toLowerCase()}</td>
                    <td>{minutes(r.lateMinutes)}</td>
                    <td>{minutes(r.earlyLeaveMinutes)}</td>
                    <td>{minutes(r.workedMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
