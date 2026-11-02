// Exports (PROD §15.2): requested in the dashboard, built in the background, downloaded through a
// 15-minute link, deleted after 7 days. Owner decision 2026-11-02: anyone allowed to export may
// download the organization's exports, within each kind's own rule (SEC wins): a guard's data only
// with `exports.guard_data` (SEC §16.6); anything holding location only with location-history access,
// and with the reason when the organization requires one (SEC §16.4, D-21). Requests and downloads
// are audited; a location export also counts as location-history access (LOCATION_HISTORY_EXPORTED).
import {
  EXPORT_FILE_DAYS,
  EXPORT_LINK_TTL_S,
  LOCATION_EXPORT_KINDS,
  REPORT_MAX_DAYS,
  exportRequestSchema,
  type ExportJob,
  type ExportKind,
  type ExportRequest,
} from '@sentryops/contracts';
import { withTenantTransaction, type Database } from '@sentryops/db';
import { localRange } from '@sentryops/domain';

import { auditActor, can, orgOf, userOf, type RequestContext } from '../context.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, forbidden, notFound } from '../errors.ts';
import { buildExportFile } from '../exports/files.ts';
import { uuidv7 } from '../ids.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  claimNextExport,
  exportsToExpire,
  finishExport,
  getExport,
  insertExport,
  listExports,
  stuckExports,
  type ExportRow,
} from '../repositories/exports.ts';
import { getGuard } from '../repositories/guards.ts';
import { getOrganization, organizationSettings } from '../repositories/organizations.ts';
import { getShift } from '../repositories/shifts.ts';
import { getSite } from '../repositories/sites.ts';
import { publish } from './realtime.ts';
import { reportScope } from './reports.ts';

const DAY_MS = 86_400_000;
/** A running export older than this was left by a worker that stopped; it is tried again. */
export const EXPORT_STUCK_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
const LIST_LIMIT = 200;

const KIND_TITLES: Readonly<Record<ExportKind, string>> = {
  ATTENDANCE: 'Attendance',
  PATROLS: 'Patrols',
  INCIDENTS: 'Incidents',
  SITE_ACTIVITY: 'Site activity',
  LOCATION_REPORT: 'Location report',
  LOCATION_HISTORY: 'Location history',
  GUARD_DATA: "Guard's data",
};

export const holdsLocation = (kind: ExportKind): boolean => LOCATION_EXPORT_KINDS.includes(kind);

/** May this person request, see and download this kind of export? */
export function mayUseExport(ctx: RequestContext, kind: ExportKind): boolean {
  if (kind === 'GUARD_DATA') return can(ctx, 'exports.guard_data') && can(ctx, 'location.history.read');
  if (!can(ctx, 'exports.create')) return false;
  return holdsLocation(kind) ? can(ctx, 'location.history.read') : true;
}

/** D-21: the reason is always offered for location; the organization may make it mandatory. */
async function requireReason(
  trx: Database,
  organizationId: string,
  reason: string | undefined,
): Promise<string | null> {
  const given = reason?.trim() || null;
  const settings = await organizationSettings(trx, organizationId);
  if (settings['privacy.require_history_access_reason'] === true && !given) {
    throw new AppError('VALIDATION_FAILED', 'Your organization asks for a reason to view location history.', [
      { path: 'reason', issue: 'required' },
    ]);
  }
  return given;
}

export function exportDto(e: ExportRow): ExportJob {
  return {
    id: e.id,
    kind: e.kind,
    status: e.status,
    title: e.title,
    requestedBy: { id: e.requestedBy, name: e.requestedByName },
    containsLocation: e.containsLocation,
    rowCount: e.rowCount,
    sizeBytes: e.sizeBytes,
    fileName: e.fileName,
    createdAt: e.createdAt.toISOString(),
    finishedAt: e.finishedAt?.toISOString() ?? null,
    expiresAt: e.expiresAt?.toISOString() ?? null,
    errorCode: e.errorCode,
  };
}

/**
 * Checks what was asked for (every ID must be this organization's: anything else is not found,
 * ADV-T03) and says it in words for the list.
 */
