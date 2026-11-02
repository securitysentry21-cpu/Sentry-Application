'use client';

// Exports (PROD §15.2): the organization's exports this person may see, newest first, each with its
// status in words, its size and when its file is deleted. A ready one downloads through a link that
// works for 15 minutes; a file holding location asks for the reason first (SEC §16.4, D-21), and the
// server records every download in the audit log. The list follows the live stream (export.updated,
// and a resync); while one is still being prepared it is also looked at every 30 seconds, in case the
// stream is down. When one the person asked for becomes ready, a notice says so. Plain text only
// (ADV-W01); phone-width friendly (D-04).
import type { ExportJob } from '@sentryops/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ExportNotice, ExportsTable, ReasonDialog } from '../../../components/exports';
import { PageHead } from '../../../components/shell';
import { Toast } from '../../../components/ui';
import { api, errorText } from '../../../lib/api';
import {
  describeExportError,
  EXPORT_FILE_DAYS,
  EXPORT_KIND_LABEL,
  EXPORT_LINK_MINUTES,
  isPending,
  isWebLink,
  mayOpenExports,
  newlyReady,
  readyMessage,
  type ExportFailure,
} from '../../../lib/exports';
import { useReloadOn } from '../../../lib/live';
import { useSession } from '../../../lib/session';

/** Only while an export is queued or running, and only as a fallback for the live stream. */
const PENDING_REFRESH_MS = 30_000;

type SignedLink = { url: string; expiresAt: string };

export default function ExportsPage() {
  const { membership } = useSession();
  // A new organization starts from a clean page: no list or notice of the previous one.
  return <Exports key={membership.organizationId} />;
}

function Exports() {
  const { can, me, membership } = useSession();
  const tz = membership.organizationTimezone;
  const allowed = mayOpenExports(can);
  // Whichever ID the server names the requester by, the person's own exports are recognised.
  const mine = useMemo(() => [me.user.id, membership.memberId], [me.user.id, membership.memberId]);
  const [exports, setExports] = useState<ExportJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ n: number; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The export whose download asks for the reason first.
  const [asking, setAsking] = useState<ExportJob | null>(null);
  const [askFailure, setAskFailure] = useState<ExportFailure | null>(null);
  const [reasonRequired, setReasonRequired] = useState(false);
  const last = useRef<ExportJob[] | null>(null);
  const announced = useRef(new Set<string>());
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!allowed) return;
    const n = ++seq.current;
    try {
      const list = (await api<{ exports: ExportJob[] }>('/exports')).exports;
      if (n !== seq.current) return; // a newer list is on its way
      const ready = newlyReady(last.current, list, mine).filter((j) => !announced.current.has(j.id));
      for (const j of ready) announced.current.add(j.id);
      last.current = list;
      setExports(list);
      setError(null);
      if (ready.length > 0) setToast((t) => ({ n: (t?.n ?? 0) + 1, text: readyMessage(ready) }));
    } catch (e) {
      if (n === seq.current) setError(errorText(e));
    }
  }, [allowed, mine]);

  useEffect(() => {
    void load();
  }, [load]);

  // The event only says which export changed; the list says what this person may see of it.
  useReloadOn((e) => e.type === 'export.updated' || e.type === 'resync', load);

  const pending = exports?.some(isPending) ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, PENDING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [pending, load]);

  /** POST /exports/:id/download, then to the signed link: served as a download, the page stays. */
  const download = async (job: ExportJob, reason: string, inDialog: boolean) => {
    setBusyId(job.id);
    setError(null);
    setAskFailure(null);
    try {
      const link = await api<SignedLink>(`/exports/${encodeURIComponent(job.id)}/download`, {
        method: 'POST',
        body: reason ? { reason } : {},
      });
      if (!isWebLink(link.url)) throw new Error('not a web link');
      setAsking(null);
      window.location.assign(link.url);
    } catch (e) {
      const failure = describeExportError(e);
      const gone = failure.code === 'EXPORT_EXPIRED' || failure.code === 'EXPORT_NOT_READY';
      if (failure.reasonRequired) {
        // The organization requires a reason (D-21): ask for it, with the server's words.
        setReasonRequired(true);
        setAsking(job);
        setAskFailure(failure);
      } else if (inDialog && !gone) {
        setAskFailure(failure);
      } else {
        setAsking(null);
        setError(failure.text);
      }
      if (gone) void load();
    } finally {
      setBusyId(null);
    }
  };

  const onDownload = (job: ExportJob) => {
    if (job.containsLocation) {
      setAskFailure(null);
      setAsking(job);
    } else {
      void download(job, '', false);
    }
  };

  if (!allowed) return <div className="banner error">Your role can’t export.</div>;

  return (
    <>
      <PageHead
        title="Exports"
        description={`CSV files of your organization, newest first. A file is deleted ${EXPORT_FILE_DAYS} days after it is ready, and a download link works for ${EXPORT_LINK_MINUTES} minutes. Every download is recorded in the audit log.`}
      />
      {error ? (
        <div className="banner error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="card">
        {exports === null ? (
          <div className="loading">Loading…</div>
        ) : exports.length === 0 ? (
          <div className="empty">
            No exports yet. Start one from Reports, or from a guard’s location history.
          </div>
        ) : (
          <ExportsTable exports={exports} timeZone={tz} mine={mine} busyId={busyId} onDownload={onDownload} />
        )}
        <p className="faint">
          Times are in {tz}. Each person runs one export at a time; the list updates by itself.
        </p>
      </div>
      {asking ? (
        <ReasonDialog
          title={`Download: ${EXPORT_KIND_LABEL[asking.kind]}`}
          confirmLabel="Download"
          busy={busyId === asking.id}
          reasonRequired={reasonRequired}
          reasonMessage={askFailure?.reasonRequired ? askFailure.text : null}
          failure={
            askFailure && !askFailure.reasonRequired ? (
              <ExportNotice status={{ state: 'failed', ...askFailure }} />
            ) : null
          }
          placeholder="For example: monthly report for the client"
          onConfirm={(reason) => void download(asking, reason, true)}
          onClose={() => setAsking(null)}
        >
          <p className="prewrap">{asking.title}</p>
          <p className="muted">
            This file holds location history. Downloading it is recorded in the audit log, with your name and
            your reason.
          </p>
        </ReasonDialog>
      ) : null}
      {toast ? (
        <Toast key={toast.n} onClose={() => setToast(null)}>
          {toast.text}
        </Toast>
      ) : null}
    </>
  );
}
