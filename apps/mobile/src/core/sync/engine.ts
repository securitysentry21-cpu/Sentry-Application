// The main-lane sync engine (ARCH §8.5–§8.6, §9.1). It sends the outbox to POST /sync/batch:
//
// - in `seq` order, ONE batch in flight at a time, at most 500 items per batch, so the server sees a
//   shift's START before its points and its points before its END;
// - success is judged only by a completed server response, never by the OS "connected" flag;
// - per-item results: ACCEPTED / DUPLICATE / QUARANTINED / REJECTED are final and deleted; RETRY
//   stays queued (and the lane backs off, because the server is degraded);
// - a whole-batch failure (no response, 5xx, 429, unreadable body) keeps the batch and resends it
//   later with the same batchId and the same item IDs;
// - backoff is exponential with full jitter (base 5 s, cap 5 min); Retry-After is always honoured,
//   even by urgent flushes (ADV-L12).
import type { SyncBatchRequest, SyncBatchResponse, SyncItem } from '@sentryops/contracts';

import { ApiError, NetworkError, ProtocolError, SignedOutError } from '../api/errors.ts';
import type { IdFactory } from '../ids.ts';
import { errorKind, type Logger } from '../log.ts';
import { type Batch, type ItemOutcome, type Outbox, type Partition, partitionKey } from '../outbox/outbox.ts';
import { type Clocks, isoFromMs } from '../time.ts';
import { fullJitterDelayMs, MAIN_LANE_BACKOFF } from './backoff.ts';

export type SyncBlock = 'SIGNED_OUT' | 'UPDATE_REQUIRED';

export type SyncStatus = {
  readonly inFlight: boolean;
  readonly consecutiveFailures: number;
  /** No ordinary attempt before this wall-clock time (exponential backoff). */
  readonly backoffUntilMs: number;
  /** No attempt at all before this time (the server's Retry-After). */
  readonly retryAfterUntilMs: number;
  readonly lastAttemptAtMs: number | null;
  /** The last time a batch got a complete, valid server response. */
  readonly lastSuccessAtMs: number | null;
  readonly lastError: { kind: string; httpStatus: number | null; errorCode: string | null } | null;
  readonly blocked: SyncBlock | null;
};

export type BatchExchange = {
  readonly partition: Partition;
  readonly request: SyncBatchRequest;
  readonly response: SyncBatchResponse;
  readonly outcomes: readonly ItemOutcome[];
};

export type FlushResult =
  | { readonly kind: 'IDLE'; readonly batches: number }
  | { readonly kind: 'BACKING_OFF'; readonly untilMs: number; readonly batches: number }
  | { readonly kind: 'FAILED'; readonly error: string; readonly untilMs: number; readonly batches: number }
  | { readonly kind: 'BLOCKED'; readonly reason: SyncBlock | 'NO_SESSION'; readonly batches: number };

export type SyncEngineDeps = {
  readonly outbox: Outbox;
  /** POST /sync/batch with the session (renewal and the 401 retry happen inside). */
  readonly send: (body: SyncBatchRequest) => Promise<SyncBatchResponse>;
  readonly clocks: Clocks;
  readonly ids: IdFactory;
  readonly random01: () => number;
  readonly logger: Logger;
  /** The signed-in guard's partition; null when nobody is signed in. */
  readonly partition: () => Partition | null;
  readonly maxBatchItems: () => number;
  /** Item types not to send now (their feature is off, e.g. INCIDENT): they stay queued. */
  readonly heldTypes?: () => readonly SyncItem['type'][];
  /** Called after every completed exchange, before the next batch: reconciliation lives here. */
  readonly onExchange: (exchange: BatchExchange) => Promise<void>;
  readonly onBlocked?: (block: SyncBlock) => void;
  /** Batches per flush, so one background callback never runs for minutes. */
  readonly maxBatchesPerFlush?: number;
  readonly initialLastSuccessAtMs?: number | null;
};

