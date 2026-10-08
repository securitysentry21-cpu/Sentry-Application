// The SOS lane (ARCH §8.6, §13.1; PROD §11.2). An SOS is saved on the phone first, then sent at once
// to POST /sos on its own path: never batched, never behind main-lane items, never held back by the
// main lane's backoff, an update screen or a minimum-version gate (INV-15). If the session cannot be
// used (expired, refresh refused or impossible), the request is signed with the device key instead
// (X-Device-Signature, ADV-S11). The SOS feature is behind `features.sos` (off for the pilot); this
// lane works the same whichever way the flag is set, and the screens decide whether to offer it.
import type { Fix } from '@sentryops/contracts';

import type { ApiClient, SosResponse } from '../api/client.ts';
import { ApiError, NetworkError, ProtocolError, SignedOutError } from '../api/errors.ts';
import type { SessionManager } from '../api/session.ts';
import { deviceSignature } from '../device-key.ts';
import { utf8Encode } from '../encoding.ts';
import type { IdFactory } from '../ids.ts';
import { errorKind, type Logger } from '../log.ts';
import { type Outbox, type Partition, partitionKey, type SosRequest } from '../outbox/outbox.ts';
import type { ServerTime } from '../server-time.ts';
import { fullJitterDelayMs, SOS_LANE_BACKOFF } from '../sync/backoff.ts';
import { type Clocks, isoFromMs } from '../time.ts';
import { newSos, sosReducer, type SosEvent, type SosState } from './machine.ts';

export const SOS_PATH = '/api/v1/sos';

/** Runs `task` after `delayMs`; returns a cancel function. Injected so tests control time. */
export type Scheduler = (task: () => void, delayMs: number) => () => void;

export const timerScheduler: Scheduler = (task, delayMs) => {
  const handle = setTimeout(task, delayMs);
  return () => clearTimeout(handle);
};

export type SosLaneDeps = {
  readonly outbox: Outbox;
  readonly api: ApiClient;
  readonly session: SessionManager;
  /** The enrolled identity; still known after a sign-out, so a signed SOS can be sent. */
  readonly identity: () => { partition: Partition; deviceId: string } | null;
  readonly deviceKey: () => Promise<Uint8Array | null>;
  readonly clocks: Clocks;
  readonly serverTime: ServerTime;
  readonly ids: IdFactory;
  readonly random01: () => number;
  readonly logger: Logger;
  readonly onChange: () => void;
  readonly schedule?: Scheduler;
};

export class SosLane {
  readonly #deps: SosLaneDeps;
  readonly #states = new Map<string, SosState>();
  #running: Promise<void> | null = null;
  #again = false;
  #cancelTimer: (() => void) | null = null;

  constructor(deps: SosLaneDeps) {
    this.#deps = deps;
  }

