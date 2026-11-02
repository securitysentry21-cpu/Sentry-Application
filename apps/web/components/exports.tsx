'use client';

// Exports (PROD §15.2): the list, each export's status in words; starting one from a report, a guard's
// page or a location history; and the dialog that asks for the reason (D-21) before a guard's data is
// exported or a file holding location is downloaded (SEC §16.4, §16.6). Titles and names only ever
// render as text (SEC §8, ADV-W01).
import type { ExportJob, ExportRequest, ExportStatus } from '@sentryops/contracts';
import Link from 'next/link';
import { useCallback, useState, type ReactNode } from 'react';

import { api } from '../lib/api';
import {
  describeExportError,
  EXPORT_FILE_DAYS,
  EXPORT_KIND_LABEL,
  EXPORT_STATUS_BADGE,
  EXPORT_STATUS_LABEL,
  guardDataExport,
  statusDetail,
  type ExportFailure,
} from '../lib/exports';
import { formatDateTime } from '../lib/format';
import { REASON_MAX } from '../lib/reports';

export function ExportStatusBadge({ status }: { status: ExportStatus }) {
  return <span className={`badge ${EXPORT_STATUS_BADGE[status]}`}>{EXPORT_STATUS_LABEL[status]}</span>;
}

export function ExportsTable({
  exports,
  timeZone,
  mine,
  busyId,
  onDownload,
}: {
  exports: readonly ExportJob[];
  timeZone: string;
  /** The signed-in person's IDs: their own exports say so. */
  mine: readonly string[];
  /** The export whose link is being asked for. */
  busyId: string | null;
  onDownload: (job: ExportJob) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Export</th>
            <th>Status</th>
            <th>Created</th>
            <th>Deleted on</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {exports.map((j) => {
            const detail = statusDetail(j);
            return (
              <tr key={j.id}>
                <td>
                  <strong>{j.title}</strong>
                  <div className="faint">
                    {EXPORT_KIND_LABEL[j.kind]}
                    {j.containsLocation ? ' · contains location' : ''}
                  </div>
                  <div className="faint">
                    Requested by {j.requestedBy.name}
                    {mine.includes(j.requestedBy.id) ? ' (you)' : ''}
                  </div>
                </td>
                <td>
                  <ExportStatusBadge status={j.status} />
                  {detail ? <div className="faint">{detail}</div> : null}
                </td>
                <td>{formatDateTime(j.createdAt, timeZone)}</td>
                <td>{j.expiresAt ? formatDateTime(j.expiresAt, timeZone) : '—'}</td>
                <td>
                  {j.status === 'READY' ? (
                    <button
                      type="button"
                      className="btn small"
                      disabled={busyId !== null}
                      onClick={() => onDownload(j)}
                    >
                      {busyId === j.id ? 'Preparing…' : 'Download'}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export type StartState =
  | { readonly state: 'idle' }
  | { readonly state: 'busy' }
  | { readonly state: 'started'; readonly job: ExportJob }
  | ({ readonly state: 'failed' } & ExportFailure);

/**
 * POST /exports, and what came of it. Once the server has said the organization requires a reason,
 * `reasonRequired` stays true for the form.
 */
export function useStartExport() {
  const [status, setStatus] = useState<StartState>({ state: 'idle' });
  const [reasonRequired, setReasonRequired] = useState(false);
  const start = useCallback(async (request: ExportRequest): Promise<StartState> => {
    setStatus({ state: 'busy' });
    let next: StartState;
    try {
      const { export: job } = await api<{ export: ExportJob }>('/exports', { method: 'POST', body: request });
      next = { state: 'started', job };
    } catch (e) {
      next = { state: 'failed', ...describeExportError(e) };
      if (next.reasonRequired) setReasonRequired(true);
    }
    setStatus(next);
    return next;
  }, []);
  const reset = useCallback(() => setStatus({ state: 'idle' }), []);
  return { status, start, reset, reasonRequired };
}

/** Where a started export went, or why it was refused. */
export function ExportNotice({ status }: { status: StartState }) {
  if (status.state === 'started') {
    return (
      <div className="banner success" role="status">
        Export started — you’ll find it on the <Link href="/exports">Exports page</Link>.
      </div>
    );
  }
  if (status.state === 'failed') {
    return (
      <div className="banner error" role="alert">
        {status.text}
        {status.code === 'EXPORT_ALREADY_RUNNING' ? (
          <>
            {' '}
            <Link href="/exports">See the Exports page.</Link>
          </>
        ) : null}
      </div>
    );
  }
  return null;
}

/**
 * A small dialog with the reason field (D-21): optional, and required once the server says the
 * organization requires it, with the server's words under the field. `done` replaces the form once
 * the action succeeded.
 */
export function ReasonDialog({
  title,
  children,
  confirmLabel,
  busy,
  reasonRequired,
  reasonMessage,
  failure = null,
  done = null,
  placeholder,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  reasonRequired: boolean;
  reasonMessage: string | null;
  failure?: ReactNode;
  done?: ReactNode;
  placeholder: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reason-dialog-title"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2 id="reason-dialog-title">{title}</h2>
          <button type="button" className="btn small ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
        {done ?? (
          <form
            className="grid"
            onSubmit={(e) => {
              e.preventDefault();
              onConfirm(reason.trim());
            }}
          >
            <label className="field">
              <span>Reason{reasonRequired ? ' (required by your organization)' : ' (optional)'}</span>
              <input
                value={reason}
                maxLength={REASON_MAX}
                onChange={(e) => setReason(e.target.value)}
                placeholder={placeholder}
                required={reasonRequired}
                aria-invalid={reasonMessage ? true : undefined}
                autoFocus
              />
              {reasonMessage ? (
                <span className="error-text" role="alert">
                  {reasonMessage}
                </span>
              ) : null}
            </label>
            {failure}
            <div className="row">
              <button className="btn primary" disabled={busy}>
                {busy ? 'Working…' : confirmLabel}
              </button>
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * "Export this guard's data" (SEC §16.6, Owners and Administrators): their profile, shifts, location
 * history and the incidents they reported, as a ZIP of CSV files made in the background.
 */
export function GuardDataExport({
  guard,
  onClose,
}: {
  guard: { readonly id: string; readonly displayName: string };
  onClose: () => void;
}) {
  const { status, start, reasonRequired } = useStartExport();
  const failed = status.state === 'failed' ? status : null;
  return (
    <ReasonDialog
      title="Export this guard’s data"
      confirmLabel="Start export"
      busy={status.state === 'busy'}
      reasonRequired={reasonRequired}
      reasonMessage={failed?.reasonRequired ? failed.text : null}
      failure={failed && !failed.reasonRequired ? <ExportNotice status={failed} /> : null}
      done={status.state === 'started' ? <ExportNotice status={status} /> : null}
      placeholder="For example: the guard asked for a copy of their data"
      onConfirm={(reason) => void start(guardDataExport(guard.id, reason))}
      onClose={onClose}
    >
      <p>
        A ZIP of CSV files with <strong>{guard.displayName}</strong>’s profile, their shifts, their location
        history and the incidents they reported.
      </p>
      <p className="muted">
        It is prepared in the background. You’ll find it on the Exports page, where only Owners and
        Administrators can download it, for {EXPORT_FILE_DAYS} days. Asking for it and every download are
        recorded in the audit log, with your name and the reason.
      </p>
    </ReasonDialog>
  );
}
