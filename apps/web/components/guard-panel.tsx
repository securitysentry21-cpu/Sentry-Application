// A guard on duty, as plain text (PROD §14.3): the two freshness signals and the phone's own
// report, each in words, never in colour alone. It replaces map popups, so names and site names
// can only ever render as text (SEC §8, ADV-W01).
import Link from 'next/link';

import { formatRelative, SERVICE_LABEL, siteTime } from '../lib/format';
import type { GuardView } from '../lib/live-model';

const HEALTH_BADGE = { LIVE: 'ok', DELAYED: 'warn', OFFLINE: 'danger' } as const;
const SITE_WORDS = { ON_SITE: 'inside site', OFF_SITE: 'outside site', UNKNOWN: null } as const;

/** "last update 8 s ago": when the server last heard from the phone. */
export function trackingLine(g: GuardView, now: Date): string {
  return g.lastContactAt ? `last update ${formatRelative(g.lastContactAt, now)}` : 'no contact yet';
}

/** "12 s ago · ±8 m · inside site", "Last known location · 4 min ago · ±12 m", or "Location unknown". */
export function locationLine(g: GuardView, now: Date): string {
  if (!g.lastFix) return 'Location unknown';
  const accuracy = g.lastFix.accuracyM !== null ? ` · ±${Math.round(g.lastFix.accuracyM)} m` : '';
  const site = SITE_WORDS[g.onSite];
  const age = formatRelative(g.lastFix.capturedAt, now);
  return g.age === 'CURRENT'
    ? `${age}${accuracy}${site ? ` · ${site}` : ''}`
    : `Last known location · ${age}${accuracy}`;
}

export function deviceLine(g: GuardView): string {
  const parts = [`Tracking service: ${SERVICE_LABEL[g.trackingServiceState ?? 'UNKNOWN'] ?? 'not reported'}`];
  if (g.batteryPct !== null)
    parts.push(`Battery ${Math.round(g.batteryPct)}%${g.isCharging ? ' (charging)' : ''}`);
  if (g.appVersion) parts.push(`App ${g.appVersion}`);
  parts.push(g.trackingProblem ? 'Tracking problem reported' : 'No tracking problems');
  // PROD §8.3: when tracking isn't LIVE, the report says when it was made.
  if (g.health !== 'LIVE' && g.deviceReportAt)
    parts.push(`as of ${siteTime(g.deviceReportAt, g.site.timezone)}`);
  return parts.join(' · ');
}

export function GuardPanel({
  guard: g,
  now,
  onClose,
}: {
  guard: GuardView;
  now: Date;
  onClose?: () => void;
}) {
  const tz = g.site.timezone;
  return (
    <div className="guard-panel" aria-label={`Details for ${g.guard.displayName}`}>
      <div className="card-head">
        <h2>{g.guard.displayName}</h2>
        {onClose ? (
          <button className="btn small ghost" onClick={onClose} aria-label="Close details">
            Close
          </button>
        ) : null}
      </div>
      <p className="muted">
        ON DUTY · {g.site.name} · Shift {siteTime(g.startsAt, tz, false)}–{siteTime(g.endsAt, tz)}
      </p>
      {g.manualStart ? <p className="faint">Manual attendance — no tracking</p> : null}
      <dl className="kv">
        <dt>Tracking</dt>
        <dd>
          <span className={`badge ${HEALTH_BADGE[g.health]}`}>{g.health.toLowerCase()}</span>{' '}
          {trackingLine(g, now)}
        </dd>
        <dt>Location</dt>
        <dd>
          <span className={`badge ${g.age === 'CURRENT' ? 'ok' : g.age === 'LAST_KNOWN' ? 'warn' : 'plain'}`}>
            {g.age === 'CURRENT' ? 'current' : g.age === 'LAST_KNOWN' ? 'last known' : 'unknown'}
          </span>{' '}
          {locationLine(g, now)}
        </dd>
        <dt>Phone</dt>
        <dd>{deviceLine(g)}</dd>
      </dl>
      <Link className="btn small" href={`/guards/${g.guard.id}`}>
        Guard details
      </Link>
    </div>
  );
}
