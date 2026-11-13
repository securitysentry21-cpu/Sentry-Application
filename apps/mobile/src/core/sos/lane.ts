// The SOS lane (ARCH §8.6, §13.1; PROD §11.2–§11.8). An SOS is saved on the phone first, then sent at
// once to POST /sos on its own path: never batched, never behind main-lane items, never held back by
// the main lane's backoff, an update screen or a minimum-version gate (INV-15). Once the server has it,
// its follow-ups go on the same lane: SOS tracking points and the guard's "I'm safe". While it is
// open the phone asks the server every 5 seconds what it can confirm (PROD §11.3) and shows exactly
// that (INV-10). If the session cannot be used (expired, refresh refused or impossible), every request
// is signed with the device key instead (X-Device-Signature, ADV-S11). The SOS feature is behind
// `features.sos` (off for the pilot); this lane works the same whichever way the flag is set, and the
// screens decide whether to offer it.
import type { Fix, SosStatusResponse } from '@sentryops/contracts';

import type { ApiClient, Auth, SosResponse } from '../api/client.ts';
import { ApiError, NetworkError, ProtocolError, SignedOutError } from '../api/errors.ts';
import type { SessionManager } from '../api/session.ts';
import { deviceSignature } from '../device-key.ts';
import { utf8Encode } from '../encoding.ts';
import type { IdFactory } from '../ids.ts';
import { errorKind, type Logger } from '../log.ts';
import {
  type Outbox,
  type Partition,
  partitionKey,
  type SosFollowUp,
  type SosRequest,
} from '../outbox/outbox.ts';
import type { ServerTime } from '../server-time.ts';
import { fullJitterDelayMs, SOS_LANE_BACKOFF } from '../sync/backoff.ts';
import { type Clocks, isoFromMs } from '../time.ts';
import {
  newSos,
  sosOpen,
  SOS_POLL_INTERVAL_MS,
  sosReducer,
  sosTrackingActive,
  type SosEvent,
  type SosState,
} from './machine.ts';

