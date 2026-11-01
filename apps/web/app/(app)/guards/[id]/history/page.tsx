'use client';

// Location history (PROD §14.5, SEC §16.4). Nothing loads until the user asks: every view is
// recorded in the audit log, with the reason given, before any point is returned (INV-14). The
// reason field is always here; the organization may make it mandatory (D-21). The server thins the
// track to at most 2,000 points; gaps longer than 5 minutes are drawn as breaks, never as lines
// that imply travel. A slider plays the shift back.
import type { LocationHistory, Shift } from '@sentryops/contracts';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';

import { BoundaryMap, type MapShape, type MapTrack } from '../../../../../components/map';
import { PageHead } from '../../../../../components/shell';
import { api, ApiError, errorText } from '../../../../../lib/api';
import { formatDateTime, siteTime } from '../../../../../lib/format';
import { useSession } from '../../../../../lib/session';

const DAY = 86_400_000;
/** HISTORY_MAX_RANGE_H in packages/contracts; the server enforces it, this only says so early. */
const HISTORY_MAX_RANGE_H = 24;
const EVENT_LABEL: Record<string, string> = {
  STARTED: 'Shift started',
  ENDED: 'Shift ended',
  AUTO_ENDED: 'Shift ended automatically',
  FORCE_ENDED: 'Shift ended by a supervisor',
  LEFT_SITE: 'Left the site',
  ENTERED_SITE: 'Back on site',
  TRACKING_DEGRADED: 'Tracking degraded',
  TRACKING_RESTORED: 'Tracking restored',
};

export default function HistoryPage() {
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      <History />
    </Suspense>
  );
}

