// Patrol rounds as plain text (PROD §9, §14.6): the list; one round's checkpoints in route order, what
// was done and every scan attached to it; a shift's scans. Outcomes, reasons and flags are words, never
// colour alone. The server sends distances and accuracy, never a guard's coordinates. Checkpoint,
// route, guard and site names only ever render as text (SEC §8, ADV-W01).
import type { CheckpointVisit, GuardPatrolRun, PatrolRun, PatrolRunStatus } from '@sentryops/contracts';
import Link from 'next/link';

import {
  flagsText,
  missingText,
  OUTCOME_BADGE,
  OUTCOME_LABEL,
  outcomeDetail,
  progressText,
  RUN_STATUS_BADGE,
  RUN_STATUS_LABEL,
  runWindow,
  scanTime,
  stopState,
} from '../lib/patrols';

/** GET /patrol-runs/:id. */
export type RunDetailData = {
  run: PatrolRun;
  enforceOrder: boolean;
  checkpoints: (GuardPatrolRun['checkpoints'][number] & { location: { lat: number; lng: number } | null })[];
  visits: CheckpointVisit[];
};

export function RunStatusBadge({ status }: { status: PatrolRunStatus }) {
  return <span className={`badge ${RUN_STATUS_BADGE[status]}`}>{RUN_STATUS_LABEL[status]}</span>;
}

export function RunsTable({
  runs,
  onSelect,
  href,
  showGuard = true,
  withDate = false,
}: {
  runs: readonly PatrolRun[];
  /** Opens a round's details. */
  onSelect?: (id: string) => void;
  /** Or links each round to a page. */
  href?: (run: PatrolRun) => string;
  /** Off on the guard's own page. */
  showGuard?: boolean;
  /** For lists longer than a day. */
  withDate?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Due (site time)</th>
            <th>{showGuard ? 'Guard · site' : 'Site'}</th>
            <th>Round</th>
            <th>Status</th>
            <th>Progress</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const missing = missingText(r);
            return (
              <tr key={r.id} onClick={onSelect ? () => onSelect(r.id) : undefined}>
                <td className="mono">{runWindow(r, withDate)}</td>
                <td>
                  {showGuard ? (
                    <>
                      {r.guard.displayName}
                      <div className="faint">{r.site.name}</div>
                    </>
                  ) : (
                    r.site.name
                  )}
                </td>
                <td>
                  {onSelect ? (
                    <button className="link" onClick={() => onSelect(r.id)}>
                      {r.route.name}
                    </button>
                  ) : href ? (
                    <Link href={href(r)}>{r.route.name}</Link>
                  ) : (
                    r.route.name
                  )}
                  <div className="faint">Round {r.sequenceNo}</div>
                </td>
                <td>
                  <RunStatusBadge status={r.status} />
                </td>
                <td>
                  {progressText(r)}
                  {missing ? <div className="faint">{missing}</div> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One round: its checkpoints in route order and every scan attached to it. */
export function RunDetail({ detail, onClose }: { detail: RunDetailData; onClose?: () => void }) {
  const { run } = detail;
  const tz = run.site.timezone;
  return (
    <div className="grid">
      <div className="card-head">
        <h2 id="run-title">
          {run.route.name} · round {run.sequenceNo}
        </h2>
        {onClose ? (
          <button className="btn small ghost" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
      <p className="muted">
        {run.guard.displayName} · {run.site.name}
      </p>
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          <RunStatusBadge status={run.status} /> {progressText(run)} required checkpoints
        </dd>
        <dt>Window</dt>
        <dd>{runWindow(run, true)}</dd>
        {run.startedAt ? (
          <>
            <dt>First scan</dt>
            <dd>{scanTime(run.startedAt, tz)}</dd>
          </>
        ) : null}
        {run.completedAt ? (
          <>
            <dt>All done at</dt>
            <dd>{scanTime(run.completedAt, tz)}</dd>
          </>
        ) : null}
        <dt>Order</dt>
        <dd>
          {detail.enforceOrder ? 'Enforced: scans out of order count, but are flagged' : 'Guidance only'}
        </dd>
      </dl>
      <h3>Checkpoints in route order</h3>
      {detail.checkpoints.length === 0 ? (
        <div className="empty">This route has no checkpoints.</div>
      ) : (
        <ol className="plain-list">
          {detail.checkpoints.map((c) => {
            const state = stopState(c.done, c.required, run.status);
            return (
              <li key={c.checkpointId}>
                {c.name}
                {c.required ? null : <span className="faint"> (optional)</span>}{' '}
                <span className={`badge ${state.badge}`}>{state.label}</span>
                {c.location ? null : (
                  <div className="faint">No position: its scans can only be “QR only”.</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <h3>Scans in this round ({detail.visits.length})</h3>
      {detail.visits.length === 0 ? (
        <div className="empty">No scans yet.</div>
      ) : (
        <VisitsTable visits={detail.visits} timezone={tz} />
      )}
    </div>
  );
}

/** Scans with their outcome in words; `rounds` names the round each one counted toward. */
export function VisitsTable({
  visits,
  timezone,
  rounds,
}: {
  visits: readonly CheckpointVisit[];
  timezone: string;
  rounds?: ReadonlyMap<string, string>;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time (site time)</th>
            <th>Checkpoint</th>
            <th>Result</th>
            <th>Distance</th>
            <th>Accuracy</th>
            {rounds ? <th>Round</th> : null}
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((v) => {
            const detail = outcomeDetail(v);
            const notes = [flagsText(v.flags), v.late ? 'sent late' : ''].filter(Boolean).join(' · ');
            return (
              <tr key={v.id}>
                <td className="mono">{scanTime(v.scannedAt, timezone)}</td>
                <td>{v.checkpoint ? v.checkpoint.name : <span className="faint">Unknown label</span>}</td>
                <td>
                  <span className={`badge ${OUTCOME_BADGE[v.outcome]}`}>{OUTCOME_LABEL[v.outcome]}</span>
                  {detail ? <div className="faint">{detail}</div> : null}
                </td>
                <td>{v.distanceM !== null ? `${v.distanceM} m` : '—'}</td>
                <td>{v.accuracyM !== null ? `±${Math.round(v.accuracyM)} m` : '—'}</td>
                {rounds ? (
                  <td className="faint">{(v.runId && rounds.get(v.runId)) || 'not in a round'}</td>
                ) : null}
                <td
                  className="faint"
                  title={
                    v.late
                      ? 'Reached the server more than 5 minutes after the scan, usually because the phone was offline.'
                      : undefined
                  }
                >
                  {notes || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