export const SOS_PATH = '/api/v1/sos';
/** A received SOS is remembered across restarts for this long; the server's answer says if it is open. */
const RESTORE_WINDOW_MS = 24 * 3_600_000;
/** The server takes up to 100 points per request. */
const POINTS_PER_REQUEST = 100;

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
  #cancelPoll: (() => void) | null = null;

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

  /** The SOS whose tracking runs now (PROD §11.2), or null. `nowMs` on the server's clock. */
  tracking(nowMs: number): SosState | null {
    const latest = this.latest();
    return latest && sosTrackingActive(latest, nowMs) ? latest : null;
  }

  /**
   * On launch: SOS presses still in the lane are QUEUED again (saved on the phone, never confirmed);
   * the newest SOS the server confirmed in the last day comes back as RECEIVED, and its state is asked
   * for at once.
   */
  async restore(): Promise<void> {
    const identity = this.#deps.identity();
    if (!identity) return;
    const key = partitionKey(identity.partition);
    for (const item of await this.#deps.outbox.allSos(key)) {
      if (!this.#states.has(item.clientEventId)) {
        this.#states.set(item.clientEventId, {
          ...newSos(item.clientEventId, Date.parse(item.request.recordedAt)),
          attempts: item.attempts,
        });
      }
    }
    const received = await this.#deps.outbox.latestReceivedSos(
      key,
      this.#deps.clocks.wall.nowMs() - RESTORE_WINDOW_MS,
    );
    if (received && !this.#states.has(received.clientEventId)) {
      this.#states.set(
        received.clientEventId,
        sosReducer(newSos(received.clientEventId, received.createdAtMs), {
          type: 'SERVER_CONFIRMED',
          sosEventId: received.sosEventId,
          serverTime: isoFromMs(received.createdAtMs),
        }),
      );
    }
    this.#deps.onChange();
    this.#schedulePoll(0);
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

  /** An SOS tracking point (PROD §11.2) for the SOS being tracked; sent once the server has it. */
  async recordFix(fix: Fix, capturedWallMs: number, monoMs: number): Promise<boolean> {
    const identity = this.#deps.identity();
    const sos = this.tracking(this.#deps.serverTime.correct(this.#deps.clocks.wall.nowMs()));
    if (!identity || !sos) return false;
    await this.#deps.outbox.enqueueSosFollowUp(identity.partition, {
      type: 'SOS_LOCATION',
      clientEventId: this.#deps.ids.uuidv7(),
      sosClientEventId: sos.clientEventId,
      recordedAt: isoFromMs(capturedWallMs),
      monoMs,
      bootId: this.#deps.clocks.bootId,
      fix,
    });
    void this.flush();
    return true;
  }

  /**
   * "I'm safe / false alarm" (PROD §11.8): noted for the control room. It doesn't resolve the SOS or
   * stop escalation, and the phone keeps tracking until a supervisor resolves it.
   */
  async requestCancel(): Promise<boolean> {
    const identity = this.#deps.identity();
    const sos = this.latest();
    if (!identity || !sos || !sosOpen(sos) || sos.cancelRequested) return false;
    const { clocks, ids } = this.#deps;
    await this.#deps.outbox.enqueueSosFollowUp(identity.partition, {
      type: 'SOS_CANCEL',
      clientEventId: ids.uuidv7(),
      sosClientEventId: sos.clientEventId,
      recordedAt: isoFromMs(clocks.wall.nowMs()),
      monoMs: clocks.mono.nowMs(),
      bootId: clocks.bootId,
    });
    this.#apply(sos.clientEventId, { type: 'CANCEL_REQUESTED' });
    void this.flush();
    return true;
  }

  /** Asks the server what it can confirm about the latest SOS (PROD §11.3), if it has it and it's open. */
  async pollStatus(): Promise<void> {
    const sos = this.latest();
    if (!sos?.sosEventId || !sosOpen(sos)) return;
    const sosEventId = sos.sosEventId;
    try {
      const status = await this.#call('GET', `${SOS_PATH}/${sosEventId}/status`, null, (auth) =>
        this.#deps.api.getSosStatus(auth, sosEventId),
      );
      this.#apply(sos.clientEventId, { type: 'SERVER_STATUS', status });
    } catch (error) {
      // Nothing is shown that the server didn't say; the next poll tries again.
      this.#deps.logger.info('sos.status-unavailable', { errorKind: errorKind(error) });
    }
  }

  /** Sends every due SOS and follow-up. Safe to call any time (network regained, app opened, timer). */
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
    await this.pollStatus();
  }

  stop(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#cancelPoll?.();
    this.#cancelPoll = null;
  }

  async #sendDue(): Promise<void> {
    const identity = this.#deps.identity();
    if (!identity) return;
    const key = partitionKey(identity.partition);
    const due = await this.#deps.outbox.dueSos(key, this.#deps.clocks.wall.nowMs());
    for (const item of due) await this.#send(item.clientEventId, item.request, item.attempts);
    for (const sos of this.#states.values()) {
      if (sos.sosEventId) await this.#sendFollowUps(key, sos);
    }
    await this.#scheduleNext(key);
  }

  async #scheduleNext(key: string): Promise<void> {
    const pending = await this.#deps.outbox.allSos(key);
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    const followUps = await this.#deps.outbox.pendingSosFollowUps(key);
    if (pending.length === 0 && followUps === 0) return;
    const now = this.#deps.clocks.wall.nowMs();
    const next = pending.length > 0 ? Math.min(...pending.map((p) => p.nextAttemptAtMs)) : now + 10_000;
    const delay = Math.max(1_000, Math.min(next - now, 10_000));
    const schedule = this.#deps.schedule ?? timerScheduler;
    this.#cancelTimer = schedule(() => {
      this.#cancelTimer = null;
      void this.flush();
    }, delay);
  }

  #schedulePoll(delayMs: number): void {
    this.#cancelPoll?.();
    this.#cancelPoll = null;
    const sos = this.latest();
    if (!sos || !sosOpen(sos)) return;
    const schedule = this.#deps.schedule ?? timerScheduler;
    this.#cancelPoll = schedule(() => {
      this.#cancelPoll = null;
      void this.pollStatus().finally(() => this.#schedulePoll(SOS_POLL_INTERVAL_MS));
    }, delayMs);
  }

  #apply(clientEventId: string, event: SosEvent): void {
    const current = this.#states.get(clientEventId) ?? newSos(clientEventId, this.#deps.clocks.wall.nowMs());
    this.#states.set(clientEventId, sosReducer(current, event));
    this.#deps.onChange();
  }

  async #send(clientEventId: string, saved: SosRequest, attempts: number): Promise<void> {
    const { outbox, logger, clocks } = this.#deps;
    this.#apply(clientEventId, { type: 'SEND_STARTED' });
    // The monotonic clock at sending lets the server estimate when it was pressed (ARCH §8.7); it
    // means something only within the same boot.
    const request: SosRequest =
      saved.bootId === clocks.bootId ? { ...saved, sentMonoMs: clocks.mono.nowMs() } : saved;
    const bodyText = JSON.stringify(request);
    let response: SosResponse;
    try {
      response = await this.#call('POST', SOS_PATH, bodyText, (auth) =>
        this.#deps.api.postSos(auth, bodyText),
      );
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
      // Review L-11: a 401 here came from the device-key attempt (#call tries it after the session),
      // so the server answered and refused. Still tried again, but never shown as "no network".
      const refused = error instanceof ApiError && error.status === 401;
      this.#apply(clientEventId, { type: 'SEND_FAILED', refused });
      logger.warn(refused ? 'sos.not-accepted' : 'sos.not-sent', { clientEventId, errorKind: kind });
      return;
    }
    await outbox.completeSos(clientEventId, response.sosEventId);
    this.#apply(clientEventId, {
      type: 'SERVER_CONFIRMED',
      sosEventId: response.sosEventId,
      serverTime: response.serverTime,
      ...(response.isDrill !== undefined ? { isDrill: response.isDrill } : {}),
    });
    logger.warn('sos.received', { clientEventId, sosEventId: response.sosEventId });
    this.#schedulePoll(0);
  }

  /** Points first (≤ 100 per request), then "I'm safe"; each item leaves the lane once answered. */
  async #sendFollowUps(key: string, sos: SosState): Promise<void> {
    const sosEventId = sos.sosEventId;
    if (!sosEventId) return;
    const { outbox, clocks, logger } = this.#deps;
    const due = await outbox.dueSosFollowUps(key, sos.clientEventId, clocks.wall.nowMs(), POINTS_PER_REQUEST);
    const points = due.filter(
      (d): d is Extract<SosFollowUp, { type: 'SOS_LOCATION' }> => d.type === 'SOS_LOCATION',
    );
    const cancels = due.filter((d) => d.type === 'SOS_CANCEL');
    try {
      if (points.length > 0) {
        const body = JSON.stringify({
          bootId: clocks.bootId,
          sentMonoMs: clocks.mono.nowMs(),
          points: points.map((p) => ({
            clientEventId: p.clientEventId,
            recordedAt: p.recordedAt,
            monoMs: p.monoMs,
            bootId: p.bootId,
            fix: p.fix,
          })),
        });
        const path = `${SOS_PATH}/${sosEventId}/locations`;
        const reply = await this.#call('POST', path, body, (auth) =>
          this.#deps.api.postSosLocations(auth, sosEventId, body),
        );
        // Accepted, duplicate or refused for good: answered either way. RETRY stays queued.
        const answered = reply.results.filter((r) => r.status !== 'RETRY').map((r) => r.clientEventId);
        await outbox.completeSosFollowUps(answered);
      }
      for (const cancel of cancels) {
        const body = JSON.stringify({ clientEventId: cancel.clientEventId, recordedAt: cancel.recordedAt });
        const path = `${SOS_PATH}/${sosEventId}/cancel-request`;
        const status = await this.#call('POST', path, body, (auth) =>
          this.#deps.api.postSosCancel(auth, sosEventId, body),
        );
        await outbox.completeSosFollowUps([cancel.clientEventId]);
        this.#apply(sos.clientEventId, { type: 'SERVER_STATUS', status });
      }
    } catch (error) {
      const ids = due.map((d) => d.clientEventId);
      if (error instanceof ApiError && !error.transient && error.status !== 401) {
        // The server won't take them (a resolved SOS's late points, another guard's SOS): drop them.
        await outbox.completeSosFollowUps(ids);
        logger.warn('sos.follow-ups-refused', { httpStatus: error.status, errorCode: error.code ?? 'NONE' });
        return;
      }
      await outbox.rescheduleSosFollowUps(ids, clocks.wall.nowMs() + 5_000, errorKind(error));
    }
  }

  /** With the session if it works; otherwise signed with the device key (INV-15). */
  async #call<T>(
    method: 'GET' | 'POST',
    path: string,
    bodyText: string | null,
    send: (auth: Auth) => Promise<T>,
  ): Promise<T> {
    const { session } = this.#deps;
    if (session.current) {
      let token: string | null = null;
      try {
        token = await session.accessToken();
      } catch {
        // expired and not renewable right now: fall back to the signature
      }
      if (token) {
        try {
          return await send({ kind: 'bearer', token });
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 401)) throw error;
        }
      }
    }
    return send(await this.#signed(method, path, bodyText ?? ''));
  }

  async #signed(method: 'GET' | 'POST', path: string, bodyText: string): Promise<Auth> {
    const { clocks, serverTime } = this.#deps;
    const key = await this.#deps.deviceKey();
    if (!key) throw new SignedOutError('NO_SESSION');
    // The timestamp only guards against replay; correcting it by the known server offset keeps a
    // request from a phone with a wrong clock inside the server's acceptance window.
    const timestampMs = Math.max(0, Math.round(serverTime.correct(clocks.wall.nowMs())));
    const signature = deviceSignature(key, { method, path, timestampMs, body: utf8Encode(bodyText) });
    return { kind: 'device-signature', signature };
  }
}

export type { SosStatusResponse };
