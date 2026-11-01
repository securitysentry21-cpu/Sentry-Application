// The outbox dispatcher (ARCH §14, §16.1–§16.2), every half second in the worker:
//   1. as system_worker, list the organizations with pending outbox rows (their IDs only);
//   2. for each, as app_runtime in that organization's tenant transaction and under its sequence
//      lock: number the pending rows after the newest event, copy them into realtime_events, mark
//      them processed and NOTIFY the API instances, which is sent when the transaction commits.
// The sequence is therefore assigned after the business transaction committed, in the order the
// dispatcher commits: a client that reconnects with Last-Event-ID can't skip an event.
// Each run also prunes the replay buffer. With the detectors (every minute), a sweep removes streams
// that an API instance left behind when it stopped.
import { withTenantTransaction, type Database } from '@sentryops/db';

import type { AppDeps } from '../deps.ts';
import {
  deleteStaleConnections,
  insertRealtimeEvents,
  lastSequence,
  lockOrganizationSequence,
  markProcessed,
  notifyOrganization,
  organizationsWithPendingOutbox,
  organizationsWithStaleConnections,
  pendingOutbox,
  pruneOutbox,
  pruneRealtimeEvents,
} from '../repositories/realtime.ts';
import { publish, STREAM_STALE_MS } from '../services/realtime.ts';

export type DispatcherDeps = AppDeps & { readonly sweep: Database };

/** ARCH §14: the replay buffer holds 5 minutes, at most 10,000 events per organization. */
export const BUFFER_MS = 5 * 60_000;
export const BUFFER_MAX_EVENTS = 10_000;
const PROCESSED_KEPT_MS = 3_600_000;
const BATCH = 1000;
const ORGANIZATIONS_PER_RUN = 500;

/** Moves one organization's pending rows; returns how many moved. */
export async function dispatchOrganization(deps: AppDeps, organizationId: string): Promise<number> {
  return withTenantTransaction(deps.db, organizationId, async (trx) => {
    await lockOrganizationSequence(trx, organizationId);
    const rows = await pendingOutbox(trx, organizationId, BATCH);
    if (rows.length === 0) return 0;
    const now = deps.clock.now();
    let seq = await lastSequence(trx, organizationId);
    await insertRealtimeEvents(
      trx,
      organizationId,
      rows.map((r) => ({ id: r.id, seq: ++seq, type: r.topic, payload: r.payload, createdAt: r.createdAt })),
    );
    await markProcessed(
      trx,
      organizationId,
      rows.map((r) => r.id),
      now,
    );
    await pruneRealtimeEvents(
      trx,
      organizationId,
      new Date(now.getTime() - BUFFER_MS),
      seq,
      BUFFER_MAX_EVENTS,
    );
    await pruneOutbox(trx, organizationId, new Date(now.getTime() - PROCESSED_KEPT_MS));
    await notifyOrganization(trx, organizationId);
    return rows.length;
  });
}

export async function runDispatcher(
  deps: DispatcherDeps,
): Promise<{ organizations: number; events: number }> {
  const organizations = await organizationsWithPendingOutbox(deps.sweep, ORGANIZATIONS_PER_RUN);
  let events = 0;
  for (const organizationId of organizations) {
    // A large backlog drains in batches, without starving other organizations for long.
    for (let round = 0; round < 10; round++) {
      const moved = await dispatchOrganization(deps, organizationId);
      events += moved;
      if (moved < BATCH) break;
    }
  }
  return { organizations: organizations.length, events };
}

/** Removes streams an API instance left behind, and tells those organizations' dashboards. */
export async function sweepStaleStreams(deps: DispatcherDeps): Promise<number> {
  const before = new Date(deps.clock.now().getTime() - STREAM_STALE_MS);
  const organizations = await organizationsWithStaleConnections(deps.sweep, before, ORGANIZATIONS_PER_RUN);
  let removed = 0;
  for (const organizationId of organizations) {
    removed += await withTenantTransaction(deps.db, organizationId, async (trx) => {
      const n = await deleteStaleConnections(trx, organizationId, before);
      if (n > 0) await publish(trx, deps, organizationId, 'coverage.updated', {});
      return n;
    });
  }
  return removed;
}
