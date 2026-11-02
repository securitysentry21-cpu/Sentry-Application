'use client';

// One incident (PROD §10, §14.6): what was filed and what happened since. The guard's submission is
// never edited (INV-05): the type and severity as filed stay visible after a change, and corrections
// are notes. Times are in the site's time zone. The reported location shows on the map with its
// accuracy, to everyone who can see the incident (owner decision 2026-11-02). Photos open through
// short-lived signed links; originals are for Owners and Administrators, audited. Actions follow
// permissions; the server decides. The page follows the realtime stream: an event for this incident
// reloads it. Plain text only (ADV-W01); phone-width friendly (D-04).
import type { IncidentDetail, IncidentSeverity, IncidentType, Site } from '@sentryops/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { IncidentPhotos } from '../../../../components/incident-photos';
import {
  DrillBadge,
  IncidentDescription,
  IncidentFacts,
  IncidentTimeline,
} from '../../../../components/incidents';
import { BoundaryMap, type MapShape, type MapTrack } from '../../../../components/map';
import { PageHead } from '../../../../components/shell';
import { api, ApiError, errorText } from '../../../../lib/api';
import {
  INCIDENT_TYPES,
  locationFlagsText,
  NOTE_MAX,
  REOPEN_REASON_MAX,
  RESOLUTION_NOTE_MAX,
  SEVERITIES,
  SEVERITY_LABEL,
  TYPE_LABEL,
} from '../../../../lib/incidents';
import { useReloadOn } from '../../../../lib/live';
import { useSession } from '../../../../lib/session';

