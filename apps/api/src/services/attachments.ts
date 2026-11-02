// Incident photos (ARCH §12, SEC §12; D-18). The phone asks for an upload slot after the incident is
// accepted, PUTs the photo through a signed link limited to its type and exact size, then completes
// with the SHA-256. A worker then checks the object (exists, size, real type, ≤ 40 MP, hash) and makes
// a re-encoded view copy without metadata. Views use signed links of at most 5 minutes; the
// original is for Owners and Administrators only, audited.
import {
  incidentReference,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_PIXELS,
  MAX_INCIDENT_PHOTOS,
  type AttachmentSlotRequest,
  type AttachmentSlotResponse,
} from '@sentryops/contracts';
import { createHash } from 'node:crypto';

import type { Database } from '@sentryops/db';
import { inShiftWindow, localToUtc } from '@sentryops/domain';

import { processImage, type ExifFacts } from '../attachments/image.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, notFound } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import {
  attachmentByClientEvent,
  attachmentsFor,
  getAttachment,
  getIncident,
  insertAttachment,
  insertIncidentEvent,
  updateAttachment,
  type AttachmentRow,
  type IncidentRow,
} from '../repositories/incidents.ts';
import { getShift } from '../repositories/shifts.ts';
import { getSos } from '../repositories/sos.ts';
import { attachmentKeys, DOWNLOAD_LINK_TTL_S, UPLOAD_LINK_TTL_S } from '../storage/objects.ts';
import { publish } from './realtime.ts';

async function slotResponse(
  deps: AppDeps,
  a: AttachmentRow,
  now: Date,
  organizationId: string,
  trx: Database,
) {
  if (a.status !== 'PENDING_UPLOAD') return { attachmentId: a.id, status: a.status, upload: null };
  const signed = await deps.objects.signUpload(
    a.originalKey,
    a.declaredType,
    a.declaredSize,
    UPLOAD_LINK_TTL_S,
  );
  await updateAttachment(trx, organizationId, a.id, { uploadExpiresAt: signed.expiresAt }, now);
  return {
    attachmentId: a.id,
    status: a.status,
    upload: {
      url: signed.url,
      method: 'PUT' as const,
      headers: { ...signed.headers },
      expiresAt: signed.expiresAt.toISOString(),
    },
  };
}

/** POST /incidents/:id/attachments: the guard's own incident, at most 5 photos (SEC §8). */
export async function requestUploadSlot(
  trx: Database,
  deps: AppDeps,
  guard: { organizationId: string; guardId: string; deviceId: string },
  incidentId: string,
  request: AttachmentSlotRequest,
): Promise<AttachmentSlotResponse> {
  const org = guard.organizationId;
  const incident = await getIncident(trx, org, incidentId, true);
  // Another guard's incident doesn't exist for this guard (INV-02).
  if (!incident || incident.guardId !== guard.guardId) throw notFound();
  const now = deps.clock.now();
  // Asking again for the same photo (a retry, a lost response) gets the same slot.
  const existing = await attachmentByClientEvent(trx, org, incidentId, request.clientEventId);
  if (existing) return slotResponse(deps, existing, now, org, trx);
  const current = (await attachmentsFor(trx, org, [incidentId])).filter((a) => a.status !== 'REJECTED');
  if (current.length >= MAX_INCIDENT_PHOTOS) {
    throw new AppError(
      'ATTACHMENT_LIMIT_REACHED',
      `An incident holds at most ${MAX_INCIDENT_PHOTOS} photos.`,
    );
  }
  const id = uuidv7(deps.clock);
  const keys = attachmentKeys(org, incidentId, id);
  await insertAttachment(trx, {
    id,
    organizationId: org,
    incidentId,
    clientEventId: request.clientEventId,
    guardId: guard.guardId,
    deviceId: guard.deviceId,
    captureSource: request.captureSource,
    declaredType: request.contentType,
    declaredSize: request.sizeBytes,
    originalKey: keys.original,
    viewKey: keys.view,
    uploadExpiresAt: new Date(now.getTime() + UPLOAD_LINK_TTL_S * 1000),
    now,
  });
  const created = await getAttachment(trx, org, id);
  if (!created) throw new Error('attachment vanished');
  return slotResponse(deps, created, now, org, trx);
}

/** POST /attachments/:id/complete: the phone says the upload finished, with its SHA-256. */
export async function completeUpload(
  trx: Database,
  deps: AppDeps,
  guard: { organizationId: string; guardId: string },
  attachmentId: string,
  sha256Hex: string,
): Promise<{ attachmentId: string; status: AttachmentRow['status'] }> {
  const a = await getAttachment(trx, guard.organizationId, attachmentId, true);
  if (!a || a.guardId !== guard.guardId) throw notFound();
  if (a.status === 'PENDING_UPLOAD') {
    const now = deps.clock.now();
    await updateAttachment(
      trx,
      guard.organizationId,
      a.id,
      { status: 'PROCESSING', sha256: Buffer.from(sha256Hex, 'hex'), completedAt: now },
      now,
    );
    return { attachmentId: a.id, status: 'PROCESSING' };
  }
  return { attachmentId: a.id, status: a.status };
}

