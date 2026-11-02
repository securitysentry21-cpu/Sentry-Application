'use client';

// SOS drills (PROD §11.10, ADV-S10). An Owner or Administrator opens a drill window, naming the guards
// whose SOS is a drill and the members taking part (the person starting it always does). During the
// window those guards' SOS is marked DRILL everywhere, reaches only the members taking part, with
// notifications marked "[DRILL]" and no texts to emergency contacts, and is left out of statistics.
// Anyone else's SOS is real. Everyone else sees a drill in the alert list, marked DRILL, without an
// alarm (owner decision 2026-11-02). One drill at a time, up to 4 hours; it can be ended early.
import type { Guard, Member, SosDrill } from '@sentryops/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { PageHead } from '../../../components/shell';
import { api, ApiError, errorText } from '../../../lib/api';
import { zonedDateTime } from '../../../lib/format';
import { useLive } from '../../../lib/live';
import { useSession } from '../../../lib/session';

/** packages/contracts/src/sos.ts: the server enforces these; the form only says so early. */
const DURATION_MINUTES = { min: 5, max: 240, initial: 60 } as const;
const NOTE_MAX = 500;
const MAX_PICKS = 50;

export default function DrillsPage() {
  const { can, membership } = useSession();
  const { now } = useLive();
  const tz = membership.organizationTimezone;
  const [drill, setDrill] = useState<SosDrill | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  const load = useCallback(async () => {
    try {
      setDrill((await api<{ drill: SosDrill | null }>('/sos-drills/current')).drill);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, membership.organizationId]);

  // The window closes by itself at its end: look again then.
  const endsAt = drill ? Date.parse(drill.endsAt) : null;
  const over = endsAt !== null && now.getTime() >= endsAt;
  useEffect(() => {
    if (over) void load();
  }, [over, load]);

  async function end(id: string) {
    if (!window.confirm('End the drill now? SOS from these guards will be real again.')) return;
    setEnding(true);
    setError(null);
    try {
      await api(`/sos-drills/${id}/end`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setEnding(false);
    }
  }

  return (
    <>
      <PageHead
        title="SOS drills"
        description="Practise the SOS with chosen guards and members, without alarming anyone else."
      />
      {error ? <div className="banner error">{error}</div> : null}
      <div className="card">
        <h2>Now</h2>
        {drill === undefined ? (
          <div className="loading">Loading…</div>
        ) : drill && !over ? (
          <>
            <div className="banner warn" role="status">
              <span className="badge drill">DRILL</span> A drill is running until{' '}
              <strong>{zonedDateTime(drill.endsAt, tz)}</strong> (
              {Math.max(1, Math.ceil((Date.parse(drill.endsAt) - now.getTime()) / 60_000))} min left).
            </div>
            <dl className="kv">
              <dt>Started</dt>
              <dd>
                {zonedDateTime(drill.startedAt, tz)} by {drill.startedBy.name}
              </dd>
              <dt>Guards in the drill</dt>
              <dd>{drill.guards.map((g) => g.displayName).join(', ') || '—'}</dd>
              <dt>Members taking part</dt>
              <dd>{drill.members.map((m) => m.name).join(', ') || '—'}</dd>
              {drill.note ? (
                <>
                  <dt>Note</dt>
                  <dd className="prewrap">{drill.note}</dd>
                </>
              ) : null}
            </dl>
            {can('sos.drill') ? (
              <div className="row">
                <button
                  type="button"
                  className="btn danger"
                  disabled={ending}
                  onClick={() => void end(drill.id)}
                >
                  {ending ? 'Ending…' : 'End drill now'}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">No drill is running. Every SOS is real.</p>
        )}
      </div>
      {drill === null && can('sos.drill') ? <StartDrill onStarted={(d) => setDrill(d)} /> : null}
      <div className="card">
        <h2>How a drill works</h2>
        <ul className="plain-list">
          <li>
            Only the guards you pick have their SOS treated as a drill. Anyone else&apos;s SOS during the
            drill is real.
          </li>
          <li>
            A drill SOS reaches only the members taking part: their alarm, pushes and texts, marked
            &quot;[DRILL]&quot;. Emergency contacts are never texted for a drill.
          </li>
          <li>Everyone else sees it in the alert list, marked DRILL, with no alarm.</li>
          <li>
            Drills are left out of incident statistics. Resolve a drill SOS with the resolution
            &quot;Drill&quot;.
          </li>
        </ul>
      </div>
    </>
  );
}

function StartDrill({ onStarted }: { onStarted: (drill: SosDrill) => void }) {
  const { me, membership } = useSession();
  const [guards, setGuards] = useState<Guard[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [guardIds, setGuardIds] = useState<ReadonlySet<string>>(new Set());
  const [memberIds, setMemberIds] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [minutes, setMinutes] = useState(String(DURATION_MINUTES.initial));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api<{ guards: Guard[] }>('/guards'), api<{ members: Member[] }>('/members')])
      .then(([g, m]) => {
        setGuards(g.guards.filter((x) => x.status === 'ACTIVE'));
        setMembers(m.members.filter((x) => x.status === 'ACTIVE' && x.role !== 'GUARD'));
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [membership.organizationId]);

  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const duration = Number(minutes);
    if (!Number.isInteger(duration) || duration < DURATION_MINUTES.min || duration > DURATION_MINUTES.max) {
      return setError(`The drill lasts ${DURATION_MINUTES.min} to ${DURATION_MINUTES.max} minutes.`);
    }
    if (guardIds.size === 0) return setError('Pick at least one guard.');
    if (guardIds.size > MAX_PICKS || memberIds.size > MAX_PICKS) {
      return setError(`At most ${MAX_PICKS} guards and ${MAX_PICKS} members.`);
    }
    setBusy(true);
    try {
      const result = await api<{ drill: SosDrill }>('/sos-drills', {
        method: 'POST',
        body: {
          guardIds: [...guardIds],
          memberIds: [...memberIds],
          durationMinutes: duration,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      });
      onStarted(result.drill);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'DRILL_ALREADY_RUNNING'
          ? 'A drill is already running. Reload the page to see it.'
          : errorText(e),
      );
    } finally {
      setBusy(false);
    }
  }

  const self = members?.find((m) => m.id === membership.memberId || m.userId === me.user.id);
  const others = (members ?? []).filter((m) => m !== self);
  const shownGuards = (guards ?? []).filter((g) =>
    `${g.displayName} ${g.employeeNumber}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <h2>Start a drill</h2>
      {error ? <div className="banner error">{error}</div> : null}
      <fieldset className="checks">
        <legend>
          Guards in the drill <span className="faint">({guardIds.size} picked)</span>
        </legend>
        {guards === null ? (
          <div className="loading">Loading…</div>
        ) : guards.length === 0 ? (
          <p className="muted">No active guards.</p>
        ) : (
          <>
            {guards.length > 8 ? (
              <input
                placeholder="Search name or employee number"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Search guards"
              />
            ) : null}
            <div className="check-list">
              {shownGuards.map((g) => (
                <label className="row" key={g.id}>
                  <input
                    type="checkbox"
                    checked={guardIds.has(g.id)}
                    onChange={() => setGuardIds((s) => toggle(s, g.id))}
                  />
                  {g.displayName} <span className="faint">{g.employeeNumber}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </fieldset>
      <fieldset className="checks">
        <legend>
          Members taking part <span className="faint">({memberIds.size + 1} with you)</span>
        </legend>
        <label className="row">
          <input type="checkbox" checked disabled />
          {self?.name ?? me.user.name} <span className="faint">(you: always taking part)</span>
        </label>
        <div className="check-list">
          {others.map((m) => (
            <label className="row" key={m.id}>
              <input
                type="checkbox"
                checked={memberIds.has(m.id)}
                onChange={() => setMemberIds((s) => toggle(s, m.id))}
              />
              {m.name} <span className="faint">{m.role.toLowerCase()}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-row">
        <label className="field">
          <span>Duration (minutes)</span>
          <input
            type="number"
            min={DURATION_MINUTES.min}
            max={DURATION_MINUTES.max}
            step={1}
            required
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
          <span className="hint">
            {DURATION_MINUTES.min} to {DURATION_MINUTES.max} minutes; you can end it early.
          </span>
        </label>
        <label className="field">
          <span>Note (optional)</span>
          <input maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy || guardIds.size === 0}>
          {busy ? 'Starting…' : 'Start drill'}
        </button>
      </div>
    </form>
  );
}
