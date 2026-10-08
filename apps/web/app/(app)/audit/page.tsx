'use client';

// The organization's audit log (SEC §17), newest first. Owners only (audit.read).
import { useCallback, useEffect, useState } from 'react';

import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';
import { useSession } from '../../../lib/session';

type Entry = {
  id: string;
  createdAt: string;
  actorType: string;
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
};

export default function AuditPage() {
  const { membership } = useSession();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (after: string | null) => {
    setBusy(true);
    try {
      const page = await api<{ entries: Entry[]; nextCursor: string | null }>(
        `/audit-logs?limit=50${after ? `&cursor=${encodeURIComponent(after)}` : ''}`,
      );
      setEntries((prev) => (after && prev ? [...prev, ...page.entries] : page.entries));
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load, membership.organizationId]);

  return (
    <>
      <PageHead
        title="Audit log"
        description="Every security-sensitive action in this organization, as it happened."
      />
      {error ? <div className="banner error">{error}</div> : null}
      <div className="card">
        {entries === null ? (
          <div className="loading">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="empty">Nothing recorded yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="muted">{formatDateTime(e.createdAt, membership.organizationTimezone)}</td>
                    <td>
                      {e.actorName ?? (e.actorType === 'PLATFORM_OPERATOR' ? 'Platform operator' : 'System')}
                    </td>
                    <td className="mono">{e.action}</td>
                    <td className="muted">
                      {e.resourceType}
                      {e.resourceId ? <span className="faint mono"> {e.resourceId.slice(0, 8)}</span> : null}
                    </td>
                    <td className="mono muted">
                      {Object.keys(e.metadata).length > 0 ? JSON.stringify(e.metadata) : ''}
                      {e.reason ? ` · ${e.reason}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor ? (
          <button className="btn" disabled={busy} onClick={() => void load(cursor)}>
            {busy ? 'Loading…' : 'Load older entries'}
          </button>
        ) : null}
      </div>
    </>
  );
}
