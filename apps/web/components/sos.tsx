// An SOS as plain text (PROD §11, §14.2): the guard and how to call them, the honest progress the
// server can prove (PROD §11.3, INV-10), the guard's "I'm safe" request, and every notification sent.
// Emergency contacts arrive masked from the API (SEC §17.2). Status is a word in its badge, never
// colour alone (PROD §14.7). Names render as text only (SEC §8, ADV-W01).
import type { SosDetail } from '@sentryops/contracts';

import { zonedDateTime } from '../lib/format';
import {
  CHANNEL_LABEL,
  DELIVERY_STATUS_BADGE,
  DELIVERY_STATUS_LABEL,
  RESOLUTION_LABEL,
  SOS_STATUS_BADGE,
  SOS_STATUS_LABEL,
  sosProgress,
  stepText,
  telHref,
} from '../lib/sos';

export function SosStatusBadge({ status }: { status: SosDetail['status'] }) {
  return <span className={`badge ${SOS_STATUS_BADGE[status]}`}>{SOS_STATUS_LABEL[status]}</span>;
}

/** PROD §11.8: "I'm safe" is a note on the SOS. It stays open, and escalation goes on. */
export function CancelNotice({ sos, timeZone }: { sos: SosDetail; timeZone: string }) {
  if (!sos.guardCancelRequestedAt || sos.status === 'RESOLVED') return null;
  return (
    <div className="banner warn notice" role="alert">
      <strong>
        The guard pressed “I’m safe / false alarm” at{' '}
        {zonedDateTime(sos.guardCancelRequestedAt, timeZone, true)}.
      </strong>{' '}
      The SOS stays open{sos.status === 'ACTIVE' ? ' and keeps escalating' : ''}: someone may be forcing them
      to cancel. Call the guard to check, then resolve it with what happened.
    </div>
  );
}

export function SosFacts({ sos, timeZone }: { sos: SosDetail; timeZone: string }) {
  const at = (iso: string) => zonedDateTime(iso, timeZone, true);
  const call = telHref(sos.guard.phone);
  return (
    <dl className="kv">
      <dt>Guard</dt>
      <dd>
        <strong>{sos.guard.displayName}</strong>{' '}
        <span className="faint">· employee {sos.guard.employeeNumber}</span>
        <div className="row">
          {call ? (
            <a className="btn primary small" href={call}>
              Call guard
            </a>
          ) : null}
          <span className="mono">{sos.guard.phone}</span>
        </div>
      </dd>
      <dt>Site</dt>
      <dd>{sos.site ? sos.site.name : 'Off shift: no site'}</dd>
      <dt>Status</dt>
      <dd>
        <SosStatusBadge status={sos.status} />
      </dd>
      <dt>Pressed</dt>
      <dd>
        {at(sos.activatedAt)}
        {sos.triggerCount > 1 ? (
          <div>
            <strong>Pressed again ×{sos.triggerCount - 1}</strong>{' '}
            <span className="faint">· last at {at(sos.lastTriggeredAt)}</span>
          </div>
        ) : null}
      </dd>
      {sos.resolution ? (
        <>
          <dt>Resolution</dt>
          <dd>
            {RESOLUTION_LABEL[sos.resolution]}
            {sos.resolutionNote ? <div className="prewrap">{sos.resolutionNote}</div> : null}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/** Each step only once the server has its fact; "not yet" otherwise (PROD §11.3). */
export function SosProgressList({ sos, timeZone }: { sos: SosDetail; timeZone: string }) {
  return (
    <ol className="progress">
      {sosProgress(sos).map((step) => (
        <li key={step.label} className={step.at ? 'done' : 'pending'}>
          <span className="progress-mark" aria-hidden="true">
            {step.at ? '✓' : '·'}
          </span>
          <span>
            <strong>{step.label}</strong>{' '}
            {step.at ? (
              <span className="faint">
                {zonedDateTime(step.at, timeZone, true)}
                {step.detail ? ` · ${step.detail}` : ''}
              </span>
            ) : (
              <span className="faint">not yet</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function DeliveriesTable({ sos, timeZone }: { sos: SosDetail; timeZone: string }) {
  if (sos.deliveries.length === 0) return <div className="empty">No notifications sent yet.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Recipient</th>
            <th>Channel</th>
            <th>Step</th>
            <th>Status</th>
            <th>Sent</th>
          </tr>
        </thead>
        <tbody>
          {sos.deliveries.map((d, i) => (
            <tr key={`${d.recipient}-${d.channel}-${d.escalationLevel}-${i}`}>
              <td>{d.recipient}</td>
              <td>{CHANNEL_LABEL[d.channel]}</td>
              <td>{stepText(d.escalationLevel)}</td>
              <td>
                <span className={`badge ${DELIVERY_STATUS_BADGE[d.status]}`}>
                  {DELIVERY_STATUS_LABEL[d.status]}
                </span>
                {d.errorCode ? <div className="faint">{d.errorCode}</div> : null}
              </td>
              <td className="faint">{d.sentAt ? zonedDateTime(d.sentAt, timeZone, true) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
