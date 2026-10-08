'use client';

// Shifts (PROD §6). Times are entered and shown in each site's time zone and sent as UTC instants;
// the server owns every state change (PROD §6.3) and refuses anything the table doesn't allow.
import type { Guard, Shift, Site } from '@sentryops/contracts';
import { addDays, localDate, localToUtc } from '@sentryops/domain';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import { useSession } from '../../../lib/session';

const STATUS_BADGE: Record<string, string> = {
  SCHEDULED: 'info',
  ACTIVE: 'ok',
  COMPLETED: 'plain',
  MISSED: 'danger',
  CANCELLED: 'warn',
};
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function timeIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}

function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

export default function ShiftsPage() {
  const { can, membership } = useSession();
  const tz = membership.organizationTimezone;
  const [day, setDay] = useState(() => localDate(new Date(), tz));
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [guards, setGuards] = useState<Guard[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // The local day, widened by a day either side so overnight shifts show on both dates.
      const from = localToUtc(addDays(day, -1), '00:00', tz).toISOString();
      const to = localToUtc(addDays(day, 2), '00:00', tz).toISOString();
      const res = await api<{ shifts: Shift[] }>(
        `/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      const dayStart = localToUtc(day, '00:00', tz).getTime();
      const dayEnd = localToUtc(addDays(day, 1), '00:00', tz).getTime();
      setShifts(
        res.shifts.filter(
          (s) => new Date(s.startsAt).getTime() < dayEnd && new Date(s.endsAt).getTime() > dayStart,
        ),
      );
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [day, tz]);

  useEffect(() => {
    void load();
  }, [load, membership.organizationId]);

  useEffect(() => {
    if (!can('shifts.write')) return;
    void Promise.all([api<{ guards: Guard[] }>('/guards'), api<{ sites: Site[] }>('/sites')])
      .then(([g, s]) => {
        setGuards(g.guards.filter((x) => x.status === 'ACTIVE'));
        setSites(s.sites.filter((x) => x.status === 'ACTIVE'));
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [can, membership.organizationId]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of shifts ?? []) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [shifts]);

  return (
    <>
      <PageHead
        title="Shifts"
        description="Who is on duty where. Times are in each site's time zone."
        actions={
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
        }
      />
      {error ? <div className="banner error">{error}</div> : null}
      <div className="grid cols-3">
        {(['ACTIVE', 'SCHEDULED', 'MISSED'] as const).map((status) => (
          <div className="card stat" key={status}>
            <span className="label">{status.toLowerCase()}</span>
            <span className="value">{counts[status] ?? 0}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>{dayLabel(day)}</h2>
        {shifts === null ? (
          <div className="loading">Loading…</div>
        ) : shifts.length === 0 ? (
          <div className="empty">No shifts on this day.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Guard</th>
                  <th>Site</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Flags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">
                      {timeIn(s.startsAt, s.site.timezone)}–{timeIn(s.endsAt, s.site.timezone)}
                    </td>
                    <td>
                      {s.guard.displayName} <span className="faint mono">{s.guard.employeeNumber}</span>
                    </td>
                    <td>{s.site.name}</td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[s.status] ?? ''}`}>
                        {s.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="muted">
                      {s.actualStartedAt ? timeIn(s.actualStartedAt, s.site.timezone) : '—'}
                      {s.startSource === 'SUPERVISOR_MANUAL' ? (
                        <div className="faint">manual — no tracking</div>
                      ) : null}
                    </td>
                    <td className="muted">
                      {s.startFlags.map((f) => f.toLowerCase().replaceAll('_', ' ')).join(', ')}
                    </td>
                    <td>
                      {can('shifts.supervise') ? (
                        <ShiftActions shift={s} onChanged={() => void load()} onError={setError} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {can('shifts.write') ? (
        <div className="grid cols-2">
          <CreateShift guards={guards} sites={sites} day={day} onCreated={() => void load()} />
          <BulkShifts guards={guards} sites={sites} day={day} onCreated={() => void load()} />
        </div>
      ) : null}
    </>
  );
}

function ShiftActions({
  shift,
  onChanged,
  onError,
}: {
  shift: Shift;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  async function act(path: string, body: Record<string, unknown>) {
    try {
      await api(`/shifts/${shift.id}/${path}`, { method: 'POST', body });
      onChanged();
    } catch (e) {
      onError(errorText(e));
    }
  }
  const withReason = (path: string, question: string) => () => {
    const reason = window.prompt(question);
    if (reason && reason.trim()) void act(path, { reason });
  };
  return (
    <div className="row">
      {shift.status === 'SCHEDULED' ? (
        <>
          <button
            className="btn small"
            onClick={withReason(
              'manual-start',
              'Why start this shift manually? (no tracking until the phone starts)',
            )}
          >
            Manual start
          </button>
          <button className="btn small danger" onClick={withReason('cancel', 'Reason for cancelling?')}>
            Cancel
          </button>
        </>
      ) : null}
      {shift.status === 'ACTIVE' ? (
        <>
          <button
            className="btn small"
            onClick={() => {
              const hours = Number(window.prompt('Extend by how many hours?', '1'));
              if (hours > 0)
                void act('extend', {
                  endsAt: new Date(new Date(shift.endsAt).getTime() + hours * 3_600_000).toISOString(),
                });
            }}
          >
            Extend
          </button>
          <button
            className="btn small danger"
            onClick={withReason('force-end', 'Reason for ending this shift?')}
          >
            End
          </button>
        </>
      ) : null}
      {shift.status === 'MISSED' ? (
        <button className="btn small" onClick={withReason('reopen', 'Reason for reopening?')}>
          Reopen
        </button>
      ) : null}
    </div>
  );
}

type FormProps = { guards: Guard[]; sites: Site[]; day: string; onCreated: () => void };

function CreateShift({ guards, sites, day, onCreated }: FormProps) {
  const [guardId, setGuardId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('20:00');
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const site = sites.find((s) => s.id === siteId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!site) return;
    setMessage(null);
    const startsAt = localToUtc(day, startTime, site.timezone);
    const endsAt = localToUtc(endTime <= startTime ? addDays(day, 1) : day, endTime, site.timezone);
    try {
      await api('/shifts', {
        method: 'POST',
        body: { guardId, siteId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      });
      setMessage({ kind: 'success', text: 'Shift created.' });
      onCreated();
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
    }
  }

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <h2>New shift on {dayLabel(day)}</h2>
      {message ? <div className={`banner ${message.kind}`}>{message.text}</div> : null}
      <GuardSiteFields
        guards={guards}
        sites={sites}
        guardId={guardId}
        siteId={siteId}
        setGuardId={setGuardId}
        setSiteId={setSiteId}
      />
      <div className="form-row">
        <label className="field">
          <span>Starts</span>
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
        </label>
        <label className="field">
          <span>Ends {endTime <= startTime ? '(next day)' : ''}</span>
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
        </label>
      </div>
      <button className="btn primary" disabled={!guardId || !siteId}>
        Create shift
      </button>
    </form>
  );
}

function BulkShifts({ guards, sites, day, onCreated }: FormProps) {
  const [guardId, setGuardId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [startTime, setStartTime] = useState('20:00');
  const [endTime, setEndTime] = useState('08:00');
  const [toDate, setToDate] = useState(() => addDays(day, 13));
  const [result, setResult] = useState<{
    preview: boolean;
    created: number;
    shifts: { conflict: string | null }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(preview: boolean) {
    setError(null);
    try {
      const r = await api<{ preview: boolean; created: number; shifts: { conflict: string | null }[] }>(
        `/shifts/bulk?preview=${preview}`,
        {
          method: 'POST',
          body: { guardId, siteId, weekdays, startTime, endTime, fromDate: day, toDate },
        },
      );
      setResult(r);
      if (!preview && r.created > 0) onCreated();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const conflicts = result?.shifts.filter((s) => s.conflict).length ?? 0;
  return (
    <div className="card">
      <h2>Weekly pattern</h2>
      <p className="muted">
        From {dayLabel(day)}. Creates ordinary shifts; nothing repeats by itself afterwards.
      </p>
      {error ? <div className="banner error">{error}</div> : null}
      <GuardSiteFields
        guards={guards}
        sites={sites}
        guardId={guardId}
        siteId={siteId}
        setGuardId={setGuardId}
        setSiteId={setSiteId}
      />
      <div className="row">
        {WEEKDAYS.map((label, index) => (
          <label key={label} className="row" style={{ gap: 4 }}>
            <input
              type="checkbox"
              checked={weekdays.includes(index)}
              onChange={(e) =>
                setWeekdays((w) => (e.target.checked ? [...w, index].sort() : w.filter((x) => x !== index)))
              }
            />
            {label}
          </label>
        ))}
      </div>
      <div className="form-row">
        <label className="field">
          <span>Starts</span>
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </label>
        <label className="field">
          <span>Ends {endTime <= startTime ? '(next day)' : ''}</span>
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </label>
        <label className="field">
          <span>Until</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button
          className="btn"
          disabled={!guardId || !siteId || weekdays.length === 0}
          onClick={() => void run(true)}
        >
          Preview
        </button>
        {result?.preview && conflicts === 0 && result.shifts.length > 0 ? (
          <button className="btn primary" onClick={() => void run(false)}>
            Create {result.shifts.length} shifts
          </button>
        ) : null}
      </div>
      {result ? (
        <div className={`banner ${conflicts ? 'error' : 'success'}`}>
          {result.preview
            ? `${result.shifts.length} shifts${conflicts ? `, ${conflicts} with conflicts — nothing will be created until they are resolved` : ', no conflicts'}.`
            : `${result.created} shifts created.`}
        </div>
      ) : null}
    </div>
  );
}

function GuardSiteFields(props: {
  guards: Guard[];
  sites: Site[];
  guardId: string;
  siteId: string;
  setGuardId: (v: string) => void;
  setSiteId: (v: string) => void;
}) {
  return (
    <div className="form-row">
      <label className="field">
        <span>Guard</span>
        <select value={props.guardId} onChange={(e) => props.setGuardId(e.target.value)} required>
          <option value="">Choose…</option>
          {props.guards.map((g) => (
            <option key={g.id} value={g.id}>
              {g.displayName} ({g.employeeNumber})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Site</span>
        <select value={props.siteId} onChange={(e) => props.setSiteId(e.target.value)} required>
          <option value="">Choose…</option>
          {props.sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
