// Resolving a scanned checkpoint label (ARCH §11.2 step 1). Unknown, rotated, archived and other
// organizations' labels all give the same answer, INVALID_QR, so a scan never reveals that a label
// exists elsewhere (ADV-T08, ADV-Q05). The scan pipeline (services/patrols.ts) builds on this.
import { withTenantTransaction, type Database } from '@sentryops/db';

import { checkpointTokenHash, parseCheckpointQr } from './auth/codes.ts';
import { checkpointByTokenHash, getCheckpoint, type CheckpointRow } from './repositories/sites.ts';

export type ScanResolution =
  | { readonly ok: true; readonly checkpoint: CheckpointRow }
  | { readonly ok: false; readonly code: 'INVALID_QR' };

export function resolveScannedCheckpoint(
  db: Database,
  organizationId: string,
  qrContent: string,
): Promise<ScanResolution> {
  return withTenantTransaction(db, organizationId, (trx) =>
    resolveCheckpoint(trx, organizationId, qrContent),
  );
}

/** The same, inside the caller's tenant transaction (the sync pipeline). */
export async function resolveCheckpoint(
  trx: Database,
  organizationId: string,
  qrContent: string,
): Promise<ScanResolution> {
  const invalid = { ok: false as const, code: 'INVALID_QR' as const };
  const token = parseCheckpointQr(qrContent);
  if (!token) return invalid;
  const found = await checkpointByTokenHash(trx, checkpointTokenHash(token));
  if (!found || found.organization_id !== organizationId) return invalid;
  const checkpoint = await getCheckpoint(trx, organizationId, found.id);
  if (!checkpoint || checkpoint.status !== 'ACTIVE') return invalid;
  return { ok: true, checkpoint };
}