/** The photo's own capture time, from its metadata: with the camera's offset, else the site's zone. */
function exifInstant(exif: ExifFacts, timeZone: string): Date | null {
  if (!exif.capturedLocal) return null;
  const [date, time] = exif.capturedLocal.split(' ');
  if (!date || !time) return null;
  const iso = date.replaceAll(':', '-');
  if (exif.offset) {
    const parsed = Date.parse(`${iso}T${time}${exif.offset}`);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  try {
    return localToUtc(iso, time.slice(0, 5), timeZone);
  } catch {
    return null;
  }
}

/** INV-08: a photo's GPS is kept only when the photo was taken inside the incident's shift or SOS. */
async function insideIncidentWindow(
  trx: Database,
  organizationId: string,
  incident: IncidentRow,
  at: Date,
  now: Date,
) {
  if (incident.shiftId) {
    const shift = await getShift(trx, organizationId, incident.shiftId);
    if (shift && inShiftWindow(at, shift.actualStartedAt, shift.actualEndedAt, now)) return true;
  }
  if (incident.sosEventId) {
    const sos = await getSos(trx, organizationId, incident.sosEventId);
    if (sos && at >= sos.activatedAt && (sos.resolvedAt === null || at <= sos.resolvedAt)) return true;
  }
  return false;
}

/**
 * Checks one uploaded photo (ARCH §12 step 5) and records the verdict. Runs in the worker, inside the
 * organization's transaction, with the photo's row locked.
 */
export async function processAttachment(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  a: AttachmentRow,
): Promise<'AVAILABLE' | 'REJECTED'> {
  const now = deps.clock.now();
  const incident = await getIncident(trx, organizationId, a.incidentId);
  if (!incident) throw new Error('attachment without incident');
  const reject = async (reason: string) => {
    await updateAttachment(
      trx,
      organizationId,
      a.id,
      { status: 'REJECTED', rejectionReason: reason, processedAt: now },
      now,
    );
    await insertIncidentEvent(trx, {
      id: uuidv7(deps.clock),
      organizationId,
      incidentId: a.incidentId,
      type: 'ATTACHMENT_REJECTED',
      actor: { type: 'SYSTEM' },
      payload: { attachmentId: a.id, reason },
      at: now,
    });
    await publish(trx, deps, organizationId, 'incident.updated', { incidentId: a.incidentId });
    deps.metrics.increment('attachments_rejected');
    return 'REJECTED' as const;
  };

  const size = await deps.objects.size(a.originalKey);
  if (size === null) return reject('NOT_UPLOADED');
  if (size > MAX_ATTACHMENT_BYTES) return reject('SIZE_MISMATCH');
  if (size !== a.declaredSize) return reject('SIZE_MISMATCH');
  const bytes = await deps.objects.read(a.originalKey, MAX_ATTACHMENT_BYTES);
  if (!bytes) return reject('NOT_UPLOADED');
  const digest = createHash('sha256').update(bytes).digest();
  if (!a.sha256 || !digest.equals(a.sha256)) return reject('HASH_MISMATCH');
  const processed = await processImage(bytes, MAX_ATTACHMENT_PIXELS);
  if (!processed.ok) return reject(processed.reason);
  await deps.objects.write(a.viewKey, processed.view, 'image/jpeg');

  const timeZone = incident.siteTimezone ?? 'UTC';
  const takenAt = exifInstant(processed.exif, timeZone);
  const gps =
    processed.exif.gps && takenAt && (await insideIncidentWindow(trx, organizationId, incident, takenAt, now))
      ? processed.exif.gps
      : null;
  await updateAttachment(
    trx,
    organizationId,
    a.id,
    {
      status: 'AVAILABLE',
      detectedType: processed.type,
      sizeBytes: size,
      width: processed.width,
      height: processed.height,
      exifCapturedAt: takenAt,
      exifLatitude: gps?.lat ?? null,
      exifLongitude: gps?.lng ?? null,
      processedAt: now,
    },
    now,
  );
  await insertIncidentEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId,
    incidentId: a.incidentId,
    type: 'ATTACHMENT_ADDED',
    actor: { type: 'SYSTEM' },
    payload: { attachmentId: a.id, captureSource: a.captureSource },
    at: now,
  });
  await publish(trx, deps, organizationId, 'incident.updated', { incidentId: a.incidentId });
  return 'AVAILABLE';
}

/** A signed GET of the view copy (≤ 5 min), after authorization (SEC §12). */
export async function viewLink(trx: Database, deps: AppDeps, organizationId: string, attachmentId: string) {
  const a = await getAttachment(trx, organizationId, attachmentId);
  if (!a || a.status !== 'AVAILABLE') throw notFound();
  const link = await deps.objects.signDownload(a.viewKey, DOWNLOAD_LINK_TTL_S);
  return { attachment: a, url: link.url, expiresAt: link.expiresAt.toISOString() };
}

/** A signed GET of the original, saved as a file (Owners and Administrators; audited by the route). */
export async function originalLink(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  attachmentId: string,
) {
  const a = await getAttachment(trx, organizationId, attachmentId);
  if (!a || a.status !== 'AVAILABLE') throw notFound();
  const incident = await getIncident(trx, organizationId, a.incidentId);
  const extension =
    { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[a.detectedType ?? ''] ?? 'bin';
  const name = `${incident ? incidentReference(incident.referenceNumber) : 'incident'}-${a.id.slice(0, 8)}.${extension}`;
  const link = await deps.objects.signDownload(a.originalKey, DOWNLOAD_LINK_TTL_S, name);
  return { attachment: a, url: link.url, expiresAt: link.expiresAt.toISOString() };
}
