// Incidents as plain text (PROD §10, §14.6): the list, an incident's facts and its history. Times
// are in the site's time zone (or the organization's) with the zone's name. Severity and status are
// words in their badges, never colour alone (PROD §14.7). Titles, descriptions, notes and names only
// ever render as text (SEC §8, ADV-W01).
import type { IncidentDetail, IncidentEvent, IncidentSummary } from '@sentryops/contracts';
import Link from 'next/link';

import { zonedDateTime } from '../lib/format';
import {
  actorText,
  eventText,
  SEVERITY_BADGE,
  SEVERITY_LABEL,
  STATUS_BADGE,
  STATUS_LABEL,
  TYPE_LABEL,
} from '../lib/incidents';

export function SeverityBadge({ severity }: { severity: IncidentSummary['severity'] }) {
  return <span className={`badge ${SEVERITY_BADGE[severity]}`}>{SEVERITY_LABEL[severity]}</span>;
}

export function IncidentStatusBadge({ status }: { status: IncidentSummary['status'] }) {
  return <span className={`badge ${STATUS_BADGE[status]}`}>{STATUS_LABEL[status]}</span>;
}

/** Drills and demo organizations' incidents are marked, and left out of statistics (PROD §11.10). */
export function DrillBadge() {
  return <span className="badge drill">DRILL</span>;
}

/** Who filed it: a guard from the app, or a person from the dashboard. */
export function reporterText(i: Pick<IncidentSummary, 'guard' | 'reportedBy'>): string {
  if (i.guard) return i.guard.displayName;
  if (i.reportedBy) return `${i.reportedBy.name} (dashboard)`;
  return '—';
}

export function IncidentTable({
  incidents,
  timeZone,
  showReporter = true,
}: {
  incidents: readonly IncidentSummary[];
  /** For incidents without a site. */
  timeZone: string;
  /** Off on a guard's own page. */
  showReporter?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Reference</th>
            <th>Incident</th>
            <th>Severity</th>
            <th>Status</th>
            <th>{showReporter ? 'Reported by · site' : 'Site'}</th>
            <th>Occurred (site time)</th>
          </tr>
        </thead>
        <tbody>
          {incidents.map((i) => (
            <tr key={i.id}>
              <td>
                <Link className="mono" href={`/incidents/${i.id}`}>
                  {i.referenceNumber}
                </Link>
              </td>
              <td>
                <strong>{TYPE_LABEL[i.type]}</strong> {i.isDrill ? <DrillBadge /> : null}
                <div>{i.title}</div>
                {i.photoCount > 0 ? (
                  <div className="faint">
                    {i.photoCount} photo{i.photoCount > 1 ? 's' : ''}
                  </div>
                ) : null}
              </td>
              <td>
                <SeverityBadge severity={i.severity} />
              </td>
              <td>
                <IncidentStatusBadge status={i.status} />
              </td>
              <td>
                {showReporter ? reporterText(i) : null}
                <div className={showReporter ? 'faint' : undefined}>{i.site?.name ?? 'No site'}</div>
              </td>
              <td>{zonedDateTime(i.occurredAt, i.site?.timezone ?? timeZone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The submission and what happened to it; the original type and severity when they changed. */
export function IncidentFacts({
  incident: i,
  timeZone,
  canGuards,
}: {
  incident: IncidentDetail;
  timeZone: string;
  /** Link the guard to their page. */
  canGuards: boolean;
}) {
  const at = (iso: string) => zonedDateTime(iso, timeZone);
  return (
    <dl className="kv">
      <dt>Reference</dt>
      <dd className="mono">{i.referenceNumber}</dd>
      <dt>Type</dt>
      <dd>
        {TYPE_LABEL[i.type]}
        {i.original.type !== i.type ? (
          <span className="faint"> · filed as {TYPE_LABEL[i.original.type]}</span>
        ) : null}
      </dd>
      <dt>Severity</dt>
      <dd>
        <SeverityBadge severity={i.severity} />
        {i.original.severity !== i.severity ? (
          <span className="faint"> · filed as {SEVERITY_LABEL[i.original.severity]}</span>
        ) : null}
      </dd>
      <dt>Status</dt>
      <dd>
        <IncidentStatusBadge status={i.status} />
        {i.acknowledgedAt ? (
          <div className="faint">
            Acknowledged{i.acknowledgedBy ? ` by ${i.acknowledgedBy.name}` : ''} · {at(i.acknowledgedAt)}
          </div>
        ) : null}
        {i.resolvedAt ? (
          <div className="faint">
            Resolved{i.resolvedBy ? ` by ${i.resolvedBy.name}` : ''} · {at(i.resolvedAt)}
          </div>
        ) : null}
        {i.resolutionNote ? <div className="prewrap">Resolution: {i.resolutionNote}</div> : null}
      </dd>
      <dt>Reported by</dt>
      <dd>
        {i.guard ? (
          <>
            {canGuards ? (
              <Link href={`/guards/${i.guard.id}`}>{i.guard.displayName}</Link>
            ) : (
              i.guard.displayName
            )}{' '}
            <span className="faint">(guard, from the app)</span>
          </>
        ) : i.reportedBy ? (
          <>
            {i.reportedBy.name} <span className="faint">(from the dashboard)</span>
          </>
        ) : (
          '—'
        )}
      </dd>
      <dt>Site</dt>
      <dd>{i.site?.name ?? 'No site'}</dd>
      {i.checkpoint ? (
        <>
          <dt>Checkpoint</dt>
          <dd>{i.checkpoint.name}</dd>
        </>
      ) : null}
      <dt>Occurred</dt>
      <dd>{at(i.occurredAt)}</dd>
      <dt>Reported</dt>
      <dd>{at(i.reportedAt)}</dd>
      <dt>Received</dt>
      <dd>{at(i.receivedAt)}</dd>
      {i.sosEventId ? (
        <>
          <dt>SOS</dt>
          <dd>
            Filed during an SOS · <Link href={`/sos/${i.sosEventId}`}>Open the SOS</Link>
          </dd>
        </>
      ) : null}
      {i.isDrill ? (
        <>
          <dt>Drill</dt>
          <dd>
            <DrillBadge /> <span className="faint">Left out of incident statistics</span>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/** The description as filed, line breaks kept; never changed afterwards (PROD §10.2). */
export function IncidentDescription({ text }: { text: string }) {
  return text ? <p className="prewrap">{text}</p> : <p className="muted">No description was given.</p>;
}

/** What happened, oldest first: notes, status, severity and type changes, photos. */
export function IncidentTimeline({
  events,
  timeZone,
}: {
  events: readonly IncidentEvent[];
  timeZone: string;
}) {
  const ordered = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <ol className="timeline">
      {ordered.map((e) => {
        const t = eventText(e);
        return (
          <li key={e.id}>
            <div className="row">
              <strong>{t.what}</strong>
              <span className="faint">
                {actorText(e)} · {zonedDateTime(e.createdAt, timeZone)}
              </span>
            </div>
            {t.body ? (
              <p className="prewrap">
                {t.label ? <span className="faint">{t.label}: </span> : null}
                {t.body}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
