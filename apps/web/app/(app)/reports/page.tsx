'use client';

// Reports (PROD §15.1): attendance, patrols, incidents, location and site activity, for inclusive
// local dates, at most 92 days: the site's time zone for one site, the organization's otherwise
// (ADV-TM02); each report says which it used. The tab and the filters live in the address; the
// reason for the location report never does. The location report reads location history (SEC
// §16.4), so it loads only when asked, with the reason field always there (D-21); the server records
// every view in the audit log. "Export CSV" asks for the report on screen as a background export
// (PROD §15.2), found on the Exports page. Plain text only (ADV-W01); phone-width friendly (D-04).
import type { Guard, Site } from '@sentryops/contracts';
import { localDate } from '@sentryops/domain';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { ExportNotice, useStartExport } from '../../../components/exports';
import {
  AttendanceTable,
  IncidentReportTable,
  LocationReportTable,
  PatrolReportTable,
  SiteActivityTable,
} from '../../../components/reports';
import { PageHead } from '../../../components/shell';
import { api, ApiError, errorText } from '../../../lib/api';
import { canExport } from '../../../lib/exports';
import {
  exportRequest,
  filtersHref,
  filtersKey,
  isReasonRequired,
  periodText,
  rangeProblem,
  readFilters,
  REASON_MAX,
  REPORT_MAX_DAYS,
  reportQuery,
  reportStats,
  tabDef,
  visibleTabs,
  type Report,
  type ReportFilters,
  type ShownReport,
  type TabDef,
} from '../../../lib/reports';
import { useSession } from '../../../lib/session';

export default function ReportsPage() {
  const { membership } = useSession();
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      {/* A new organization starts from a clean page: no report or reason of the previous one. */}
      <Reports key={membership.organizationId} />
    </Suspense>
  );
}

type Failure = { readonly key: string; readonly text: string; readonly reasonRequired: boolean };

