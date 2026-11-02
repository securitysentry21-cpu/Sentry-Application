'use client';

// Patrol routes (PROD §9.1–§9.2): an ordered set of a site's checkpoints, walked on demand or every N
// minutes. Rounds are per shift (D-16): each guard on duty at the site walks their own, timed from the
// start of their shift. The form checks what it can early; the server re-checks every rule (the
// site's own checkpoints, a required one for a schedule, one active scheduled route per checkpoint)
// and its message is shown as it is. Names render as text only (ADV-W01).
import type { Checkpoint, PatrolRoute } from '@sentryops/contracts';
import { useState, type FormEvent } from 'react';

import { api, ApiError, errorText } from '../lib/api';
import { INTERVAL_MINUTES, OFFSET_MINUTES, scheduleText, WINDOW_MINUTES } from '../lib/patrols';

const STATUS_BADGE = { ACTIVE: 'ok', INACTIVE: 'warn', ARCHIVED: 'plain' } as const;

type Schedule = NonNullable<PatrolRoute['schedule']>;
type Stop = { checkpointId: string; name: string; required: boolean };

export function RouteTable({
  routes,
  onEdit,
}: {
  routes: readonly PatrolRoute[];
  /** Shown with patrols.write. */
  onEdit?: (route: PatrolRoute) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Route</th>
            <th>Schedule</th>
            <th>Checkpoints</th>
            <th>Order</th>
            <th>Status</th>
            {onEdit ? <th aria-label="Actions" /> : null}
          </tr>
        </thead>
        <tbody>
          {routes.map((r) => (
            <tr key={r.id}>
              <td>
                {r.name}
                {r.description ? <div className="faint">{r.description}</div> : null}
              </td>
              <td>{scheduleText(r.schedule)}</td>
              <td>
                {r.checkpoints.length}
                {r.checkpoints.length > 0 ? (
                  <div className="faint">
                    {r.checkpoints.map((c) => (c.required ? c.name : `${c.name} (optional)`)).join(' → ')}
                  </div>
                ) : null}
              </td>
              <td>{r.enforceOrder ? 'Enforced' : 'Guidance'}</td>
              <td>
                <span className={`badge ${STATUS_BADGE[r.status]}`}>{r.status.toLowerCase()}</span>
              </td>
              {onEdit ? (
                <td>
                  <button className="btn small" onClick={() => onEdit(r)}>
                    Edit
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const minutesIn = (value: string, range: { min: number; max: number }) => {
  const n = Number(value);
  return value.trim() !== '' && Number.isInteger(n) && n >= range.min && n <= range.max;
};

const sameSchedule = (a: Schedule | null, b: Schedule | null) =>
  a === null || b === null
    ? a === b
    : a.intervalMinutes === b.intervalMinutes &&
      a.firstRunOffsetMinutes === b.firstRunOffsetMinutes &&
      a.completionWindowMinutes === b.completionWindowMinutes;

type StopInput = { checkpointId: string; required: boolean };
const sameStops = (a: readonly StopInput[], b: readonly StopInput[]) =>
  a.length === b.length &&
  a.every((s, i) => s.checkpointId === b[i]?.checkpointId && s.required === b[i]?.required);

/** Adds a route to a site, or edits one. */
export function RouteEditor({
  siteId,
  route,
  checkpoints,
  routes,
  onClose,
  onSaved,
}: {
  siteId: string;
  /** Null for a new route. */
  route: PatrolRoute | null;
  /** The site's checkpoints; archived ones are not among them. */
  checkpoints: readonly Checkpoint[];
  /** The site's routes, to point out checkpoints already in another scheduled one. */
  routes: readonly PatrolRoute[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(route?.name ?? '');
  const [description, setDescription] = useState(route?.description ?? '');
  const [scheduled, setScheduled] = useState(route ? route.schedule !== null : true);
  const [interval, setIntervalMinutes] = useState(String(route?.schedule?.intervalMinutes ?? 60));
  const [completion, setCompletion] = useState(String(route?.schedule?.completionWindowMinutes ?? 30));
  const [offset, setOffset] = useState(String(route?.schedule?.firstRunOffsetMinutes ?? 0));
  const [enforceOrder, setEnforceOrder] = useState(route?.enforceOrder ?? false);
  const [status, setStatus] = useState<PatrolRoute['status']>(route?.status ?? 'ACTIVE');
  const [stops, setStops] = useState<Stop[]>(() =>
    [...(route?.checkpoints ?? [])]
      .sort((a, b) => a.sequence - b.sequence)
      .map((c) => ({ checkpointId: c.checkpointId, name: c.name, required: c.required })),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const byId = new Map(checkpoints.map((c) => [c.id, c]));
  const available = checkpoints.filter(
    (c) => c.status === 'ACTIVE' && !stops.some((s) => s.checkpointId === c.id),
  );
  // The server allows a checkpoint in only one active scheduled route; on-demand routes may share.
  const checkTaken = scheduled && status === 'ACTIVE';
  const taken = new Map<string, string>();
  for (const r of routes) {
    if (r.id === route?.id || r.status !== 'ACTIVE' || !r.schedule) continue;
    for (const c of r.checkpoints) taken.set(c.checkpointId, r.name);
  }

  const timesOk =
    minutesIn(interval, INTERVAL_MINUTES) &&
    minutesIn(completion, WINDOW_MINUTES) &&
    minutesIn(offset, OFFSET_MINUTES);
  const schedule: Schedule | null = scheduled
    ? {
        intervalMinutes: Number(interval),
        firstRunOffsetMinutes: Number(offset),
        completionWindowMinutes: Number(completion),
      }
    : null;
  const problems: string[] = [];
  if (schedule) {
    if (!minutesIn(interval, INTERVAL_MINUTES))
      problems.push(`Rounds can be every ${INTERVAL_MINUTES.min} to ${INTERVAL_MINUTES.max} minutes.`);
    if (!minutesIn(completion, WINDOW_MINUTES))
      problems.push(`The time to complete is ${WINDOW_MINUTES.min} to ${WINDOW_MINUTES.max} minutes.`);
    if (!minutesIn(offset, OFFSET_MINUTES))
      problems.push(
        `The first round is due ${OFFSET_MINUTES.min} to ${OFFSET_MINUTES.max} minutes after the start.`,
      );
    if (timesOk && schedule.completionWindowMinutes > schedule.intervalMinutes)
      problems.push("The time to complete can't be longer than the interval: rounds would overlap.");
    if (status === 'ACTIVE' && !stops.some((s) => s.required))
      problems.push('A scheduled route needs at least one required checkpoint.');
  }
  const archived = stops.filter((s) => !byId.has(s.checkpointId));
  if (archived.length > 0)
    problems.push(
      `Remove the archived checkpoint${archived.length > 1 ? 's' : ''}: ${archived.map((s) => s.name).join(', ')}.`,
    );

  function move(index: number, by: -1 | 1) {
    setStops((list) => {
      const next = [...list];
      const [stop] = next.splice(index, 1);
      if (stop) next.splice(index + by, 0, stop);
      return next;
    });
  }

  function add(id: string) {
    const c = byId.get(id);
    if (c) setStops((list) => [...list, { checkpointId: c.id, name: c.name, required: true }]);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (problems.length > 0 || !name.trim()) return;
    const body: Record<string, unknown> = {};
    const desc = description.trim() || null;
    const stopsBody = stops.map((s) => ({ checkpointId: s.checkpointId, required: s.required }));
    if (route) {
      // Only what changed: the audit log lists the fields, and a route change re-plans future rounds.
      if (name.trim() !== route.name) body.name = name.trim();
      if (desc !== route.description) body.description = desc;
      if (enforceOrder !== route.enforceOrder) body.enforceOrder = enforceOrder;
      if (!sameSchedule(schedule, route.schedule)) body.schedule = schedule;
      if (
        !sameStops(
          stopsBody,
          [...route.checkpoints].sort((a, b) => a.sequence - b.sequence),
        )
      )
        body.checkpoints = stopsBody;
      if (status !== route.status) body.status = status;
      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }
      if (
        body.status === 'ARCHIVED' &&
        !window.confirm(`Archive ${route.name}? No new rounds are created, and it leaves this list.`)
      )
        return;
    }
    setBusy(true);
    setError(null);
    try {
      if (route) {
        await api<PatrolRoute>(`/patrol-routes/${route.id}`, {
          method: 'PATCH',
          body: { ...body, version: route.version },
        });
      } else {
        await api<PatrolRoute>(`/sites/${siteId}/patrol-routes`, {
          method: 'POST',
          body: { name: name.trim(), description: desc, enforceOrder, schedule, checkpoints: stopsBody },
        });
      }
      onSaved();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'VERSION_CONFLICT'
          ? `${errorText(e)} Close this and open the route again to see the latest version.`
          : errorText(e),
      );
      setBusy(false);
    }
  }

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="route-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <form className="dialog wide" onSubmit={(e) => void save(e)}>
        <div className="card-head">
          <h2 id="route-title">{route ? `Edit ${route.name}` : 'New patrol route'}</h2>
          <button type="button" className="btn small ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        <p className="muted">Rounds are per shift: each guard on duty at this site walks their own rounds.</p>
        {error ? <div className="banner error">{error}</div> : null}
        <div className="form-row">
          <label className="field">
            <span>Name</span>
            <input
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="field">
            <span>Rounds</span>
            <select
              value={scheduled ? 'scheduled' : 'on-demand'}
              onChange={(e) => setScheduled(e.target.value === 'scheduled')}
            >
              <option value="scheduled">Every N minutes during each shift</option>
              <option value="on-demand">On demand: scans are recorded, nothing is missed</option>
            </select>
          </label>
          {route ? (
            <label className="field">
              <span>Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as PatrolRoute['status'])}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive: no new rounds</option>
                <option value="ARCHIVED">Archived: no new rounds, not listed</option>
              </select>
            </label>
          ) : null}
        </div>
        <label className="field">
          <span>Description (optional)</span>
          <textarea
            rows={2}
            maxLength={4000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {scheduled ? (
          <>
            <div className="form-row">
              <label className="field">
                <span>Every (minutes)</span>
                <input
                  type="number"
                  required
                  min={INTERVAL_MINUTES.min}
                  max={INTERVAL_MINUTES.max}
                  step={1}
                  value={interval}
                  onChange={(e) => setIntervalMinutes(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Time to complete (minutes)</span>
                <input
                  type="number"
                  required
                  min={WINDOW_MINUTES.min}
                  max={WINDOW_MINUTES.max}
                  step={1}
                  value={completion}
                  onChange={(e) => setCompletion(e.target.value)}
                />
                <span className="hint">No longer than the interval.</span>
              </label>
              <label className="field">
                <span>First round (minutes after the shift starts)</span>
                <input
                  type="number"
                  required
                  min={OFFSET_MINUTES.min}
                  max={OFFSET_MINUTES.max}
                  step={1}
                  value={offset}
                  onChange={(e) => setOffset(e.target.value)}
                />
              </label>
            </div>
            {timesOk ? (
              <p className="faint">{scheduleText(schedule)}, until the shift's scheduled end.</p>
            ) : null}
          </>
        ) : null}
        <label className="row">
          <input type="checkbox" checked={enforceOrder} onChange={(e) => setEnforceOrder(e.target.checked)} />
          Enforce the order: scans out of order still count, but are flagged
        </label>
        <h3>Checkpoints in order</h3>
        {stops.length === 0 ? (
          <div className="empty">No checkpoints yet. Add them below in the order guards should walk.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Checkpoint</th>
                  <th>Required</th>
                  <th aria-label="Move or remove" />
                </tr>
              </thead>
              <tbody>
                {stops.map((s, i) => {
                  const c = byId.get(s.checkpointId);
                  const note = !c
                    ? 'archived: remove it'
                    : c.status !== 'ACTIVE'
                      ? 'inactive: its label is refused when scanned'
                      : !c.location
                        ? 'no position: its scans can only be “QR only”'
                        : null;
                  const other = checkTaken ? taken.get(s.checkpointId) : undefined;
                  return (
                    <tr key={s.checkpointId}>
                      <td className="mono">{i + 1}</td>
                      <td>
                        {s.name}
                        {note ? <div className="faint">{note}</div> : null}
                        {other ? (
                          <div className="faint">
                            also in the scheduled route {other}: a checkpoint can be in only one
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={s.required}
                          aria-label={`${s.name} is required`}
                          onChange={(e) =>
                            setStops((list) =>
                              list.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)),
                            )
                          }
                        />
                      </td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                          <button
                            type="button"
                            className="btn small"
                            disabled={i === 0}
                            onClick={() => move(i, -1)}
                            aria-label={`Move ${s.name} up`}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn small"
                            disabled={i === stops.length - 1}
                            onClick={() => move(i, 1)}
                            aria-label={`Move ${s.name} down`}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="btn small ghost"
                            onClick={() => setStops((list) => list.filter((_, j) => j !== i))}
                            aria-label={`Remove ${s.name}`}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="row">
          <select value="" onChange={(e) => add(e.target.value)} aria-label="Add a checkpoint">
            <option value="">
              {available.length === 0 ? 'No more active checkpoints at this site' : 'Add a checkpoint…'}
            </option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn small"
            disabled={available.length === 0}
            onClick={() =>
              setStops((list) => [
                ...list,
                ...available.map((c) => ({ checkpointId: c.id, name: c.name, required: true })),
              ])
            }
          >
            Add all
          </button>
        </div>
        {problems.length > 0 ? (
          <div className="banner warn" role="status">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        ) : null}
        <div className="row">
          <button className="btn primary" disabled={busy || problems.length > 0 || !name.trim()}>
            {busy ? 'Saving…' : route ? 'Save route' : 'Create route'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