  /** The most recent SOS on this phone (for the SOS screen), or null. */
  latest(): SosState | null {
    let latest: SosState | null = null;
    for (const s of this.#states.values()) if (!latest || s.createdAtMs >= latest.createdAtMs) latest = s;
    return latest;
  }

  state(clientEventId: string): SosState | null {
    return this.#states.get(clientEventId) ?? null;
  }

  /** On launch: SOS items still in the lane are QUEUED again (saved on the phone, never confirmed). */
  async restore(): Promise<void> {
    const identity = this.#deps.identity();
    if (!identity) return;
    for (const item of await this.#deps.outbox.allSos(partitionKey(identity.partition))) {
      if (!this.#states.has(item.clientEventId)) {
        this.#states.set(item.clientEventId, {
          ...newSos(item.clientEventId, Date.parse(item.request.recordedAt)),
          attempts: item.attempts,
        });
      }
    }
    this.#deps.onChange();
  }

  /** PROD §11.2: save, then send at once without waiting for a fix. Returns the SOS's clientEventId. */
  async trigger(fix: Fix | null): Promise<string> {
    const identity = this.#deps.identity();
    if (!identity) throw new SignedOutError('NO_SESSION');
    const { clocks, ids } = this.#deps;
    const request: SosRequest = {
      clientEventId: ids.uuidv7(),
      recordedAt: isoFromMs(clocks.wall.nowMs()),
      monoMs: clocks.mono.nowMs(),
      bootId: clocks.bootId,
      fix,
    };
    await this.#deps.outbox.enqueueSos(identity.partition, request);
    this.#states.set(request.clientEventId, newSos(request.clientEventId, clocks.wall.nowMs()));
    this.#deps.logger.warn('sos.saved', { clientEventId: request.clientEventId });
    this.#deps.onChange();
    void this.flush();
    return request.clientEventId;
  }

  /** Sends every due SOS. Safe to call any time (network regained, app opened, timer). */
  flush(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    const run = (async () => {
      do {
        this.#again = false;
        await this.#sendDue();
      } while (this.#again);
    })().finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  /** Retries everything now, ignoring backoff (a regained network, the app coming to the front). */
  async retryNow(): Promise<void> {
    const identity = this.#deps.identity();
    if (!identity) return;
    for (const item of await this.#deps.outbox.allSos(partitionKey(identity.partition))) {
      await this.#deps.outbox.rescheduleSos(item.clientEventId, 0, item.lastError ?? 'RETRY_NOW');
    }
    await this.flush();
  }

  stop(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }

  async #sendDue(): Promise<void> {
    const identity = this.#deps.identity();
    if (!identity) return;
    const key = partitionKey(identity.partition);
    const due = await this.#deps.outbox.dueSos(key, this.#deps.clocks.wall.nowMs());
    for (const item of due) await this.#send(item.clientEventId, item.request, item.attempts);
    await this.#scheduleNext(key);
  }

  async #scheduleNext(key: string): Promise<void> {
    const pending = await this.#deps.outbox.allSos(key);
    this.stop();
    if (pending.length === 0) return;
    const next = Math.min(...pending.map((p) => p.nextAttemptAtMs));
    const delay = Math.max(0, next - this.#deps.clocks.wall.nowMs());
    const schedule = this.#deps.schedule ?? timerScheduler;
    this.#cancelTimer = schedule(() => {
      this.#cancelTimer = null;
      void this.flush();
    }, delay);
  }

  #apply(clientEventId: string, event: SosEvent): void {
    const current = this.#states.get(clientEventId) ?? newSos(clientEventId, this.#deps.clocks.wall.nowMs());
    this.#states.set(clientEventId, sosReducer(current, event));
    this.#deps.onChange();
  }

  async #send(clientEventId: string, request: SosRequest, attempts: number): Promise<void> {
    const { outbox, logger, clocks } = this.#deps;
    this.#apply(clientEventId, { type: 'SEND_STARTED' });
    const bodyText = JSON.stringify(request);
    let response: SosResponse;
    try {
      response = await this.#post(bodyText);
    } catch (error) {
      if (error instanceof ApiError && !error.transient && error.status !== 401) {
        const code = error.code ?? `HTTP_${error.status}`;
        await outbox.rejectSos(clientEventId, code);
        this.#apply(clientEventId, { type: 'SEND_REFUSED', errorCode: code });
        logger.error('sos.refused', { clientEventId, httpStatus: error.status, errorCode: code });
        return;
      }
      const delay = fullJitterDelayMs(attempts + 1, this.#deps.random01, SOS_LANE_BACKOFF);
      const retryAfter = error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0;
      const kind =
        error instanceof NetworkError
          ? error.kind
          : error instanceof ProtocolError
            ? 'PROTOCOL'
            : errorKind(error);
      await outbox.rescheduleSos(
        clientEventId,
        clocks.wall.nowMs() + Math.max(delay, retryAfter, 1_000),
        kind,
      );
      this.#apply(clientEventId, { type: 'SEND_FAILED' });
      logger.warn('sos.not-sent', { clientEventId, errorKind: kind });
      return;
    }
    await outbox.completeSos(clientEventId, response.sosEventId);
    this.#apply(clientEventId, {
      type: 'SERVER_CONFIRMED',
      sosEventId: response.sosEventId,
      serverTime: response.serverTime,
    });
    logger.warn('sos.received', { clientEventId, sosEventId: response.sosEventId });
  }

  /** With the session if it works; otherwise signed with the device key (INV-15). */
  async #post(bodyText: string): Promise<SosResponse> {
    const { api, session } = this.#deps;
    if (session.current) {
      let token: string | null = null;
      try {
        token = await session.accessToken();
      } catch {
        // expired and not renewable right now: fall back to the signature
      }
      if (token) {
        try {
          return await api.postSos({ kind: 'bearer', token }, bodyText);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 401)) throw error;
        }
      }
    }
    return this.#postSigned(bodyText);
  }

  async #postSigned(bodyText: string): Promise<SosResponse> {
    const { api, clocks, serverTime } = this.#deps;
    const key = await this.#deps.deviceKey();
    if (!key) throw new SignedOutError('NO_SESSION');
    // The timestamp only guards against replay; correcting it by the known server offset keeps an
    // SOS from a phone with a wrong clock inside the server's acceptance window.
    const timestampMs = Math.max(0, Math.round(serverTime.correct(clocks.wall.nowMs())));
    const signature = deviceSignature(key, {
      method: 'POST',
      path: SOS_PATH,
      timestampMs,
      body: utf8Encode(bodyText),
    });
    return api.postSos({ kind: 'device-signature', signature }, bodyText);
  }
}