export class SyncEngine {
  readonly #deps: SyncEngineDeps;
  #inFlight: Promise<FlushResult> | null = null;
  #again = false;
  #againUrgent = false;
  #failures = 0;
  #backoffUntil = 0;
  #retryAfterUntil = 0;
  #lastAttempt: number | null = null;
  #lastSuccess: number | null;
  #lastError: SyncStatus['lastError'] = null;
  #blocked: SyncBlock | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(deps: SyncEngineDeps) {
    this.#deps = deps;
    this.#lastSuccess = deps.initialLastSuccessAtMs ?? null;
  }

  status(): SyncStatus {
    return {
      inFlight: this.#inFlight !== null,
      consecutiveFailures: this.#failures,
      backoffUntilMs: this.#backoffUntil,
      retryAfterUntilMs: this.#retryAfterUntil,
      lastAttemptAtMs: this.#lastAttempt,
      lastSuccessAtMs: this.#lastSuccess,
      lastError: this.#lastError,
      blocked: this.#blocked,
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A broken listener never stops the lane.
      }
    }
  }

  block(reason: SyncBlock): void {
    this.#blocked = reason;
    this.#emit();
  }

  /** After a new session or an app update: the lane may run again, starting fresh. */
  unblock(): void {
    this.#blocked = null;
    this.#failures = 0;
    this.#backoffUntil = 0;
    this.#emit();
  }

  /** A network-regained event: forget the exponential backoff (never the server's Retry-After). */
  resetBackoff(): void {
    this.#backoffUntil = 0;
    this.#emit();
  }

  /**
   * Sends what is queued. `urgent` (start, end, scans, incidents, a regained network) skips the
   * exponential backoff but never Retry-After. Only one flush runs at a time; a call made while one
   * is running makes it go round once more instead of starting a second upload.
   */
  flush(options: { urgent?: boolean } = {}): Promise<FlushResult> {
    if (this.#inFlight) {
      this.#again = true;
      this.#againUrgent ||= options.urgent === true;
      return this.#inFlight;
    }
    const run = this.#run(options.urgent === true).finally(() => {
      this.#inFlight = null;
      this.#emit();
    });
    this.#inFlight = run;
    this.#emit();
    return run;
  }

  async #run(urgentAtStart: boolean): Promise<FlushResult> {
    let urgent = urgentAtStart;
    let batches = 0;
    const max = this.#deps.maxBatchesPerFlush ?? 20;
    for (;;) {
      this.#again = false;
      this.#againUrgent = false;
      const result = await this.#drain(urgent, max - batches);
      batches += result.batches;
      const again = this.#again;
      const againUrgent = this.#againUrgent;
      // Go round once more for a request made meanwhile: always after a clean finish (new items may
      // have arrived), and after a failure only if that request was urgent (the network may be back;
      // an ordinary request waits for the backoff). Retry-After still holds either way.
      const goAgain =
        again && batches < max && (result.kind === 'IDLE' || (againUrgent && result.kind === 'FAILED'));
      if (!goAgain) return { ...result, batches };
      urgent = againUrgent;
    }
  }

  async #drain(urgent: boolean, budget: number): Promise<FlushResult> {
    const { outbox, clocks, ids, logger } = this.#deps;
    let batches = 0;
    while (batches < budget) {
      const now = clocks.wall.nowMs();
      if (this.#blocked) return { kind: 'BLOCKED', reason: this.#blocked, batches };
      const partition = this.#deps.partition();
      if (!partition) return { kind: 'BLOCKED', reason: 'NO_SESSION', batches };
      if (now < this.#retryAfterUntil)
        return { kind: 'BACKING_OFF', untilMs: this.#retryAfterUntil, batches };
      if (!urgent && now < this.#backoffUntil)
        return { kind: 'BACKING_OFF', untilMs: this.#backoffUntil, batches };

      const batch = await outbox.nextBatch(partitionKey(partition), {
        newBatchId: ids.uuidv7(),
        maxItems: this.#deps.maxBatchItems(),
        formedInBootId: clocks.bootId,
        holdTypes: this.#deps.heldTypes?.() ?? [],
      });
      if (!batch) return { kind: 'IDLE', batches };

      const request = this.#request(batch);
      this.#lastAttempt = now;
      this.#emit();
      let response: SyncBatchResponse;
      try {
        response = await this.#deps.send(request);
      } catch (error) {
        return this.#failed(batch, error, batches);
      }
      const outcomes = await outbox.completeBatch(batch.batchId, response.results);
      batches++;
      this.#failures = 0;
      this.#backoffUntil = 0;
      this.#retryAfterUntil = 0;
      this.#lastError = null;
      this.#lastSuccess = clocks.wall.nowMs();
      const retried = outcomes.filter((o) => o.status === 'RETRY' || o.status === 'MISSING').length;
      logger.info('sync.batch', {
        batchId: batch.batchId,
        items: batch.items.length,
        retry: retried,
        rejected: outcomes.filter((o) => o.status === 'REJECTED').length,
        quarantined: outcomes.filter((o) => o.status === 'QUARANTINED').length,
      });
      await this.#deps.onExchange({ partition, request, response, outcomes });
      this.#emit();
      if (retried > 0) {
        // The server kept some items for later (degraded): wait before offering them again.
        this.#failures = 1;
        this.#backoffUntil = clocks.wall.nowMs() + Math.max(1_000, this.#jitter());
        return { kind: 'BACKING_OFF', untilMs: this.#backoffUntil, batches };
      }
    }
    return { kind: 'IDLE', batches };
  }

  #request(batch: Batch): SyncBatchRequest {
    const { clocks } = this.#deps;
    // The batch always speaks for the run that sends it, even when it is a retry formed in an earlier
    // run. Each item carries its own bootId; the server uses the monotonic estimate only for items
    // whose bootId equals the batch's, and the phone clock for the rest (ARCH §8.7).
    return {
      batchId: batch.batchId,
      sentAt: isoFromMs(clocks.wall.nowMs()),
      sentMonoMs: clocks.mono.nowMs(),
      bootId: clocks.bootId,
      items: batch.items.map((i) => i.item),
    };
  }

  #jitter(): number {
    return fullJitterDelayMs(this.#failures, this.#deps.random01, MAIN_LANE_BACKOFF);
  }

  async #failed(batch: Batch, error: unknown, batches: number): Promise<FlushResult> {
    const { outbox, clocks, logger } = this.#deps;
    const now = clocks.wall.nowMs();
    const kind =
      error instanceof NetworkError
        ? error.kind
        : error instanceof ApiError
          ? `HTTP_${error.status}`
          : error instanceof ProtocolError
            ? 'PROTOCOL'
            : errorKind(error);
    await outbox.failBatch(batch.batchId, kind);
    this.#failures++;
    this.#lastError = {
      kind,
      httpStatus: error instanceof ApiError || error instanceof ProtocolError ? error.status : null,
      errorCode: error instanceof ApiError ? error.code : null,
    };
    logger.info('sync.batch-failed', { batchId: batch.batchId, errorKind: kind, failures: this.#failures });

    if (error instanceof SignedOutError) {
      this.#blocked = 'SIGNED_OUT';
      this.#deps.onBlocked?.('SIGNED_OUT');
      this.#emit();
      return { kind: 'BLOCKED', reason: 'SIGNED_OUT', batches };
    }
    if (error instanceof ApiError && error.status === 426) {
      // Queued uploads get 426 only when this version was revoked for security (ARCH §15.2).
      this.#blocked = 'UPDATE_REQUIRED';
      this.#deps.onBlocked?.('UPDATE_REQUIRED');
      this.#emit();
      return { kind: 'BLOCKED', reason: 'UPDATE_REQUIRED', batches };
    }
    if (error instanceof ApiError && error.retryAfterMs !== null) {
      this.#retryAfterUntil = now + error.retryAfterMs;
    }
    this.#backoffUntil = Math.max(now + this.#jitter(), this.#retryAfterUntil);
    this.#emit();
    return { kind: 'FAILED', error: kind, untilMs: this.#backoffUntil, batches };
  }
}
