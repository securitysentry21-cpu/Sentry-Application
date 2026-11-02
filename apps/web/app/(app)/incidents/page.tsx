'use client';

// Incidents (PROD §10, §14.6): newest first, open ones by default, filtered by status, severity,
// type and site; the filters live in the address, so the home page's count links here. Supervisors
// and above record an incident from the dashboard: text only, photos come from the guard app (V1).
// The list follows the realtime stream: an incident event reloads it. Plain text only (ADV-W01);
// phone-width friendly (D-04).
import type {
  IncidentDetail,
  IncidentSeverity,
  IncidentSummary,
  IncidentType,
  Site,
} from '@sentryops/contracts';
import { localToUtc } from '@sentryops/domain';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { IncidentTable } from '../../../components/incidents';
import { PageHead } from '../../../components/shell';
import { api, errorText } from '../../../lib/api';
import {
  DEFAULT_SEVERITY,
  DESCRIPTION_MAX,
  INCIDENT_TYPES,
  MAX_BACKDATE_H,
  occurredAtProblem,
  SEVERITIES,
  SEVERITY_LABEL,
  TITLE_MAX,
  TYPE_LABEL,
} from '../../../lib/incidents';
import { useReloadOn } from '../../../lib/live';
import { useSession } from '../../../lib/session';

/** The server lists at most 200 at a time. */
const LIMIT = 100;
const STATUS_FILTERS = { open: 'Open and acknowledged', resolved: 'Resolved', all: 'All' } as const;
type StatusFilter = keyof typeof STATUS_FILTERS;

/** A value from the address, if it is one of the allowed ones. */
function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | '' {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : '';
}

export default function IncidentsPage() {
  const { membership } = useSession();
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      {/* A new organization starts from a clean page: no filters of the previous one. */}
      <Incidents key={membership.organizationId} />
    </Suspense>
  );
}

