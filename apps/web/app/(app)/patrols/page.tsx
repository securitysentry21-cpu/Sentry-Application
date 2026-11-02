'use client';

// Patrols (PROD §9, §14.6): every guard's rounds for a day, by site and status, newest first. A round
// opens in a plain-text panel: its checkpoints in route order, what was done, and every scan attached
// to it, with outcome, distance, accuracy and flags in words. ?guardId= and ?shiftId= narrow the list
// (the guard page links here); one shift also lists every scan in it, failed ones and those outside
// any round included. The server sends distances and accuracy, never a guard's coordinates. The list
// refreshes every minute while visible and when the window regains focus. Plain text only (ADV-W01);
// phone-width friendly (D-04).
import type { CheckpointVisit, Guard, PatrolRun, PatrolRunStatus, Shift, Site } from '@sentryops/contracts';
import { addDays, localDate, localToUtc } from '@sentryops/domain';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { RunDetail, RunsTable, VisitsTable, type RunDetailData } from '../../../components/patrol-runs';
import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import { formatDateTime, siteTime } from '../../../lib/format';
import { RUN_STATUS_LABEL, RUN_STATUSES } from '../../../lib/patrols';
import { useSession } from '../../../lib/session';

const REFRESH_MS = 60_000;
/** Focus and visibility events often come in pairs: one refresh for both. */
const MIN_REFRESH_GAP_MS = 5_000;
const HOUR_MS = 3_600_000;
/** The server lists at most 31 days of rounds, and at most 500 at a time. */
const MAX_RANGE_MS = 31 * 24 * HOUR_MS;
const LIMIT = 500;

type Range = { from: string; to: string };

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

/** A shift's rounds are due between its start and its scheduled end: an hour's margin either side. */
function shiftRange(s: Shift): Range {
  const start = Math.min(Date.parse(s.startsAt), Date.parse(s.actualStartedAt ?? s.startsAt)) - HOUR_MS;
  const end = Math.max(Date.parse(s.endsAt), Date.parse(s.actualEndedAt ?? s.endsAt)) + HOUR_MS;
  return {
    from: new Date(Math.max(start, end - MAX_RANGE_MS)).toISOString(),
    to: new Date(end).toISOString(),
  };
}

export default function PatrolsPage() {
  const { membership } = useSession();
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      {/* A new organization starts from a clean page: no filters or round of the previous one. */}
      <Patrols key={membership.organizationId} />
    </Suspense>
  );
}