export default function IncidentPage() {
  const { id } = useParams<{ id: string }>();
  const { can, membership } = useSession();
  const [incident, setIncident] = useState<IncidentDetail | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIncident((await api<{ incident: IncidentDetail }>(`/incidents/${id}`)).incident);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, membership.organizationId]);

  useReloadOn(
    (e) => (e.type === 'incident.updated' || e.type === 'incident.created') && e.data.incidentId === id,
    load,
  );

  // The site's boundary around the reported location, for context.
  const siteId = incident?.location ? incident.site?.id : undefined;
  useEffect(() => {
    setSite(null);
    if (!siteId || !can('sites.read')) return;
    let cancelled = false;
    void api<Site>(`/sites/${siteId}`)
      .then((s) => !cancelled && setSite(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [siteId, can]);

  const location = incident?.location ?? null;
  // Keyed by the coordinates, so a reload for a new note doesn't move the map.
  const lat = location?.lat;
  const lng = location?.lng;
  const flagged = (incident?.locationFlags.length ?? 0) > 0;
  // One marker: red when the location was flagged (fake GPS), otherwise the ringed position marker.
  const track = useMemo<MapTrack | null>(
    () =>
      lat !== undefined && lng !== undefined
        ? flagged
          ? { segments: [], flagged: [{ lat, lng }], cursor: null }
          : { segments: [], flagged: [], cursor: { lat, lng } }
        : null,
    [lat, lng, flagged],
  );
  const fit = useMemo(() => (lat !== undefined && lng !== undefined ? [{ lat, lng }] : []), [lat, lng]);
  const shapes = useMemo<MapShape[]>(
    () => (site ? [{ id: site.id, name: site.name, boundary: site.boundary }] : []),
    [site],
  );

  if (error && !incident) return <div className="banner error">{error}</div>;
  if (!incident) return <div className="loading">Loading…</div>;

  const tz = incident.site?.timezone ?? membership.organizationTimezone;
  const changed = (next: IncidentDetail, message: string | null = null) => {
    setIncident(next);
    setNotice(message);
    setError(null);
  };

  return (
    <>
      <PageHead
        title={`${incident.referenceNumber} · ${incident.title}`}
        description={`${TYPE_LABEL[incident.type]} · ${SEVERITY_LABEL[incident.severity]} severity`}
        actions={
          <Link className="btn" href="/incidents">
            All incidents
          </Link>
        }
      />
      {incident.isDrill ? (
        <div className="banner warn" role="status">
          <DrillBadge /> Filed during an SOS drill or in a demo organization: it is left out of incident
          statistics.
        </div>
      ) : null}
      {error ? <div className="banner error">{error}</div> : null}
      {notice ? <div className="banner warn">{notice}</div> : null}
      <div className="grid cols-2">
        <div className="card">
          <h2>Incident</h2>
          <IncidentFacts incident={incident} timeZone={tz} canGuards={can('guards.read')} />
        </div>
        <div className="card">
          <h2>Description</h2>
          <IncidentDescription text={incident.description} />
          <p className="faint">As filed. Descriptions are never changed: corrections are notes.</p>
        </div>
      </div>
      {location && track ? (
        <div className="card">
          <h2>Where it was reported</h2>
          <BoundaryMap shapes={shapes} track={track} fit={fit} height="min(360px, 50vh)" />
          <p className="muted">
            Where the guard&apos;s phone was when the report was filed
            {location.accuracyM !== null ? `, to about ±${Math.round(location.accuracyM)} m` : ''}. The device
            location evidence indicates the phone was here; it doesn&apos;t prove where the incident happened.
            {incident.locationFlags.length > 0
              ? ` Flagged: ${locationFlagsText(incident.locationFlags)} (red dot).`
              : ''}
          </p>
        </div>
      ) : null}
      <div className="card">
        <h2>
          Photos <span className="faint">({incident.attachments.length})</span>
        </h2>
        {incident.attachments.length === 0 ? (
          <p className="muted">No photos. Photos come from the guard app.</p>
        ) : (
          <IncidentPhotos
            attachments={incident.attachments}
            timeZone={tz}
            canOriginal={can('incidents.attachments.original')}
          />
        )}
      </div>
      <IncidentActions incident={incident} onChanged={changed} />
      <div className="card">
        <h2>History</h2>
        <IncidentTimeline events={incident.events} timeZone={tz} />
      </div>
    </>
  );
}

type Changed = (next: IncidentDetail, message?: string | null) => void;

function IncidentActions({ incident, onChanged }: { incident: IncidentDetail; onChanged: Changed }) {
  const { can } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'resolve' | 'reopen' | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [severity, setSeverity] = useState<IncidentSeverity>(incident.severity);
  const [type, setType] = useState<IncidentType>(incident.type);

  // A new copy from the server (or the stream) resets the choice to what it says now.
  useEffect(() => {
    setSeverity(incident.severity);
    setType(incident.type);
  }, [incident.severity, incident.type, incident.version]);

  const canAck = can('incidents.acknowledge') && incident.status === 'OPEN';
  const canManage = can('incidents.manage');
  const canNote = can('incidents.notes');
  if (!canAck && !canManage && !canNote) return null;

  async function run(name: string, path: string, body?: unknown, success?: () => void) {
    setBusy(name);
    setError(null);
    try {
      const result = await api<{ incident: IncidentDetail }>(`/incidents/${incident.id}${path}`, {
        method: path === '' ? 'PATCH' : 'POST',
        body,
      });
      onChanged(result.incident);
      success?.();
    } catch (e) {
      const current = (e instanceof ApiError ? e.current : null) as { incident?: IncidentDetail } | null;
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT' && current?.incident) {
        onChanged(
          current.incident,
          'Someone else changed this incident meanwhile. This is how it is now: check it, then try again.',
        );
      } else {
        setError(errorText(e));
      }
    } finally {
      setBusy(null);
    }
  }

  const submitForm = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    if (form === 'resolve') void run('resolve', '/resolve', { note: value }, () => setForm(null));
    if (form === 'reopen') void run('reopen', '/reopen', { reason: value }, () => setForm(null));
  };

  const changes = {
    ...(severity !== incident.severity ? { severity } : {}),
    ...(type !== incident.type ? { type } : {}),
  };

  return (
    <div className="card">
      <h2>Actions</h2>
      {error ? <div className="banner error">{error}</div> : null}
      {canAck || (canManage && !form) ? (
        <div className="row">
          {canAck ? (
            <button
              type="button"
              className="btn primary"
              disabled={busy !== null}
              onClick={() => void run('acknowledge', '/acknowledge')}
            >
              {busy === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
            </button>
          ) : null}
          {canManage && !form && incident.status !== 'RESOLVED' ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setForm('resolve');
                setText('');
              }}
            >
              Resolve…
            </button>
          ) : null}
          {canManage && !form && incident.status === 'RESOLVED' ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setForm('reopen');
                setText('');
              }}
            >
              Reopen…
            </button>
          ) : null}
        </div>
      ) : null}
      {form ? (
        <form className="grid" onSubmit={submitForm}>
          <label className="field">
            <span>{form === 'resolve' ? 'Resolution note (required)' : 'Why it is reopened (required)'}</span>
            <textarea
              rows={3}
              required
              maxLength={form === 'resolve' ? RESOLUTION_NOTE_MAX : REOPEN_REASON_MAX}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="row">
            <button className="btn primary" disabled={busy !== null || !text.trim()}>
              {form === 'resolve' ? 'Resolve incident' : 'Reopen incident'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {canManage ? (
        <form
          className="form-row"
          onSubmit={(e) => {
            e.preventDefault();
            void run('change', '', { version: incident.version, ...changes });
          }}
        >
          <label className="field">
            <span>Severity</span>
            <select value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as IncidentType)}>
              {INCIDENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" disabled={busy !== null || Object.keys(changes).length === 0}>
            {busy === 'change' ? 'Saving…' : 'Save severity and type'}
          </button>
        </form>
      ) : null}
      {canManage ? (
        <p className="faint">
          Changes are recorded with the old and new value; the original stays visible. Raising it to Critical
          sounds the alarm on every dashboard.
        </p>
      ) : null}
      {canNote ? (
        <form
          className="grid"
          onSubmit={(e) => {
            e.preventDefault();
            const body = note.trim();
            if (body) void run('note', '/notes', { body }, () => setNote(''));
          }}
        >
          <label className="field">
            <span>Add a note</span>
            <textarea rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn" disabled={busy !== null || !note.trim()}>
              {busy === 'note' ? 'Adding…' : 'Add note'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
