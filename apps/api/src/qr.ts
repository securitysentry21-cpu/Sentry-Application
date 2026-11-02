// Resolving a scanned checkpoint label (ARCH §11.2 step 1). Unknown, rotated, archived and other
// organizations' labels all answer INVALID_QR, so a scan never reveals that a label exists elsewhere
// (ADV-T08, ADV-Q05). One of the organization's own replaced labels is marked `oldLabel`, so the
// guard is told "Old QR code — report to supervisor" (Q-22, PROD §5.4). The scan pipeline
// (services/patrols.ts) builds on this.
import { withTenantTransaction, type Database } from '@sentryops/db';

import { checkpointTokenHash, parseCheckpointQr } from './auth/codes.ts';
import {
  checkpointByTokenHash,
  getCheckpoint,
  isRetiredLabel,
  type CheckpointRow,
} from './repositories/sites.ts';

export type ScanResolution =
  | { readonly ok: true; readonly checkpoint: CheckpointRow }
  | { readonly ok: false; readonly code: 'INVALID_QR'; readonly oldLabel: boolean };

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
  const invalid = { ok: false as const, code: 'INVALID_QR' as const, oldLabel: false };
  const token = parseCheckpointQr(qrContent);
  if (!token) return invalid;
  const hash = checkpointTokenHash(token);
  const found = await checkpointByTokenHash(trx, hash);
  if (!found) {
    // Not a current label anywhere: perhaps one this organization replaced (Q-22).
    return (await isRetiredLabel(trx, organizationId, hash)) ? { ...invalid, oldLabel: true } : invalid;
  }
  if (found.organization_id !== organizationId) return invalid;
  const checkpoint = await getCheckpoint(trx, organizationId, found.id);
  if (!checkpoint || checkpoint.status !== 'ACTIVE') return invalid;
  return { ok: true, checkpoint };
}
