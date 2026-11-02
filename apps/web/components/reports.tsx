// The five reports as plain-text tables (PROD §15.1). Times are in the report's own time zone (the
// site's for one site, the organization's otherwise; the page says which). Statuses, severities and
// flags are words, never colour alone (PROD §14.7). Guard, site and route names only ever render as
// text (SEC §8, ADV-W01). The location report holds no coordinates, only what the track says.
import type {
  AttendanceRow,
  IncidentReportRow,
  LocationReportRow,
  PatrolReportRow,
  SiteActivityRow,
} from '@sentryops/contracts';
import Link from 'next/link';

import { formatDateTime } from '../lib/format';
import { TYPE_LABEL } from '../lib/incidents';
import {
  attendanceFlagsText,
  dayLabel,
  excursionsText,
  excursionText,
  formatCount,
  formatKm,
  formatMinutes,
  formatPct,
  formatSeconds,
  patrolFlagsText,
  SHIFT_STATUS_BADGE,
  SHIFT_STATUS_LABEL,
  spanText,
} from '../lib/reports';
import { DrillBadge, IncidentStatusBadge, SeverityBadge } from './incidents';
import { RunStatusBadge } from './patrol-runs';

type GuardRef = AttendanceRow['guard'];

function GuardCell({ guard }: { guard: GuardRef }) {
  return (
    <>
      {guard.displayName}
      <div className="faint">{guard.employeeNumber}</div>
    </>
  );
}

