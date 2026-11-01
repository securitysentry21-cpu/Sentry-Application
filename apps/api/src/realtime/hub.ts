// The realtime fan-out on one API instance (ARCH §14). Streams are grouped by organization. When the
// dispatcher's NOTIFY says an organization has new events, one read serves all of that
// organization's streams here: the stored events (IDs only) are joined with the current state they
// name, and each stream is sent what its permissions allow, in sequence order. A stream never
// receives another organization's events: its group is chosen from the request's resolved
// organization, and every read runs in that organization's tenant transaction (ADV-T02).
import { randomUUID } from 'node:crypto';

import type { Alert, Coverage, LiveGuard, RealtimeEventType, StreamEvent } from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import type { FastifyBaseLogger } from 'fastify';

import type { AppDeps } from '../deps.ts';
import { alertsByIds } from '../repositories/alerts.ts';
import { RealtimeListener } from '../repositories/listener.ts';
import { organizationSettings } from '../repositories/organizations.ts';
import { coverageCounts, eventsAfter, type RealtimeRow } from '../repositories/realtime.ts';
import { shiftStatuses } from '../repositories/shifts.ts';
import { liveSnapshot } from '../repositories/tracking.ts';
import { alertDto } from '../services/alerts.ts';
import { freshnessFrom, liveGuardDto } from '../services/live.ts';
import { STREAM_STALE_MS } from '../services/realtime.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** This instance's open dashboard streams (ARCH §14); set up by buildApp. */
    realtime: RealtimeHub;
  }
}

export type HubTimings = {
  /** A comment line, so proxies keep the connection open (ARCH §14: every 25 s). */
  readonly keepAliveMs: number;
  /** The session and membership are checked again this often (ADV-T02: closed within 60 s). */
  readonly revalidateMs: number;
  /** Every stream is closed after this long and reconnects, re-authenticating (ARCH §14). */
  readonly maxAgeMs: number;
  /** Safety net: every group catches up this often, even if a NOTIFY never arrived. */
  readonly catchUpMs: number;
};

export const DEFAULT_TIMINGS: HubTimings = {
  keepAliveMs: 25_000,
  revalidateMs: 30_000,
  maxAgeMs: 30 * 60_000,
  catchUpMs: 10_000,
};

/** Streams one person may hold open at once: a few tabs and a phone. */
export const MAX_STREAMS_PER_USER = 10;
const PAGE = 500;

export type StreamClient = {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  /** Re-checked with the membership every revalidation. */
  canReadAlerts: boolean;
  /** The last sequence this stream was sent, or passed over because it may not see it. */
  lastSent: number;
  /** Sends one frame; false when the stream fell too far behind and must close. */
  write(frame: string): boolean;
  /** Closes the stream; resolves once its departure is recorded. */
  end(): Promise<void>;
};

type Group = { clients: Set<StreamClient>; running: boolean; again: boolean };
type Outgoing = { seq: number; alertsOnly: boolean; frame: string };