function Patrols() {
  const { can, membership } = useSession();
  const tz = membership.organizationTimezone;
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const guardId = search.get('guardId');
  const shiftId = search.get('shiftId');
  const runParam = search.get('run');
  const [day, setDay] = useState(() => localDate(new Date(), tz));
  const [siteId, setSiteId] = useState('');
  const [status, setStatus] = useState<PatrolRunStatus | ''>('');
  const [runs, setRuns] = useState<PatrolRun[] | null>(null);
  const [visits, setVisits] = useState<CheckpointVisit[] | null>(null);
  const [shift, setShift] = useState<Shift | null>(null);
  const [guard, setGuard] = useState<Guard | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [selected, setSelected] = useState<string | null>(runParam);
  const [detail, setDetail] = useState<RunDetailData | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const refresh = useRef(() => {});

  const replaceParams = useCallback(
    (change: Record<string, string | null>) => {
      const params = new URLSearchParams(search.toString());
      for (const [key, value] of Object.entries(change)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [search, router, pathname],
  );

  // A link to one round (?run=) opens it.
  useEffect(() => {
    setSelected(runParam);
  }, [runParam]);

  useEffect(() => {
    setShift(null);
    if (!shiftId || !can('shifts.read')) return;
    let cancelled = false;
    void api<Shift>(`/shifts/${encodeURIComponent(shiftId)}`)
      .then((s) => !cancelled && setShift(s))
      .catch((e: unknown) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [shiftId, can]);

  useEffect(() => {
    setGuard(null);
    if (!guardId || !can('guards.read')) return;
    let cancelled = false;
    void api<Guard>(`/guards/${encodeURIComponent(guardId)}`)
      .then((g) => !cancelled && setGuard(g))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [guardId, can]);

  useEffect(() => {
    if (!can('sites.read')) return;
    void api<{ sites: Site[] }>('/sites')
      .then((r) => setSites(r.sites))
      .catch(() => undefined);
  }, [can]);

  // One shift: its own window (null until it has loaded). Otherwise the chosen day in the
  // organization's time zone, like the Shifts page.
  const range = useMemo((): Range | 'server-default' | null => {
    if (shiftId) {
      if (shift?.id === shiftId) return shiftRange(shift);
      return can('shifts.read') ? null : 'server-default';
    }
    return {
      from: localToUtc(day, '00:00', tz).toISOString(),
      to: localToUtc(addDays(day, 1), '00:00', tz).toISOString(),
    };
  }, [shiftId, shift, day, tz, can]);

  const load = useCallback(async () => {
    if (!range) return;
    const params = new URLSearchParams({ limit: String(LIMIT) });
    if (range !== 'server-default') {
      params.set('from', range.from);
      params.set('to', range.to);
    }
    if (shiftId) params.set('shiftId', shiftId);
    else if (siteId) params.set('siteId', siteId);
    if (guardId) params.set('guardId', guardId);
    try {
      const [list, scans] = await Promise.all([
        api<{ runs: PatrolRun[] }>(`/patrol-runs?${params.toString()}`),
        shiftId
          ? api<{ visits: CheckpointVisit[] }>(`/checkpoint-visits?shiftId=${encodeURIComponent(shiftId)}`)
          : null,
      ]);
      setRuns(list.runs);
      setVisits(scans?.visits ?? null);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [range, siteId, guardId, shiftId]);

  const loadDetail = useCallback(async () => {
    if (!selected) return;
    try {
      setDetail(await api<RunDetailData>(`/patrol-runs/${encodeURIComponent(selected)}`));
      setDetailError(null);
    } catch (e) {
      setDetailError(errorText(e));
    }
  }, [selected]);

  // New filters: show "Loading…" rather than another day's rounds.
  useEffect(() => {
    setRuns(null);
    setVisits(null);
    void load();
  }, [load]);

  useEffect(() => {
    setDetailError(null);
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    refresh.current = () => {
      void load();
      void loadDetail();
    };
  }, [load, loadDetail]);

  // Every minute while the page is visible, and as soon as it is looked at again.
  useEffect(() => {
    let last = Date.now();
    const wake = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < MIN_REFRESH_GAP_MS) return;
      last = Date.now();
      refresh.current();
    };
    const timer = window.setInterval(wake, REFRESH_MS);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);

  useEffect(() => {
    if (selected) dialog.current?.focus();
  }, [selected]);

  const counts = useMemo(() => {
    const c = new Map<PatrolRunStatus, number>();
    for (const r of runs ?? []) c.set(r.status, (c.get(r.status) ?? 0) + 1);
    return c;
  }, [runs]);
  const shown = useMemo(() => (runs ?? []).filter((r) => !status || r.status === status), [runs, status]);
  const rounds = useMemo(
    () => new Map((runs ?? []).map((r) => [r.id, `${r.route.name} · round ${r.sequenceNo}`])),
    [runs],
  );

  function close() {
    setSelected(null);
    if (runParam) replaceParams({ run: null });
  }

  if (!can('patrols.read')) return <div className="banner error">Your role can't view patrols.</div>;

  const narrowed = shiftId
    ? `One shift${shift ? `: ${shift.guard.displayName} at ${shift.site.name}, ${formatDateTime(shift.startsAt, shift.site.timezone)}–${siteTime(shift.endsAt, shift.site.timezone)}` : ''}`
    : guardId
      ? `One guard: ${guard?.displayName ?? runs?.[0]?.guard.displayName ?? '…'}`
      : null;
  // The panel shows the round asked for, never the previous one while the next loads.
  const current = detail?.run.id === selected ? detail : null;

  return (
    <>
      <PageHead
        title="Patrols"
        description="Each guard's rounds in their own shift, newest first. Times are in each site's time zone."
        actions={
          shiftId ? null : (
            <div className="row">
              <button className="btn" onClick={() => setDay(addDays(day, -1))} aria-label="Previous day">
                ←
              </button>
              <input
                type="date"
                value={day}
                onChange={(e) => e.target.value && setDay(e.target.value)}
                aria-label="Day"
              />
              <button className="btn" onClick={() => setDay(addDays(day, 1))} aria-label="Next day">
                →
              </button>
              <button className="btn ghost" onClick={() => setDay(localDate(new Date(), tz))}>
                Today
              </button>
            </div>
          )
        }
      />
      {error ? <div className="banner error">{error}</div> : null}
      {narrowed ? (
        <div className="banner row">
          <span>{narrowed}</span>
          <button
            className="btn small"
            onClick={() => replaceParams({ guardId: null, shiftId: null, run: null })}
          >
            Show all rounds
          </button>
        </div>
      ) : null}
      <div className="grid cols-6">
        {RUN_STATUSES.map((s) => {
          const n = counts.get(s) ?? 0;
          const tone =
            n > 0 && s === 'MISSED' ? ' tone-danger' : n > 0 && s === 'INCOMPLETE' ? ' tone-warn' : '';
          return (
            <button
              className={`card stat${tone}`}
              key={s}
              onClick={() => setStatus(status === s ? '' : s)}
              aria-pressed={status === s}
            >
              <span className="label">{RUN_STATUS_LABEL[s]}</span>
              <span className="value">{runs ? n : '–'}</span>
            </button>
          );
        })}
      </div>
      <div className="row filters">
        {!shiftId && sites.length > 0 ? (
          <label className="field">
            <span>Site</span>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as PatrolRunStatus | '')}>
            <option value="">All</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {RUN_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button className="btn" onClick={() => refresh.current()}>
          Refresh
        </button>
      </div>
      <div className="card">
        <h2>
          {shiftId ? 'Rounds in this shift' : dayLabel(day)}{' '}
          {runs ? <span className="faint">({shown.length})</span> : null}
        </h2>
        {runs && runs.length >= LIMIT ? (
          <div className="banner warn">
            Showing the latest {LIMIT} rounds only. Choose a site to see the others.
          </div>
        ) : null}
        {runs === null ? (
          <div className="loading">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="empty">
            {runs.length > 0
              ? 'No rounds with this status.'
              : shiftId
                ? 'No rounds in this shift.'
                : 'No rounds due on this day.'}
          </div>
        ) : (
          <RunsTable runs={shown} onSelect={setSelected} withDate={Boolean(shiftId)} />
        )}
        <p className="faint">
          Scheduled routes give each guard on duty their own rounds. Routes on demand have none: their scans
          are listed with the guard's shift.
        </p>
      </div>
      {shiftId ? (
        <div className="card">
          <h2>Every scan in this shift {visits ? <span className="faint">({visits.length})</span> : null}</h2>
          <p className="muted">
            Failed scans and scans outside any round included, in the order they were made.
          </p>
          {visits === null ? (
            <div className="loading">Loading…</div>
          ) : visits.length === 0 ? (
            <div className="empty">No scans in this shift.</div>
          ) : (
            <VisitsTable visits={visits} timezone={shift?.site.timezone ?? tz} rounds={rounds} />
          )}
        </div>
      ) : null}
      {selected ? (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="run-title"
          onClick={close}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
          }}
        >
          <div className="dialog wide" ref={dialog} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            {detailError ? <div className="banner error">{detailError}</div> : null}
            {current ? (
              <>
                <RunDetail detail={current} onClose={close} />
                {shiftId ? null : (
                  <Link
                    className="btn small"
                    href={`/patrols?shiftId=${current.run.shiftId}`}
                    onClick={() => setSelected(null)}
                  >
                    Every scan in this shift
                  </Link>
                )}
              </>
            ) : detailError ? (
              <button className="btn" onClick={close}>
                Close
              </button>
            ) : (
              <div className="loading">Loading…</div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
