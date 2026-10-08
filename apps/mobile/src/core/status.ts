// What the phone may honestly say about its data (PROD §7.6, INV-16, ADV-U03). "All data sent" only
// when the outbox is empty and every item in it was answered by the server: items leave the outbox
// only on a server answer, or by a counted local drop (too old, thinned, another guard's), and a
// drop blocks "All data sent" until the guard has read the notice.
import type { DiscardedSummary, QueueStats } from './outbox/outbox.ts';
import type { SyncStatus } from './sync/engine.ts';

export type SyncDisplay =
  | { readonly kind: 'ALL_SENT'; readonly lastSuccessAtMs: number }
  | { readonly kind: 'NOTHING_YET' }
  | { readonly kind: 'SENDING'; readonly pending: number }
  | { readonly kind: 'WAITING'; readonly pending: number; readonly oldestAtMs: number | null }
  | { readonly kind: 'SIGNED_OUT'; readonly pending: number }
  | { readonly kind: 'UPDATE_REQUIRED'; readonly pending: number }
  | {
      readonly kind: 'DISCARDED';
      readonly count: number;
      readonly reason: string | null;
      readonly pending: number;
    };

export type SyncDisplayInput = {
  readonly queue: QueueStats;
  readonly sync: Pick<SyncStatus, 'inFlight' | 'lastSuccessAtMs' | 'blocked'>;
  readonly signedOut: boolean;
  readonly discarded: DiscardedSummary;
};

export function syncDisplay(input: SyncDisplayInput): SyncDisplay {
  const pending = input.queue.pending;
  if (input.signedOut) return { kind: 'SIGNED_OUT', pending };
  if (input.sync.blocked === 'UPDATE_REQUIRED') return { kind: 'UPDATE_REQUIRED', pending };
  if (input.discarded.count > 0) {
    return { kind: 'DISCARDED', count: input.discarded.count, reason: input.discarded.lastReason, pending };
  }
  if (pending > 0 || input.queue.inBatch > 0) {
    return input.sync.inFlight
      ? { kind: 'SENDING', pending }
      : { kind: 'WAITING', pending, oldestAtMs: input.queue.oldestRecordedAtMs };
  }
  if (input.sync.inFlight) return { kind: 'SENDING', pending: 0 };
  return input.sync.lastSuccessAtMs === null
    ? { kind: 'NOTHING_YET' }
    : { kind: 'ALL_SENT', lastSuccessAtMs: input.sync.lastSuccessAtMs };
}

/** ADV-U03: the one place that decides whether "All data sent" may be shown. */
export const allDataSent = (input: SyncDisplayInput): boolean => syncDisplay(input).kind === 'ALL_SENT';
