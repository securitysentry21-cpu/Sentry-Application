// Crash reports on the phone (ARCH §18.6, owner decision 2026-11-02: our own server only).
//
// Three sources:
//   - the JavaScript global error handler and the screens' error boundary call `record()`;
//   - a run marker notices that the PREVIOUS run ended while the app was in front and never closed
//     itself (a crash the JavaScript side could not report, the system stopping the app, a reboot or
//     a flat battery). That is a signal, not a diagnosis: the report says only "closed unexpectedly".
//     Going to the background counts as a clean close, because the system may then stop the app at
//     any time; tracking on a shift is watched by its own failsafes (PROD §7.6).
//
// Reports wait in a small queue in the local database until one upload succeeds; a refusal (4xx)
// drops them, because the same report would be refused again. Reporting never throws, never blocks
// the app and never works from the readiness of a session: with no session the queue just waits.
import type { AppErrorKind, AppErrorReport } from '@sentryops/contracts';
import { MAX_APP_ERROR_REPORTS } from '@sentryops/contracts';

import { ApiError } from '../api/errors.ts';
import type { Logger } from '../log.ts';
import { errorKind } from '../log.ts';
import { META_KEYS, type MetaStore } from '../storage/meta.ts';
import type { WallClock } from '../time.ts';
import { buildAppErrorReport } from './crash-report.ts';

/** The most reports kept waiting; the oldest go first. A crash loop must not fill the phone. */
export const MAX_QUEUED_REPORTS = 20;
/** A second report of the same error within this time is not queued again. */
const REPEAT_WINDOW_MS = 60_000;

type RunMarker = { startedAtMs: number; seenAtMs: number; clean: boolean };

export type CrashReporterDeps = {
  readonly meta: MetaStore;
  readonly wall: WallClock;
  readonly appVersion: string;
  readonly platform: 'ANDROID' | 'IOS';
  readonly osVersion: string;
  /** Sends one batch; resolves on success, throws ApiError / NetworkError / SignedOutError otherwise. */
  readonly send: (reports: AppErrorReport[]) => Promise<void>;
  readonly logger: Logger;
};

export class CrashReporter {
  readonly #deps: CrashReporterDeps;
  #flushing: Promise<void> | null = null;
  #last: { key: string; atMs: number } | null = null;

  constructor(deps: CrashReporterDeps) {
    this.#deps = deps;
  }

  /** At the start of a run: report the previous run if it ended badly, then mark this one open. */
  async onStart(): Promise<void> {
    try {
      const now = this.#deps.wall.nowMs();
      const previous = await this.#deps.meta.getJson<RunMarker>(META_KEYS.runMarker);
      if (previous && previous.clean === false && Number.isFinite(previous.seenAtMs)) {
        await this.#enqueue('UNEXPECTED_CLOSE', true, undefined, Math.min(previous.seenAtMs, now));
      }
      await this.#writeMarker({ startedAtMs: now, seenAtMs: now, clean: false });
    } catch (error) {
      this.#deps.logger.warn('diagnostics.start-failed', { errorKind: errorKind(error) });
    }
  }

  /** The app left the front: the system may stop it now without that being a crash. */
  onBackground(): Promise<void> {
    return this.#mark(true);
  }

  /** The app is in front again. */
  onForeground(): Promise<void> {
    return this.#mark(false);
  }

  /** Refreshes the "last seen alive" time of the open run. Called now and then, not on every tick. */
  async touch(): Promise<void> {
    await this.#mark(null);
  }

  /** Queues a report and tries to send it. Never throws. */
  async record(kind: AppErrorKind, error: unknown, fatal: boolean): Promise<void> {
    try {
      await this.#enqueue(kind, fatal, error, this.#deps.wall.nowMs());
      await this.flush();
    } catch (failure) {
      this.#deps.logger.warn('diagnostics.record-failed', { errorKind: errorKind(failure) });
    }
  }

  /** Sends what is waiting, newest-first batches of up to the contract's limit. Never throws. */
  flush(): Promise<void> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  async #flush(): Promise<void> {
    try {
      for (;;) {
        const queue = await this.#queue();
        if (queue.length === 0) return;
        const batch = queue.slice(0, MAX_APP_ERROR_REPORTS);
        try {
          await this.#deps.send(batch);
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 429
          ) {
            // Refused: the same bytes would be refused again. Drop them and say so (no content).
            this.#deps.logger.warn('diagnostics.refused', { httpStatus: error.status, count: batch.length });
            await this.#setQueue(queue.slice(batch.length));
            continue;
          }
          return; // no network, no session, a busy server: keep them for the next try
        }
        await this.#setQueue(queue.slice(batch.length));
      }
    } catch (error) {
      this.#deps.logger.warn('diagnostics.flush-failed', { errorKind: errorKind(error) });
    }
  }

  async #enqueue(kind: AppErrorKind, fatal: boolean, error: unknown, occurredAtMs: number): Promise<void> {
    const report = buildAppErrorReport({
      kind,
      fatal,
      error,
      occurredAtMs,
      appVersion: this.#deps.appVersion,
      platform: this.#deps.platform,
      osVersion: this.#deps.osVersion,
    });
    if (!report) return;
    // The same error in a tight loop is one report, not hundreds.
    const key = JSON.stringify([report.kind, report.errorName, report.frames[0]]);
    const now = this.#deps.wall.nowMs();
    if (this.#last && this.#last.key === key && now - this.#last.atMs < REPEAT_WINDOW_MS) return;
    this.#last = { key, atMs: now };
    const queue = await this.#queue();
    queue.push(report);
    await this.#setQueue(queue.slice(-MAX_QUEUED_REPORTS));
  }

  async #queue(): Promise<AppErrorReport[]> {
    const stored = await this.#deps.meta.getJson<unknown>(META_KEYS.crashQueue);
    return Array.isArray(stored) ? (stored as AppErrorReport[]) : [];
  }

  async #setQueue(queue: AppErrorReport[]): Promise<void> {
    if (queue.length === 0) await this.#deps.meta.delete(META_KEYS.crashQueue);
    else await this.#deps.meta.setJson(META_KEYS.crashQueue, queue);
  }

  async #mark(clean: boolean | null): Promise<void> {
    try {
      const now = this.#deps.wall.nowMs();
      const current = await this.#deps.meta.getJson<RunMarker>(META_KEYS.runMarker);
      if (!current) return; // onStart has not run (reporting off)
      await this.#writeMarker({
        startedAtMs: current.startedAtMs,
        seenAtMs: now,
        clean: clean ?? current.clean,
      });
    } catch {
      // A marker that cannot be written only means one missed signal.
    }
  }

  async #writeMarker(marker: RunMarker): Promise<void> {
    await this.#deps.meta.setJson(META_KEYS.runMarker, marker);
  }
}
