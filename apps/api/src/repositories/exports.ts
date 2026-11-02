// Export jobs (PROD §15.2): queued by a request, built by the worker, deleted after 7 days.
import type { ExportKind, ExportStatus } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';

export type ExportRow = {
  readonly id: string;
  readonly requestedBy: string;
  readonly requestedByName: string;
  readonly kind: ExportKind;
  readonly params: Record<string, unknown>;
  readonly title: string;
  readonly containsLocation: boolean;
  readonly status: ExportStatus;
  readonly rowCount: number | null;
  readonly sizeBytes: number | null;
  readonly objectKey: string | null;
  readonly contentType: string | null;
  readonly fileName: string | null;
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly expiresAt: Date | null;
};

function exportQuery(trx: Database, organizationId: string) {
  return trx
    .selectFrom('export_jobs as e')
    .leftJoin('users as u', 'u.id', 'e.requested_by')
    .select([
      'e.id',
      'e.requested_by',
      'u.name as requested_by_name',
      'e.kind',
      'e.params',
      'e.title',
      'e.contains_location',
      'e.status',
      'e.row_count',
      'e.size_bytes',
      'e.object_key',
      'e.content_type',
      'e.file_name',
      'e.error_code',
      'e.attempts',
      'e.created_at',
      'e.started_at',
      'e.finished_at',
      'e.expires_at',
    ])
    .where('e.organization_id', '=', organizationId);
}

type Raw = Awaited<ReturnType<ReturnType<typeof exportQuery>['executeTakeFirstOrThrow']>>;

function toRow(r: Raw): ExportRow {
  return {
    id: r.id,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name ?? '',
    kind: r.kind as ExportKind,
    params: (r.params ?? {}) as Record<string, unknown>,
    title: r.title,
    containsLocation: r.contains_location,
    status: r.status as ExportStatus,
    rowCount: r.row_count,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    objectKey: r.object_key,
    contentType: r.content_type,
    fileName: r.file_name,
    errorCode: r.error_code,
    attempts: r.attempts,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    expiresAt: r.expires_at,
  };
}

/** False when the person already has an export queued or running (one at a time, PROD §15.2). */
export async function insertExport(
  trx: Database,
  e: {
    readonly id: string;
    readonly organizationId: string;
    readonly requestedBy: string;
    readonly kind: ExportKind;
    readonly params: Record<string, unknown>;
    readonly title: string;
    readonly containsLocation: boolean;
    readonly at: Date;
  },
): Promise<boolean> {
  const inserted = await trx
    .insertInto('export_jobs')
    .values({
      id: e.id,
      organization_id: e.organizationId,
      requested_by: e.requestedBy,
      kind: e.kind,
      params: JSON.stringify(e.params),
      title: e.title.slice(0, 300),
      contains_location: e.containsLocation,
      status: 'QUEUED',
      created_at: e.at,
      updated_at: e.at,
    })
    .onConflict((oc) =>
      oc
        .columns(['organization_id', 'requested_by'])
        .where('status', 'in', ['QUEUED', 'RUNNING'])
        .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}

export async function getExport(
  trx: Database,
  organizationId: string,
  id: string,
): Promise<ExportRow | null> {
  const row = await exportQuery(trx, organizationId).where('e.id', '=', id).executeTakeFirst();
  return row ? toRow(row) : null;
}

/** The newest exports first. */
export async function listExports(
  trx: Database,
  organizationId: string,
  limit: number,
): Promise<ExportRow[]> {
  const rows = await exportQuery(trx, organizationId)
    .orderBy('e.created_at', 'desc')
    .orderBy('e.id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toRow);
}

/** The oldest queued export, marked RUNNING; another worker skips it while it is locked. */
export async function claimNextExport(
  trx: Database,
  organizationId: string,
  now: Date,
): Promise<ExportRow | null> {
  const next = await trx
    .selectFrom('export_jobs')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('status', '=', 'QUEUED')
    .orderBy('created_at')
    .limit(1)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (!next) return null;
  await trx
    .updateTable('export_jobs')
    .set((eb) => ({ status: 'RUNNING', started_at: now, attempts: eb('attempts', '+', 1), updated_at: now }))
    .where('organization_id', '=', organizationId)
    .where('id', '=', next.id)
    .execute();
  return getExport(trx, organizationId, next.id);
}

export async function finishExport(
  trx: Database,
  organizationId: string,
  id: string,
  patch:
    | {
        readonly status: 'READY';
        readonly objectKey: string;
        readonly contentType: string;
        readonly fileName: string;
        readonly rowCount: number;
        readonly sizeBytes: number;
        readonly expiresAt: Date;
      }
    | { readonly status: 'FAILED'; readonly errorCode: string }
    | { readonly status: 'EXPIRED' }
    | { readonly status: 'QUEUED' },
  now: Date,
): Promise<void> {
  await trx
    .updateTable('export_jobs')
    .set({
      status: patch.status,
      updated_at: now,
      ...(patch.status === 'READY'
        ? {
            object_key: patch.objectKey,
            content_type: patch.contentType,
            file_name: patch.fileName,
            row_count: patch.rowCount,
            size_bytes: patch.sizeBytes,
            expires_at: patch.expiresAt,
            finished_at: now,
            error_code: null,
          }
        : {}),
      ...(patch.status === 'FAILED' ? { error_code: patch.errorCode.slice(0, 60), finished_at: now } : {}),
      ...(patch.status === 'QUEUED' ? { started_at: null } : {}),
    })
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .execute();
}

/** Ready exports whose 7 days are over (their files are deleted next). */
export async function exportsToExpire(
  trx: Database,
  organizationId: string,
  now: Date,
): Promise<ExportRow[]> {
  const rows = await exportQuery(trx, organizationId)
    .where('e.status', '=', 'READY')
    .where('e.expires_at', '<=', now)
    .limit(100)
    .execute();
  return rows.map(toRow);
}

/** Exports a crashed worker left RUNNING. */
export async function stuckExports(
  trx: Database,
  organizationId: string,
  startedBefore: Date,
): Promise<ExportRow[]> {
  const rows = await exportQuery(trx, organizationId)
    .where('e.status', '=', 'RUNNING')
    .where('e.started_at', '<', startedBefore)
    .limit(100)
    .execute();
  return rows.map(toRow);
}

/** The sweep (system_worker): organizations with an export to build, rescue or delete. */
export async function organizationsWithExportWork(
  sweep: Database,
  now: Date,
  stuckBefore: Date,
): Promise<string[]> {
  const rows = await sweep
    .selectFrom('export_jobs')
    .select('organization_id')
    .where((eb) =>
      eb.or([
        eb('status', '=', 'QUEUED'),
        eb.and([eb('status', '=', 'RUNNING'), eb('started_at', '<', stuckBefore)]),
        eb.and([eb('status', '=', 'READY'), eb('expires_at', '<=', now)]),
      ]),
    )
    .distinct()
    .execute();
  return rows.map((r) => r.organization_id);
}
