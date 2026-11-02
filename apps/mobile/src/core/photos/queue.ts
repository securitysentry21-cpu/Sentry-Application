// The photo upload lane (ARCH §8.6, §12): incident photos go up after their incident is on the
// server (the receipt holds its ID), each one through its own signed slot: request the slot, PUT the
// bytes, complete with the SHA-256. Retried with backoff until done; a photo the server refuses for
// good (the incident refused, five photos already) leaves the phone. The local copy is deleted once
// the server has the upload. Nothing here claims more than the server answered (INV-16).
import { ApiError } from '../api/errors.ts';
import type { ApiClient } from '../api/client.ts';
import type { SessionManager } from '../api/session.ts';
import type { IdFactory } from '../ids.ts';
import { errorKind, type Logger } from '../log.ts';
import type { Outbox } from '../outbox/outbox.ts';
import type { PhotoPort } from '../ports.ts';
import type { SqlDatabase } from '../storage/sql.ts';
import { fullJitterDelayMs, MAIN_LANE_BACKOFF } from '../sync/backoff.ts';
import type { WallClock } from '../time.ts';

export type CaptureSource = 'IN_APP_CAMERA' | 'GALLERY';
export type PhotoStatus = 'QUEUED' | 'UPLOADED' | 'DONE' | 'REJECTED';

type PhotoRow = {
  client_event_id: string;
  partition_key: string;
  incident_client_event_id: string;
  local_uri: string;
  capture_source: CaptureSource;
  content_type: string;
  size_bytes: number;
  sha256: string;
  status: PhotoStatus;
  attachment_id: string | null;
  attempts: number;
};

export type PhotoQueueDeps = {
  readonly db: SqlDatabase;
  readonly outbox: Outbox;
  readonly api: ApiClient;
  readonly session: SessionManager;
  readonly photos: PhotoPort;
  readonly wall: WallClock;
  readonly ids: IdFactory;
  readonly random01: () => number;
  readonly logger: Logger;
};

export class PhotoQueue {
  readonly #deps: PhotoQueueDeps;
  #running: Promise<void> | null = null;

  constructor(deps: PhotoQueueDeps) {
    this.#deps = deps;
  }

  /** Re-encodes a photo into app storage and queues it behind its incident (ARCH §12 step 3). */
  async add(
    partitionKey: string,
    incidentClientEventId: string,
    photo: { uri: string; width: number; height: number; source: CaptureSource },
  ): Promise<void> {
    const clientEventId = this.#deps.ids.uuidv7();
    const prepared = await this.#deps.photos.prepare(photo.uri, photo.width, photo.height, clientEventId);
    await this.#deps.db.run(
      `INSERT INTO photos (client_event_id, partition_key, incident_client_event_id, local_uri, capture_source,
         content_type, size_bytes, sha256, status, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?)`,
      [
        clientEventId,
        partitionKey,
        incidentClientEventId,
        prepared.uri,
        photo.source,
        prepared.contentType,
        prepared.sizeBytes,
        prepared.sha256,
        this.#deps.wall.nowMs(),
      ],
    );
  }

  /** Photos not yet on the server, for the guard ("2 photos waiting to upload"). */
  async pending(partitionKey: string, incidentClientEventId?: string): Promise<number> {
    const row = await this.#deps.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM photos WHERE partition_key = ? AND status IN ('QUEUED', 'UPLOADED')
         ${incidentClientEventId ? 'AND incident_client_event_id = ?' : ''}`,
      incidentClientEventId ? [partitionKey, incidentClientEventId] : [partitionKey],
    );
    return row?.n ?? 0;
  }

  /** Uploads what is due. Safe to call any time; one run at a time. */
  run(partitionKey: string): Promise<void> {
    if (this.#running) return this.#running;
    const run = this.#runOnce(partitionKey).finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  async #runOnce(partitionKey: string): Promise<void> {
    const { db, wall } = this.#deps;
    const due = await db.all<PhotoRow>(
      `SELECT * FROM photos WHERE partition_key = ? AND status IN ('QUEUED', 'UPLOADED') AND next_attempt_at_ms <= ?
       ORDER BY created_at_ms LIMIT 10`,
      [partitionKey, wall.nowMs()],
    );
    for (const photo of due) await this.#advance(photo);
  }

  async #advance(photo: PhotoRow): Promise<void> {
    const { outbox, api, session, photos, logger } = this.#deps;
    const incident = await outbox.receipt(photo.incident_client_event_id);
    if (!incident || incident.status === 'QUEUED' || incident.status === 'QUARANTINED') return; // not on the server yet
    if (!incident.serverRef || incident.status === 'REJECTED' || incident.status === 'DISCARDED') {
      await this.#finish(photo, 'REJECTED', incident.errorCode ?? 'INCIDENT_NOT_STORED');
      return;
    }
    const incidentId = incident.serverRef;
    try {
      let attachmentId = photo.attachment_id;
      if (photo.status === 'QUEUED') {
        const slot = await session.withAuth((token) =>
          api.requestAttachmentSlot(token, incidentId, {
            clientEventId: photo.client_event_id,
            contentType: 'image/jpeg',
            sizeBytes: photo.size_bytes,
            captureSource: photo.capture_source,
          }),
        );
        attachmentId = slot.attachmentId;
        if (slot.upload) {
          const status = await photos.upload(photo.local_uri, slot.upload.url, slot.upload.headers);
          // 412: the storage already has this photo (an earlier try whose answer was lost). It never
          // overwrites; completing below lets the server check the hash of what is there.
          if (status !== 412 && (status < 200 || status >= 300)) throw new UploadFailed(status);
        }
        await this.#deps.db.run(
          `UPDATE photos SET status = 'UPLOADED', attachment_id = ?, last_error = NULL WHERE client_event_id = ?`,
          [attachmentId, photo.client_event_id],
        );
      }
      if (!attachmentId) return;
      const done = attachmentId;
      await session.withAuth((token) => api.completeAttachment(token, done, photo.sha256));
      await this.#finish(photo, 'DONE', null);
    } catch (error) {
      if (error instanceof ApiError && !error.transient && error.status !== 401) {
        // Refused for good (another guard's incident, five photos already): it leaves the phone.
        logger.warn('photo.refused', { httpStatus: error.status, errorCode: error.code ?? 'NONE' });
        await this.#finish(photo, 'REJECTED', error.code ?? `HTTP_${error.status}`);
        return;
      }
      const delay = fullJitterDelayMs(photo.attempts + 1, this.#deps.random01, MAIN_LANE_BACKOFF);
      await this.#deps.db.run(
        `UPDATE photos SET attempts = attempts + 1, next_attempt_at_ms = ?, last_error = ? WHERE client_event_id = ?`,
        [this.#deps.wall.nowMs() + delay, errorKind(error), photo.client_event_id],
      );
    }
  }

  async #finish(photo: PhotoRow, status: 'DONE' | 'REJECTED', error: string | null): Promise<void> {
    await this.#deps.db.run(`UPDATE photos SET status = ?, last_error = ? WHERE client_event_id = ?`, [
      status,
      error,
      photo.client_event_id,
    ]);
    try {
      await this.#deps.photos.remove(photo.local_uri);
    } catch (removeError) {
      this.#deps.logger.warn('photo.remove-failed', { errorKind: errorKind(removeError) });
    }
  }
}

class UploadFailed extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`upload refused: HTTP ${status}`);
    this.status = status;
  }
}