function Reports() {
  const { can, membership } = useSession();
  const tz = membership.organizationTimezone;
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tabs = useMemo(() => visibleTabs(can), [can]);
  const today = localDate(new Date(), tz);
  const applied = useMemo(() => readFilters(search, today, tabs), [search, today, tabs]);
  const key = filtersKey(applied);
  const tab = tabDef(applied.tab);
  const [sites, setSites] = useState<Site[]>([]);
  const [guards, setGuards] = useState<Guard[]>([]);
  const [shown, setShown] = useState<ShownReport | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(false);
  // The location report's reason: given on the page, never kept in the address (D-21).
  const [reason, setReason] = useState('');
  const [reasonRequired, setReasonRequired] = useState(false);
  const exporting = useStartExport();
  const { reset: resetExport } = exporting;
  const seq = useRef(0);

  const load = useCallback(async (filters: ReportFilters, why: string) => {
    const reportKey = filtersKey(filters);
    const n = ++seq.current;
    setLoading(true);
    try {
      const report = await api<Report<unknown>>(
        `/reports/${tabDef(filters.tab).path}?${reportQuery(filters, why)}`,
      );
      if (n !== seq.current) return; // a newer report is on its way
      setShown({ tab: filters.tab, key: reportKey, filters, reason: why, report } as ShownReport);
      setFailure(null);
    } catch (e) {
      if (n !== seq.current) return;
      const required = isReasonRequired(e);
      if (required) setReasonRequired(true);
      setFailure({
        key: reportKey,
        // The server's own words go under the reason field.
        text: required && e instanceof ApiError ? e.message : errorText(e),
        reasonRequired: required,
      });
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, []);

  // A report that doesn't read location history loads as soon as its filters are in the address.
  // `key` holds everything in `applied` that the report depends on.
  useEffect(() => {
    if (tabs.length === 0 || tab.audited) return;
    void load(applied, '');
  }, [key, tabs.length, tab.audited, load]);

  useEffect(() => {
    if (!can('sites.read')) return;
    void api<{ sites: Site[] }>('/sites')
      .then((r) => setSites([...r.sites].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => undefined);
  }, [can]);

  useEffect(() => {
    if (!can('guards.read')) return;
    void api<{ guards: Guard[] }>('/guards')
      .then((r) => setGuards([...r.guards].sort((a, b) => a.displayName.localeCompare(b.displayName))))
      .catch(() => undefined);
  }, [can]);

  const current = shown?.key === key ? shown : null;
  const currentFailure = failure?.key === key ? failure : null;

  // An export notice belongs to the report it was asked for.
  useEffect(() => {
    resetExport();
  }, [current?.key, resetExport]);

  function apply(next: ReportFilters, why: string) {
    setReason(why);
    const nextKey = filtersKey(next);
    if (nextKey !== key) router.replace(filtersHref(pathname, next, today), { scroll: false });
    // The location report loads only on request; any report shows again with the same filters.
    if (tabDef(next.tab).audited || nextKey === key) void load(next, why);
  }

  if (tabs.length === 0) return <div className="banner error">Your role can’t view reports.</div>;

  const stats = current ? reportStats(current) : null;
  const exportable = canExport(tab.kind, can);

  return (
    <>
      <PageHead
        title="Reports"
        description={`Inclusive dates, at most ${REPORT_MAX_DAYS} days, in the site’s time zone for one site and the organization’s for all.`}
      />
      <nav className="tabs" aria-label="Reports">
        {tabs.map((id) => (
          <Link
            key={id}
            href={filtersHref(pathname, { ...applied, tab: id }, today)}
            replace
            scroll={false}
            aria-current={id === applied.tab ? 'page' : undefined}
          >
            {tabDef(id).label}
          </Link>
        ))}
      </nav>
      <p className="muted">{tab.description}</p>
      <FilterForm
        key={key}
        initial={applied}
        tab={tab}
        sites={sites}
        guards={guards}
        reason={reason}
        reasonRequired={reasonRequired}
        reasonMessage={currentFailure?.reasonRequired ? currentFailure.text : null}
        busy={loading}
        onApply={apply}
      />
      {stats ? (
        <div className="grid cols-3">
          {stats.map((s) => (
            <div key={s.label} className={`card stat${s.tone ? ` tone-${s.tone}` : ''}`}>
              <span className="label">{s.label}</span>
              <span className="value">{s.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="card">
        <div className="card-head">
          <h2>
            {tab.label} <span className="faint">· {periodText(applied.from, applied.to)}</span>
          </h2>
          {exportable ? (
            <button
              type="button"
              className="btn"
              disabled={!current || current.report.rows.length === 0 || exporting.status.state === 'busy'}
              onClick={() => {
                if (current) void exporting.start(exportRequest(current.filters, current.reason));
              }}
            >
              {exporting.status.state === 'busy' ? 'Starting…' : 'Export CSV'}
            </button>
          ) : null}
        </div>
        <ExportNotice status={exporting.status} />
        {current?.report.truncated ? (
          <div className="banner warn" role="status">
            More than one report holds: this shows only part of the period. Narrow the range.
          </div>
        ) : null}
        {current ? <p className="faint">Times are in {current.report.timezone}.</p> : null}
        {currentFailure && !currentFailure.reasonRequired ? (
          <div className="banner error" role="alert">
            {currentFailure.text}
          </div>
        ) : current ? (
          current.report.rows.length === 0 ? (
            <div className="empty">{tab.empty}</div>
          ) : (
            <ReportTable shown={current} linkIncidents={can('incidents.read')} />
          )
        ) : tab.audited && !loading ? (
          <div className="empty">
            {currentFailure?.reasonRequired
              ? 'Give a reason above, then show the report.'
              : 'Choose the dates, then show the report. Nothing loads until you ask.'}
          </div>
        ) : (
          <div className="loading">Loading…</div>
        )}
      </div>
    </>
  );
}

function ReportTable({ shown, linkIncidents }: { shown: ShownReport; linkIncidents: boolean }) {
  const tz = shown.report.timezone;
  switch (shown.tab) {
    case 'attendance':
      return <AttendanceTable rows={shown.report.rows} timeZone={tz} />;
    case 'patrols':
      return <PatrolReportTable rows={shown.report.rows} timeZone={tz} />;
    case 'incidents':
      return <IncidentReportTable rows={shown.report.rows} timeZone={tz} linkIncidents={linkIncidents} />;
    case 'locations':
      return <LocationReportTable rows={shown.report.rows} timeZone={tz} />;
    case 'site-activity':
      return <SiteActivityTable rows={shown.report.rows} />;
  }
}

/**
 * The filters as a form: nothing applies until "Show", so a half-typed date never asks the server
 * for a report (and never records a location view the user didn't mean).
 */
function FilterForm({
  initial,
  tab,
  sites,
  guards,
  reason,
  reasonRequired,
  reasonMessage,
  busy,
  onApply,
}: {
  initial: ReportFilters;
  tab: TabDef;
  sites: readonly Site[];
  guards: readonly Guard[];
  reason: string;
  reasonRequired: boolean;
  reasonMessage: string | null;
  busy: boolean;
  onApply: (filters: ReportFilters, reason: string) => void;
}) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [siteId, setSiteId] = useState(initial.siteId);
  const [guardId, setGuardId] = useState(initial.guardId);
  const [drills, setDrills] = useState(initial.drills === 'include');
  const [why, setWhy] = useState(reason);
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const issue = rangeProblem(from, to);
    setProblem(issue);
    if (issue) return;
    onApply({ ...initial, from, to, siteId, guardId, drills: drills ? 'include' : 'exclude' }, why.trim());
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="row filters">
        <label className="field">
          <span>From</span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>To</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            required
          />
        </label>
        {sites.length > 0 ? (
          <label className="field">
            <span>Site</span>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">All sites</option>
              {siteId && !sites.some((s) => s.id === siteId) ? (
                <option value={siteId}>A site not in the list</option>
              ) : null}
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {tab.guardFilter && guards.length > 0 ? (
          <label className="field">
            <span>Guard</span>
            <select value={guardId} onChange={(e) => setGuardId(e.target.value)}>
              <option value="">All guards</option>
              {guardId && !guards.some((g) => g.id === guardId) ? (
                <option value={guardId}>A guard not in the list</option>
              ) : null}
              {guards.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.displayName} · {g.employeeNumber}
                  {g.status === 'ACTIVE' ? '' : ` (${g.status.toLowerCase()})`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {tab.id === 'incidents' ? (
          <label className="row">
            <input type="checkbox" checked={drills} onChange={(e) => setDrills(e.target.checked)} />
            Include drills
          </label>
        ) : null}
      </div>
      {tab.audited ? (
        <label className="field">
          <span>Reason{reasonRequired ? ' (required by your organization)' : ' (optional)'}</span>
          <input
            value={why}
            maxLength={REASON_MAX}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="For example: client complaint about the night shift"
            required={reasonRequired}
            aria-invalid={reasonMessage ? true : undefined}
          />
          {reasonMessage ? (
            <span className="error-text" role="alert">
              {reasonMessage}
            </span>
          ) : null}
        </label>
      ) : null}
      {problem ? <div className="banner error">{problem}</div> : null}
      <div className="row">
        <button className="btn primary" disabled={busy}>
          {busy ? 'Loading…' : tab.audited ? 'Show report' : 'Show'}
        </button>
        {tab.audited ? (
          <span className="faint">Viewing is recorded in the audit log, with your name and your reason.</span>
        ) : null}
      </div>
    </form>
  );
}