export function AttendanceTable({ rows, timeZone }: { rows: readonly AttendanceRow[]; timeZone: string }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Guard</th>
            <th>Site</th>
            <th>Scheduled</th>
            <th>Actual</th>
            <th>Status</th>
            <th>Late</th>
            <th>Early leave</th>
            <th>Worked</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.shiftId}>
              <td>
                <GuardCell guard={r.guard} />
              </td>
              <td>{r.site.name}</td>
              <td>{spanText(r.scheduledStart, r.scheduledEnd, timeZone)}</td>
              <td>
                {r.actualStart
                  ? r.actualEnd
                    ? spanText(r.actualStart, r.actualEnd, timeZone)
                    : `${formatDateTime(r.actualStart, timeZone)} – not ended`
                  : '—'}
                {r.flags.length > 0 ? <div className="faint">{attendanceFlagsText(r.flags)}</div> : null}
              </td>
              <td>
                <span className={`badge ${SHIFT_STATUS_BADGE[r.status]}`}>
                  {SHIFT_STATUS_LABEL[r.status]}
                </span>
              </td>
              <td>{formatMinutes(r.lateMinutes)}</td>
              <td>{formatMinutes(r.earlyLeaveMinutes)}</td>
              <td>{formatMinutes(r.workedMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PatrolReportTable({
  rows,
  timeZone,
}: {
  rows: readonly PatrolReportRow[];
  timeZone: string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Due</th>
            <th>Guard · site</th>
            <th>Round</th>
            <th>Status</th>
            <th>Required</th>
            <th>Verified</th>
            <th>QR only</th>
            <th>Missed</th>
            <th>Completion</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.runId}>
              <td>{spanText(r.dueAt, r.windowEndsAt, timeZone)}</td>
              <td>
                {r.guard.displayName}
                <div className="faint">{r.site.name}</div>
              </td>
              <td>
                {r.route.name}
                <div className="faint">Round {r.sequenceNo}</div>
                {r.flags.length > 0 ? <div className="faint">{patrolFlagsText(r.flags)}</div> : null}
              </td>
              <td>
                <RunStatusBadge status={r.status} />
              </td>
              <td>{r.required}</td>
              <td>{r.verified}</td>
              <td>{r.qrOnly}</td>
              <td>{r.missed}</td>
              <td>{formatPct(r.completionPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function IncidentReportTable({
  rows,
  timeZone,
  linkIncidents,
}: {
  rows: readonly IncidentReportRow[];
  timeZone: string;
  /** With incidents.read, each reference opens the incident. */
  linkIncidents: boolean;
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
            <th>Guard · site</th>
            <th>Occurred · reported</th>
            <th>Acknowledged in</th>
            <th>Resolved in</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.incidentId}>
              <td>
                {linkIncidents ? (
                  <Link className="mono" href={`/incidents/${r.incidentId}`}>
                    {r.referenceNumber}
                  </Link>
                ) : (
                  <span className="mono">{r.referenceNumber}</span>
                )}
              </td>
              <td>
                {TYPE_LABEL[r.type]} {r.isDrill ? <DrillBadge /> : null}
              </td>
              <td>
                <SeverityBadge severity={r.severity} />
              </td>
              <td>
                <IncidentStatusBadge status={r.status} />
              </td>
              <td>
                {r.guard ? r.guard.displayName : 'From the dashboard'}
                <div className="faint">{r.site?.name ?? 'No site'}</div>
              </td>
              <td>
                {formatDateTime(r.occurredAt, timeZone)}
                <div className="faint">reported {formatDateTime(r.reportedAt, timeZone)}</div>
              </td>
              <td>{r.secondsToAcknowledge === null ? 'Not yet' : formatSeconds(r.secondsToAcknowledge)}</td>
              <td>{r.secondsToResolve === null ? 'Not yet' : formatSeconds(r.secondsToResolve)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What the track says about one shift; the excursions open in place. */
export function LocationReportTable({
  rows,
  timeZone,
}: {
  rows: readonly LocationReportRow[];
  timeZone: string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Guard</th>
            <th>Site · shift</th>
            <th>Track</th>
            <th>Inside · outside · unknown</th>
            <th>Excursions</th>
            <th>Longest gap</th>
            <th>Distance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const derived = (text: string) => (r.trackDeleted ? '—' : text);
            return (
              <tr key={r.shiftId}>
                <td>
                  <GuardCell guard={r.guard} />
                </td>
                <td>
                  {r.site.name}
                  <div className="faint">{spanText(r.scheduledStart, r.scheduledEnd, timeZone)}</div>
                </td>
                <td>
                  {r.trackDeleted ? (
                    <span className="badge plain">Track deleted (retention)</span>
                  ) : r.firstFixAt && r.lastFixAt ? (
                    <>
                      {spanText(r.firstFixAt, r.lastFixAt, timeZone)}
                      <div className="faint">{formatCount(r.points)} fixes</div>
                    </>
                  ) : (
                    <span className="faint">No location recorded</span>
                  )}
                </td>
                <td>
                  {r.trackDeleted ? (
                    '—'
                  ) : (
                    <>
                      Inside {formatSeconds(r.insideSeconds)}
                      <div>Outside {formatSeconds(r.outsideSeconds)}</div>
                      <div className="faint">Unknown {formatSeconds(r.unknownSeconds)}</div>
                    </>
                  )}
                </td>
                <td>
                  {r.trackDeleted || r.excursions.length === 0 ? (
                    derived(excursionsText(r.excursions))
                  ) : (
                    <details>
                      <summary>{excursionsText(r.excursions)}</summary>
                      <ol className="excursions">
                        {r.excursions.map((e, i) => (
                          <li key={`${e.from}-${i}`}>{excursionText(e, timeZone)}</li>
                        ))}
                      </ol>
                    </details>
                  )}
                </td>
                <td>{derived(formatSeconds(r.longestGapSeconds))}</td>
                <td>{derived(formatKm(r.distanceM))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SiteActivityTable({ rows }: { rows: readonly SiteActivityRow[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th>Site</th>
            <th>Shifts covered</th>
            <th>Worked</th>
            <th>Patrol completion</th>
            <th>Incidents</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.site.id}-${r.date}`}>
              <td>{dayLabel(r.date)}</td>
              <td>{r.site.name}</td>
              <td>
                {r.shiftsCovered} of {r.shiftsScheduled}
                {r.shiftsMissed > 0 || r.lateStarts > 0 ? (
                  <div className="faint">
                    {[
                      r.shiftsMissed > 0 ? `${r.shiftsMissed} missed` : '',
                      r.lateStarts > 0 ? `${r.lateStarts} started late` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                ) : null}
              </td>
              <td>{formatMinutes(r.workedMinutes)}</td>
              <td>
                {formatPct(r.patrolCompletionPct)}
                {r.patrolRequired > 0 ? (
                  <div className="faint">
                    {r.patrolCounted} of {r.patrolRequired} checkpoints
                  </div>
                ) : null}
              </td>
              <td>
                {r.incidents}
                {r.incidentsHighOrCritical > 0 ? (
                  <div className="faint">{r.incidentsHighOrCritical} high or critical</div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