async function describe(trx: Database, organizationId: string, request: ExportRequest): Promise<string> {
  const kind = KIND_TITLES[request.kind];
  switch (request.kind) {
    case 'GUARD_DATA': {
      const guard = await getGuard(trx, organizationId, request.guardId);
      if (!guard) throw notFound();
      return `${kind} · ${guard.displayName} (${guard.employeeNumber})`;
    }
    case 'LOCATION_HISTORY': {
      const guard = await getGuard(trx, organizationId, request.guardId);
      if (!guard) throw notFound();
      if (request.shiftId) {
        const shift = await getShift(trx, organizationId, request.shiftId);
        if (!shift || shift.guardId !== guard.id) throw notFound();
        return `${kind} · ${guard.displayName} · shift of ${shift.startsAt.toISOString().slice(0, 10)} · ${shift.siteName}`;
      }
      if (!request.from || !request.to) {
        throw new AppError('VALIDATION_FAILED', 'A location export needs a shift, or "from" and "to".', [
          { path: request.from ? 'to' : 'from', issue: 'required' },
        ]);
      }
      const timezone = (await getOrganization(trx, organizationId))?.timezone ?? 'Asia/Karachi';
      const range = localRange(request.from, request.to, timezone);
      if (!Number.isFinite(range.days) || range.days < 1) {
        throw new AppError('VALIDATION_FAILED', '"to" must not be before "from".');
      }
      if (range.days > REPORT_MAX_DAYS) {
        throw new AppError('EXPORT_RANGE_TOO_LARGE', `At most ${REPORT_MAX_DAYS} days per report or export.`);
      }
      return `${kind} · ${guard.displayName} · ${request.from} to ${request.to}`;
    }
    default: {
      const scope = await reportScope(trx, organizationId, request);
      const parts = [kind, `${scope.from} to ${scope.to}`];
      if (scope.siteId) parts.push((await getSite(trx, organizationId, scope.siteId))?.name ?? '');
      if (scope.guardId) parts.push((await getGuard(trx, organizationId, scope.guardId))?.displayName ?? '');
      return parts.join(' · ');
    }
  }
}

/** POST /exports: checked, audited and queued; the worker builds it. */
export async function requestExport(
  deps: AppDeps,
  ctx: RequestContext,
  request: ExportRequest,
): Promise<ExportJob> {
  if (!mayUseExport(ctx, request.kind)) throw forbidden();
  const org = orgOf(ctx);
  const user = userOf(ctx);
  const now = deps.clock.now();
  const id = uuidv7(deps.clock);
  const located = holdsLocation(request.kind);
  return withTenantTransaction(deps.db, org.id, async (trx) => {
    const title = await describe(trx, org.id, request);
    const reason = located
      ? await requireReason(trx, org.id, 'reason' in request ? request.reason : undefined)
      : null;
    // The reason belongs in the audit log, not in the job.
    const { reason: _reason, ...params } = request as ExportRequest & { reason?: string };
    const queued = await insertExport(trx, {
      id,
      organizationId: org.id,
      requestedBy: user.userId,
      kind: request.kind,
      params,
      title,
      containsLocation: located,
      at: now,
    });
    if (!queued) {
      throw new AppError(
        'EXPORT_ALREADY_RUNNING',
        'Your previous export is still running. Wait for it to finish.',
      );
    }
    const metadata = { exportId: id, kind: request.kind, ...summary(request) };
    await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
      action: 'EXPORT_REQUESTED',
      resourceType: 'export',
      resourceId: id,
      metadata,
    });
    if (located) {
      // INV-14: reading location history, recorded before anything is read.
      const guardId = 'guardId' in params && typeof params.guardId === 'string' ? params.guardId : null;
      await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
        action: 'LOCATION_HISTORY_EXPORTED',
        resourceType: guardId ? 'guard' : 'export',
        resourceId: guardId ?? id,
        reason,
        metadata,
      });
    }
    await publish(trx, deps, org.id, 'export.updated', { exportId: id });
    const row = await getExport(trx, org.id, id);
    if (!row) throw new Error('export vanished');
    return exportDto(row);
  });
}

/** What the audit row keeps of a request: IDs and dates only. */
function summary(request: ExportRequest): Record<string, string | null> {
  return {
    from: 'from' in request ? (request.from ?? null) : null,
    to: 'to' in request ? (request.to ?? null) : null,
    siteId: 'siteId' in request ? (request.siteId ?? null) : null,
    guardId: 'guardId' in request ? (request.guardId ?? null) : null,
    shiftId: 'shiftId' in request ? (request.shiftId ?? null) : null,
  };
}

export async function exportsFor(deps: AppDeps, ctx: RequestContext): Promise<ExportJob[]> {
  const org = orgOf(ctx);
  const rows = await withTenantTransaction(deps.db, org.id, (trx) => listExports(trx, org.id, LIST_LIMIT));
  return rows.filter((e) => mayUseExport(ctx, e.kind)).map(exportDto);
}

export async function exportFor(deps: AppDeps, ctx: RequestContext, id: string): Promise<ExportJob> {
  const org = orgOf(ctx);
  const row = await withTenantTransaction(deps.db, org.id, (trx) => getExport(trx, org.id, id));
  if (!row || !mayUseExport(ctx, row.kind)) throw notFound();
  return exportDto(row);
}