/** One SSE event: `id:` is the organization's sequence (ARCH §14 envelope in `data:`). */
export function sseFrame(seq: number | null, event: StreamEvent): string {
  const id = seq === null ? '' : `id: ${seq}\n`;
  const envelope = { id: seq === null ? null : String(seq), ...event };
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

export class RealtimeHub {
  readonly instanceId = `api-${randomUUID()}`;
  readonly timings: HubTimings;
  readonly #deps: AppDeps;
  readonly #log: FastifyBaseLogger;
  readonly #groups = new Map<string, Group>();
  #listener: RealtimeListener | null = null;
  #catchUp: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(deps: AppDeps, log: FastifyBaseLogger, timings: Partial<HubTimings> = {}) {
    this.#deps = deps;
    this.#log = log;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
  }

  get closed(): boolean {
    return this.#closed;
  }

  streamsOf(userId: string): number {
    let n = 0;
    for (const group of this.#groups.values()) for (const c of group.clients) if (c.userId === userId) n++;
    return n;
  }

  add(client: StreamClient): void {
    if (this.#closed) {
      void client.end();
      return;
    }
    let group = this.#groups.get(client.organizationId);
    if (!group) {
      group = { clients: new Set(), running: false, again: false };
      this.#groups.set(client.organizationId, group);
    }
    group.clients.add(client);
    this.#startListening();
    void this.pump(client.organizationId);
  }

  remove(client: StreamClient): void {
    const group = this.#groups.get(client.organizationId);
    if (!group) return;
    group.clients.delete(client);
    if (group.clients.size === 0 && !group.running) this.#groups.delete(client.organizationId);
  }

  notify(organizationId: string): void {
    if (this.#groups.has(organizationId)) void this.pump(organizationId);
  }

  /** Ends every stream; dashboards reconnect to another instance and replay what they missed. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#catchUp) clearInterval(this.#catchUp);
    const ending: Promise<void>[] = [];
    for (const group of this.#groups.values()) for (const client of group.clients) ending.push(client.end());
    this.#groups.clear();
    await Promise.all(ending);
    await this.#listener?.stop();
  }

  /** Sends an organization's new events to its streams. Runs once at a time per organization. */
  async pump(organizationId: string): Promise<void> {
    const group = this.#groups.get(organizationId);
    if (!group) return;
    if (group.running) {
      group.again = true;
      return;
    }
    group.running = true;
    try {
      do {
        group.again = false;
        const clients = [...group.clients];
        if (clients.length === 0) break;
        const from = Math.min(...clients.map((c) => c.lastSent));
        const batch = await this.#read(organizationId, from);
        for (const client of clients) {
          if (!group.clients.has(client)) continue;
          for (const event of batch) {
            if (event.seq <= client.lastSent) continue;
            client.lastSent = event.seq;
            if (event.alertsOnly && !client.canReadAlerts) continue;
            if (!client.write(event.frame)) {
              void client.end();
              break;
            }
          }
        }
        if (batch.length === PAGE) group.again = true;
      } while (group.again && !this.#closed);
    } catch (error) {
      this.#log.error(
        { organization_id: organizationId, err: error instanceof Error ? error.message : 'unknown' },
        'realtime fan-out failed',
      );
    } finally {
      group.running = false;
      if (group.clients.size === 0) this.#groups.delete(organizationId);
      else if (group.again && !this.#closed) void this.pump(organizationId);
    }
  }

  #startListening(): void {
    if (this.#listener || this.#closed) return;
    this.#listener = new RealtimeListener(this.#deps.config.DATABASE_URL, {
      onNotify: (organizationId) => this.notify(organizationId),
      onConnected: () => this.#catchUpAll(),
      onError: (message) => this.#log.warn({ err: message }, 'realtime listener disconnected; retrying'),
    });
    this.#listener.start();
    this.#catchUp = setInterval(() => this.#catchUpAll(), this.timings.catchUpMs);
    this.#catchUp.unref();
  }

  #catchUpAll(): void {
    for (const organizationId of this.#groups.keys()) void this.pump(organizationId);
  }

  /** The events after `after`, each with the current state it names. */
  async #read(organizationId: string, after: number): Promise<Outgoing[]> {
    return withTenantTransaction(this.#deps.db, organizationId, async (trx) => {
      const rows = await eventsAfter(trx, organizationId, after, PAGE);
      if (rows.length === 0) return [];
      const now = this.#deps.clock.now();
      const named = (types: readonly RealtimeEventType[], key: string) => [
        ...new Set(rows.filter((r) => types.includes(r.type)).map((r) => String(r.payload[key] ?? ''))),
      ];

      const live = new Map<string, LiveGuard>();
      const liveIds = named(['guard.state'], 'shiftId');
      if (liveIds.length > 0) {
        const freshness = freshnessFrom(await organizationSettings(trx, organizationId));
        for (const r of await liveSnapshot(trx, organizationId, { shiftIds: liveIds })) {
          live.set(r.shift_id, liveGuardDto(r, now, freshness));
        }
      }
      const alerts = new Map<string, Alert>(
        (await alertsByIds(trx, organizationId, named(['alert.opened', 'alert.updated'], 'alertId'))).map(
          (a) => [a.id, alertDto(a)],
        ),
      );
      const statuses = await shiftStatuses(trx, organizationId, named(['shift.updated'], 'shiftId'));
      const coverage = rows.some((r) => r.type === 'coverage.updated')
        ? await coverageCounts(trx, organizationId, new Date(now.getTime() - STREAM_STALE_MS))
        : null;

      return rows.map((r) => ({
        seq: r.seq,
        alertsOnly: r.type === 'alert.opened' || r.type === 'alert.updated',
        frame: sseFrame(r.seq, toEvent(r, live, alerts, statuses, coverage)),
      }));
    });
  }
}

function toEvent(
  r: RealtimeRow,
  live: ReadonlyMap<string, LiveGuard>,
  alerts: ReadonlyMap<string, Alert>,
  statuses: ReadonlyMap<string, string>,
  coverage: Coverage | null,
): StreamEvent {
  const occurredAt = r.createdAt.toISOString();
  switch (r.type) {
    case 'guard.state': {
      const shiftId = String(r.payload.shiftId ?? '');
      return { type: r.type, occurredAt, data: { shiftId, guard: live.get(shiftId) ?? null } };
    }
    case 'alert.opened':
    case 'alert.updated': {
      const alertId = String(r.payload.alertId ?? '');
      return { type: r.type, occurredAt, data: { alertId, alert: alerts.get(alertId) ?? null } };
    }
    case 'shift.updated': {
      const shiftId = String(r.payload.shiftId ?? '');
      return { type: r.type, occurredAt, data: { shiftId, status: statuses.get(shiftId) ?? null } };
    }
    case 'coverage.updated':
      return { type: r.type, occurredAt, data: { coverage: coverage ?? { desktop: 0, phone: 0 } } };
  }
}