/** A datetime-local value (this computer's time) as an ISO instant. */
const toInstant = (local: string) => new Date(local).toISOString();
const localValue = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function History() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const { can, membership } = useSession();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [mode, setMode] = useState<'shift' | 'range'>('shift');
  const [shiftId, setShiftId] = useState(search.get('shift') ?? '');
  const [from, setFrom] = useState(() => localValue(Date.now() - 8 * 3_600_000));
  const [to, setTo] = useState(() => localValue(Date.now()));
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<LocationHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonRequired, setReasonRequired] = useState(false);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (!can('shifts.read')) {
      setMode('range');
      return;
    }
    const now = Date.now();
    void api<{ shifts: Shift[] }>(
      `/shifts?from=${new Date(now - 30 * DAY).toISOString()}&to=${new Date(now + DAY).toISOString()}&guardId=${id}`,
    )
      .then((r) => {
        const started = r.shifts.filter((s) => s.actualStartedAt).reverse();
        setShifts(started);
        setShiftId((current) => current || started[0]?.id || '');
        if (started.length === 0) setMode('range');
      })
      .catch(() => setMode('range'));
  }, [id, can, membership.organizationId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const params = new URLSearchParams();
    if (mode === 'shift') {
      if (!shiftId) return setError('Choose a shift.');
      params.set('shiftId', shiftId);
    } else {
      const span = Date.parse(to) - Date.parse(from);
      if (!(span > 0) || span > HISTORY_MAX_RANGE_H * 3_600_000) {
        return setError(`Choose a range of up to ${HISTORY_MAX_RANGE_H} hours, ending after it starts.`);
      }
      params.set('from', toInstant(from));
      params.set('to', toInstant(to));
    }
    if (reason.trim()) params.set('reason', reason.trim());
    setBusy(true);
    try {
      const h = await api<LocationHistory>(`/guards/${id}/location-history?${params.toString()}`);
      setHistory(h);
      setCursor(0);
    } catch (e) {
      if (e instanceof ApiError && e.details.some((d) => d.path === 'reason')) setReasonRequired(true);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const track = useMemo<MapTrack | null>(() => {
    if (!history) return null;
    const segments: { lat: number; lng: number }[][] = [];
    for (const p of history.points) {
      if (p.gapBefore || segments.length === 0) segments.push([]);
      segments.at(-1)!.push({ lat: p.lat, lng: p.lng });
    }
    const at = history.points[cursor];
    return {
      segments,
      flagged: history.points.filter((p) => p.flags.length > 0),
      cursor: at ? { lat: at.lat, lng: at.lng } : null,
    };
  }, [history, cursor]);
  const fit = useMemo(() => history?.points.map((p) => ({ lat: p.lat, lng: p.lng })) ?? [], [history]);
  const shapes = useMemo<MapShape[]>(
    () => history?.shifts.map((s) => ({ id: s.site.id, name: s.site.name, boundary: s.site.boundary })) ?? [],
    [history],
  );

  if (!can('location.history.read')) {
    return <div className="banner error">Your role can't view location history.</div>;
  }
  const tz = history?.shifts[0]?.site.timezone ?? membership.organizationTimezone;
  const at = history?.points[cursor];
  const breaks = history?.points.filter((p) => p.gapBefore).length ?? 0;
  const flagged = history?.points.filter((p) => p.flags.length > 0).length ?? 0;

  return (
    <>
      <PageHead
        title={`Location history${history ? ` — ${history.guard.displayName}` : ''}`}
        description="Viewing is recorded in the audit log, with your name and your reason."
        actions={
          <Link className="btn" href={`/guards/${id}`}>
            Back to guard
          </Link>
        }
      />
      <form className="card" onSubmit={(e) => void submit(e)}>
        <div className="row">
          <label className="row">
            <input
              type="radio"
              checked={mode === 'shift'}
              onChange={() => setMode('shift')}
              disabled={shifts.length === 0}
            />
            One shift
          </label>
          <label className="row">
            <input type="radio" checked={mode === 'range'} onChange={() => setMode('range')} />A time range
            (up to {HISTORY_MAX_RANGE_H} hours)
          </label>
        </div>
        {mode === 'shift' ? (
          <label className="field">
            <span>Shift</span>
            <select value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
              {shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.site.name} · {formatDateTime(s.startsAt, s.site.timezone)} ({s.status.toLowerCase()})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="form-row">
            <label className="field">
              <span>From (this computer's time)</span>
              <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required />
            </label>
            <label className="field">
              <span>To</span>
              <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} required />
            </label>
          </div>
        )}
        <label className="field">
          <span>Reason{reasonRequired ? ' (required by your organization)' : ''}</span>
          <input
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="For example: client complaint about the night shift"
            required={reasonRequired}
          />
        </label>
        {error ? <div className="banner error">{error}</div> : null}
        <div className="row">
          <button className="btn primary" disabled={busy}>
            {busy ? 'Loading…' : 'Show history'}
          </button>
        </div>
      </form>
      {history ? (
        <>
          <div className="card">
            <p className="muted">
              {history.points.length === history.totalPoints
                ? `${history.totalPoints} points`
                : `Showing ${history.points.length} of ${history.totalPoints} points (thinned for drawing)`}
              {breaks > 0
                ? ` · ${breaks} break${breaks > 1 ? 's' : ''} where no location arrived for over 5 minutes`
                : ''}
              {flagged > 0 ? ` · ${flagged} flagged point${flagged > 1 ? 's' : ''} in red` : ''}
            </p>
            {history.points.length === 0 ? (
              <div className="empty">No location was recorded in this period.</div>
            ) : (
              <>
                <BoundaryMap shapes={shapes} track={track} fit={fit} height="min(520px, 60vh)" />
                <label className="field">
                  <span>Play back</span>
                  <input
                    type="range"
                    min={0}
                    max={history.points.length - 1}
                    value={cursor}
                    onChange={(e) => setCursor(Number(e.target.value))}
                    aria-label="Position in time"
                  />
                </label>
                {at ? (
                  <p>
                    <strong>{siteTime(at.capturedAt, tz)}</strong>
                    {at.accuracyM !== null ? ` · ±${Math.round(at.accuracyM)} m` : ''}
                    {at.flags.length > 0
                      ? ` · flagged: ${at.flags.join(', ').toLowerCase().replaceAll('_', ' ')}`
                      : ''}
                    {at.gapBefore ? ' · after a break' : ''}
                  </p>
                ) : null}
              </>
            )}
          </div>
          {history.events.length > 0 ? (
            <div className="card">
              <h2>What happened</h2>
              <ul className="plain-list">
                {history.events.map((e) => (
                  <li key={`${e.shiftId}-${e.type}-${e.occurredAt}`}>
                    <strong>{siteTime(e.occurredAt, tz)}</strong> {EVENT_LABEL[e.type] ?? e.type}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