/** POST /exports/:id/download: a new read, audited (EXPORT_DOWNLOADED), with the reason for location. */
export async function downloadLink(
  deps: AppDeps,
  ctx: RequestContext,
  id: string,
  reason: string | undefined,
): Promise<{ url: string; expiresAt: string }> {
  const org = orgOf(ctx);
  return withTenantTransaction(deps.db, org.id, async (trx) => {
    const row = await getExport(trx, org.id, id);
    if (!row || !mayUseExport(ctx, row.kind)) throw notFound();
    if (row.status === 'EXPIRED')
      throw new AppError('EXPORT_EXPIRED', 'This export was deleted after 7 days.');
    if (row.status !== 'READY' || !row.objectKey) {
      throw new AppError('EXPORT_NOT_READY', 'This export is not ready.');
    }
    const given = row.containsLocation ? await requireReason(trx, org.id, reason) : null;
    await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
      action: 'EXPORT_DOWNLOADED',
      resourceType: 'export',
      resourceId: row.id,
      reason: given,
      metadata: { kind: row.kind, containsLocation: row.containsLocation },
    });
    const link = await deps.objects.signDownload(row.objectKey, EXPORT_LINK_TTL_S, row.fileName ?? undefined);
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  });
}

// ── The worker's side ───────────────────────────────────────────────────────────────────────

export const exportObjectKey = (organizationId: string, id: string, contentType: string) =>
  `exports/${organizationId}/${id}.${contentType === 'application/zip' ? 'zip' : 'csv'}`;

/** Builds every queued export of the organization, one at a time; returns how many finished. */
export async function runQueuedExports(deps: AppDeps, organizationId: string): Promise<number> {
  let done = 0;
  for (;;) {
    const now = deps.clock.now();
    const job = await withTenantTransaction(deps.db, organizationId, (trx) =>
      claimNextExport(trx, organizationId, now),
    );
    if (!job) return done;
    try {
      const request = exportRequestSchema.parse(job.params);
      const file = await withTenantTransaction(deps.db, organizationId, async (trx) =>
        buildExportFile(trx, organizationId, request, await organizationSettings(trx, organizationId), now),
      );
      const key = exportObjectKey(organizationId, job.id, file.contentType);
      await deps.objects.write(key, file.body, file.contentType);
      await withTenantTransaction(deps.db, organizationId, async (trx) => {
        const finished = deps.clock.now();
        await finishExport(
          trx,
          organizationId,
          job.id,
          {
            status: 'READY',
            objectKey: key,
            contentType: file.contentType,
            fileName: file.fileName,
            rowCount: file.rowCount,
            sizeBytes: file.body.length,
            expiresAt: new Date(finished.getTime() + EXPORT_FILE_DAYS * DAY_MS),
          },
          finished,
        );
        await publish(trx, deps, organizationId, 'export.updated', { exportId: job.id });
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      await withTenantTransaction(deps.db, organizationId, async (trx) => {
        await finishExport(
          trx,
          organizationId,
          job.id,
          { status: 'FAILED', errorCode: code },
          deps.clock.now(),
        );
        await publish(trx, deps, organizationId, 'export.updated', { exportId: job.id });
      });
    }
    done++;
  }
}

/** Files older than 7 days are deleted (PROD §15.2); exports a stopped worker left are tried again. */
export async function tidyExports(
  deps: AppDeps,
  organizationId: string,
): Promise<{ expired: number; retried: number }> {
  const now = deps.clock.now();
  let expired = 0;
  let retried = 0;
  const due = await withTenantTransaction(deps.db, organizationId, (trx) =>
    exportsToExpire(trx, organizationId, now),
  );
  for (const e of due) {
    if (e.objectKey) await deps.objects.delete(e.objectKey);
    await withTenantTransaction(deps.db, organizationId, async (trx) => {
      await finishExport(trx, organizationId, e.id, { status: 'EXPIRED' }, now);
      await publish(trx, deps, organizationId, 'export.updated', { exportId: e.id });
    });
    expired++;
  }
  const stuck = await withTenantTransaction(deps.db, organizationId, (trx) =>
    stuckExports(trx, organizationId, new Date(now.getTime() - EXPORT_STUCK_MS)),
  );
  for (const e of stuck) {
    await withTenantTransaction(deps.db, organizationId, async (trx) => {
      await finishExport(
        trx,
        organizationId,
        e.id,
        e.attempts >= MAX_ATTEMPTS ? { status: 'FAILED', errorCode: 'INTERNAL_ERROR' } : { status: 'QUEUED' },
        now,
      );
      await publish(trx, deps, organizationId, 'export.updated', { exportId: e.id });
    });
    retried++;
  }
  return { expired, retried };
}