function Incidents() {
  const { can, membership } = useSession();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const status: StatusFilter =
    oneOf(search.get('status'), Object.keys(STATUS_FILTERS) as StatusFilter[]) || 'open';
  const severity = oneOf(search.get('severity'), SEVERITIES);
  const type = oneOf(search.get('type'), INCIDENT_TYPES);
  const siteId = search.get('siteId') ?? '';
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams({ status, limit: String(LIMIT) });
    if (severity) params.set('severity', severity);
    if (type) params.set('type', type);
    if (siteId) params.set('siteId', siteId);
    return params.toString();
  }, [status, severity, type, siteId]);

  const load = useCallback(async () => {
    try {
      setIncidents((await api<{ incidents: IncidentSummary[] }>(`/incidents?${query}`)).incidents);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [query]);

  useEffect(() => {
    setIncidents(null);
    void load();
  }, [load]);

  useReloadOn((e) => e.type === 'incident.created' || e.type === 'incident.updated', load);

  useEffect(() => {
    if (!can('sites.read')) return;
    void api<{ sites: Site[] }>('/sites')
      .then((r) => setSites(r.sites))
      .catch(() => undefined);
  }, [can]);

  const setFilter = (name: string, value: string, fallback = '') => {
    const params = new URLSearchParams(search.toString());
    if (value && value !== fallback) params.set(name, value);
    else params.delete(name);
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname);
  };

  const filtered = Boolean(severity || type || siteId) || status !== 'open';

  return (
    <>
      <PageHead
        title="Incidents"
        description="What guards and supervisors reported, newest first. Times are in each site's time zone."
        actions={
          can('incidents.create') && !recording ? (
            <button type="button" className="btn primary" onClick={() => setRecording(true)}>
              Record incident
            </button>
          ) : null
        }
      />
      {error ? <div className="banner error">{error}</div> : null}
      {recording ? (
        <RecordIncident
          sites={sites.filter((s) => s.status === 'ACTIVE')}
          timeZone={membership.organizationTimezone}
          onClose={() => setRecording(false)}
          onRecorded={(incident) => router.push(`/incidents/${incident.id}`)}
        />
      ) : null}
      <div className="row filters">
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => setFilter('status', e.target.value, 'open')}>
            {Object.entries(STATUS_FILTERS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Severity</span>
          <select value={severity} onChange={(e) => setFilter('severity', e.target.value)}>
            <option value="">Any severity</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Type</span>
          <select value={type} onChange={(e) => setFilter('type', e.target.value)}>
            <option value="">Any type</option>
            {INCIDENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {sites.length > 0 ? (
          <label className="field">
            <span>Site</span>
            <select value={siteId} onChange={(e) => setFilter('siteId', e.target.value)}>
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="card">
        {incidents === null ? (
          <div className="loading">Loading…</div>
        ) : incidents.length === 0 ? (
          <div className="empty">{filtered ? 'No incidents match.' : 'No open incidents.'}</div>
        ) : (
          <>
            <IncidentTable incidents={incidents} timeZone={membership.organizationTimezone} />
            {incidents.length >= LIMIT ? (
              <p className="faint">Showing the newest {LIMIT}. Narrow the filters to see older ones.</p>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/** "YYYY-MM-DDTHH:MM" for a datetime-local input, in `timeZone`. */
function localInputValue(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** A datetime-local value read in `timeZone`, as epoch milliseconds (NaN when incomplete). */
function fromInputValue(value: string, timeZone: string): number {
  const [date, time] = value.split('T');
  if (!date || !time) return Number.NaN;
  try {
    return localToUtc(date, time.slice(0, 5), timeZone).getTime();
  } catch {
    return Number.NaN;
  }
}

/** POST /incidents (PROD §3.2: Supervisors and above): text only, no location, no photos. */
function RecordIncident({
  sites,
  timeZone: orgTimeZone,
  onClose,
  onRecorded,
}: {
  sites: readonly Site[];
  timeZone: string;
  onClose: () => void;
  onRecorded: (incident: IncidentDetail) => void;
}) {
  const [type, setType] = useState<IncidentType>('OTHER');
  const [severity, setSeverity] = useState<IncidentSeverity>(DEFAULT_SEVERITY.OTHER);
  const [severityChosen, setSeverityChosen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [siteId, setSiteId] = useState('');
  const [earlier, setEarlier] = useState(false);
  const site = sites.find((s) => s.id === siteId);
  const timeZone = site?.timezone ?? orgTimeZone;
  const [occurred, setOccurred] = useState(() => localInputValue(Date.now(), orgTimeZone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let occurredAt: string | undefined;
    if (earlier) {
      const ms = fromInputValue(occurred, timeZone);
      const problem = occurredAtProblem(ms, Date.now());
      if (problem) return setError(problem);
      occurredAt = new Date(ms).toISOString();
    }
    setBusy(true);
    try {
      const body = {
        type,
        severity,
        title: title.trim(),
        description: description.trim(),
        ...(siteId ? { siteId } : {}),
        ...(occurredAt ? { occurredAt } : {}),
      };
      const result = await api<{ incident: IncidentDetail }>('/incidents', { method: 'POST', body });
      onRecorded(result.incident);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <div className="card-head">
        <h2>Record an incident</h2>
        <button type="button" className="btn small ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
      <p className="muted">
        Recorded from the dashboard with your name. Photos and a location come only from the guard app.
        Critical raises an alarm on every dashboard; High raises an alert (PROD §10.4).
      </p>
      {error ? <div className="banner error">{error}</div> : null}
      <div className="form-row">
        <label className="field">
          <span>Type</span>
          <select
            value={type}
            onChange={(e) => {
              const next = e.target.value as IncidentType;
              setType(next);
              if (!severityChosen) setSeverity(DEFAULT_SEVERITY[next]);
            }}
          >
            {INCIDENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Severity</span>
          <select
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value as IncidentSeverity);
              setSeverityChosen(true);
            }}
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Site (optional)</span>
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">No site</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Title</span>
        <input required maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} />
        <span className="hint">
          {title.length} of {TITLE_MAX} characters
        </span>
      </label>
      <label className="field">
        <span>What happened (optional)</span>
        <textarea
          rows={5}
          maxLength={DESCRIPTION_MAX}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <span className="hint">It can't be changed afterwards: corrections are added as notes.</span>
      </label>
      <label className="row">
        <input type="checkbox" checked={earlier} onChange={(e) => setEarlier(e.target.checked)} />
        It happened earlier (up to {MAX_BACKDATE_H} hours ago)
      </label>
      {earlier ? (
        <label className="field">
          <span>
            When it happened ({site ? `${site.name}'s time` : 'organization time'}, {timeZone})
          </span>
          <input
            type="datetime-local"
            required
            value={occurred}
            onChange={(e) => setOccurred(e.target.value)}
          />
        </label>
      ) : null}
      <div className="row">
        <button className="btn primary" disabled={busy || title.trim().length === 0}>
          {busy ? 'Recording…' : 'Record incident'}
        </button>
      </div>
    </form>
  );
}
