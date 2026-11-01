// Live operations (PROD §14, ARCH §14): the snapshot, the realtime stream, a guard's live location
// and the location history viewer.
import {
  errorEnvelopeSchema,
  guardLocationResponseSchema,
  HISTORY_GAP_S,
  HISTORY_MAX_POINTS,
  locationHistoryQuerySchema,
  locationHistoryResponseSchema,
  snapshotResponseSchema,
  streamEventSchema,
  streamQuerySchema,
  type RoutePolicy,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { downsampleTrack } from '@sentryops/domain';
import { z } from 'zod';

import { auditActor, can, orgOf, resolveContext, userOf } from '../context.ts';
import { AppError, notFound } from '../errors.ts';
import { SECURITY_HEADERS } from '../headers.ts';
import { uuidv7 } from '../ids.ts';
import { MAX_STREAMS_PER_USER, sseFrame, type StreamClient } from '../realtime/hub.ts';
import { recordAudit } from '../repositories/audit.ts';
import { getGuard } from '../repositories/guards.ts';
import { organizationSettings } from '../repositories/organizations.ts';
import {
  coverageCounts,
  deleteStreamConnection,
  insertStreamConnection,
  sequenceBounds,
  touchStreamConnection,
} from '../repositories/realtime.ts';
import {
  countShiftsNotStarted,
  getShift,
  historyEvents,
  listShifts,
  type ShiftRow,
} from '../repositories/shifts.ts';
import { historyPoints, latestConsent, liveSnapshot } from '../repositories/tracking.ts';
import { freshnessFrom, liveGuardDto } from '../services/live.ts';
import { publish, STREAM_STALE_MS } from '../services/realtime.ts';
import { defineRoute } from './registry.ts';

const LIVE = { kind: 'permission', permission: 'live.read' } as const;
const STREAM_POLICY: RoutePolicy = {
  access: LIVE,
  ownership: 'organization',
  rateLimit: 'default',
  audit: null,
  // Current positions of guards on duty only; never history.
  locationScope: 'live',
};
const LAST_EVENT_ID = /^\d{1,15}$/;
/** What a stream may have waiting to be sent before it is dropped; it reconnects and replays. */
const MAX_BUFFERED_BYTES = 1_000_000;
/** A 24-hour range at one fix a second; the viewer draws at most HISTORY_MAX_POINTS of them. */
const HISTORY_READ_LIMIT = 100_000;
/** ARCH §9.2: a shift's points run from start − 60 s to end + 60 s. */
const SHIFT_WINDOW_MS = 60_000;

const idParams = z.object({ id: z.uuid() });

export const liveRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/dashboard/snapshot',
    summary: 'Every guard on duty with tracking health and location age as separate signals (D-36).',
    policy: STREAM_POLICY,
    responses: { 200: snapshotResponseSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const now = deps.clock.now();
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        // Read first: every change after this point has a later event ID, so the stream that
        // continues from here can't miss one (ARCH §14).
        const { newest } = await sequenceBounds(trx, org.id);
        const freshness = freshnessFrom(await organizationSettings(trx, org.id));
        const rows = await liveSnapshot(trx, org.id);
        return {
          serverTime: now.toISOString(),
          lastEventId: newest,
          freshness,
          guards: rows.map((r) => liveGuardDto(r, now, freshness)),
          shiftsNotStarted: await countShiftsNotStarted(trx, org.id, now),
          coverage: await coverageCounts(trx, org.id, new Date(now.getTime() - STREAM_STALE_MS)),
        };
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/stream',
    summary:
      'Live updates as Server-Sent Events, in order: guard states, alerts, shifts and monitoring coverage (ARCH §14).',
    policy: STREAM_POLICY,
    query: streamQuerySchema,
    responses: { 200: streamEventSchema, 429: errorEnvelopeSchema },
    handler: async ({ request, reply, deps, ctx, query }) => {
      // The pipeline has checked the session, the organization (X-Organization-Id) and live.read.
      // The stream belongs to that organization only; a client can't name another (ADV-T02).
      const org = orgOf(ctx);
      const user = userOf(ctx);
      const hub = request.server.realtime;
      if (hub.closed) throw new AppError('NOT_READY', 'The server is restarting. Reconnect in a moment.');
      if (hub.streamsOf(user.userId) >= MAX_STREAMS_PER_USER) {
        throw new AppError('RATE_LIMITED', 'Too many live views are open. Close one and try again.');
      }
      const header = request.headers['last-event-id'];
      const lastEventId = typeof header === 'string' && LAST_EVENT_ID.test(header) ? Number(header) : null;
      const connectionId = uuidv7(deps.clock);

      const { start, resync } = await withTenantTransaction(deps.db, org.id, async (trx) => {
        const bounds = await sequenceBounds(trx, org.id);
        await insertStreamConnection(trx, {
          id: connectionId,
          organizationId: org.id,
          userId: user.userId,
          client: query.client === 'phone' ? 'PHONE' : 'DESKTOP',
          instanceId: hub.instanceId,
          now: deps.clock.now(),
        });
        await publish(trx, deps, org.id, 'coverage.updated', {});
        if (lastEventId === null) return { start: bounds.newest, resync: false };
        // Outside the replay buffer: from the future (a restored database) or already pruned.
        const outside = lastEventId > bounds.newest || (bounds.newest > 0 && lastEventId < bounds.oldest - 1);
        return outside ? { start: bounds.newest, resync: true } : { start: lastEventId, resync: false };
      });

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        // Proxies must pass events through as they come (ARCH §14). no-transform also stops a
        // compressing proxy from holding them back: the dashboard's dev server gzips otherwise.
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
        'x-request-id': request.id,
        'x-server-time': deps.clock.now().toISOString(),
      });
      raw.write('retry: 3000\n\n');
      if (resync) {
        raw.write(sseFrame(start, { type: 'resync', occurredAt: deps.clock.now().toISOString(), data: {} }));
      }

      let ended: Promise<void> | null = null;
      const stream: StreamClient = {
        id: connectionId,
        organizationId: org.id,
        userId: user.userId,
        canReadAlerts: can(ctx, 'alerts.read'),
        lastSent: start,
        write: (frame) => {
          if (ended || raw.destroyed) return false;
          raw.write(frame);
          return raw.writableLength <= MAX_BUFFERED_BYTES;
        },
        end: () => finish(),
      };

      // The same checks as on connect, again: a revoked session, a removed membership, a suspended
      // organization or a lost permission ends the stream (ADV-T02).
      const revalidate = async () => {
        try {
          const again = await resolveContext(request, STREAM_POLICY, deps);
          if (again.org?.id !== org.id) throw new Error('organization changed');
          stream.canReadAlerts = can(again, 'alerts.read');
          await withTenantTransaction(deps.db, org.id, (trx) =>
            touchStreamConnection(trx, org.id, connectionId, deps.clock.now()),
          );
        } catch {
          void finish();
        }
      };
      const timers = [
        setInterval(() => {
          if (!ended && !raw.destroyed) raw.write(': keep-alive\n\n');
        }, hub.timings.keepAliveMs),
        setInterval(() => void revalidate(), hub.timings.revalidateMs),
      ];
      const maxAge = setTimeout(() => void finish(), hub.timings.maxAgeMs);

      function finish(): Promise<void> {
        if (ended) return ended;
        for (const t of timers) clearInterval(t);
        clearTimeout(maxAge);
        hub.remove(stream);
        if (!raw.destroyed) raw.end();
        ended = withTenantTransaction(deps.db, org.id, async (trx) => {
          await deleteStreamConnection(trx, org.id, connectionId);
          await publish(trx, deps, org.id, 'coverage.updated', {});
        }).catch((error: unknown) => {
          request.log.warn(
            { err: error instanceof Error ? error.message : 'unknown' },
            'could not record the end of a stream',
          );
        });
        return ended;
      }
      raw.on('close', () => void finish());
      raw.on('error', () => void finish());
      // The dashboard may have gone while the stream was being set up.
      if (raw.destroyed) void finish();
      else hub.add(stream);
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/guards/:id/location',
    summary: "A guard's live state on their active shift, and the disclosure they accepted (PROD §14.4).",
    policy: STREAM_POLICY,
    params: idParams,
    responses: { 200: guardLocationResponseSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      const now = deps.clock.now();
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const guard = await getGuard(trx, org.id, params.id);
        if (!guard) throw notFound();
        const freshness = freshnessFrom(await organizationSettings(trx, org.id));
        const [row] = await liveSnapshot(trx, org.id, { guardId: guard.id });
        const consent = await latestConsent(trx, org.id, guard.id);
        return {
          serverTime: now.toISOString(),
          freshness,
          live: row ? liveGuardDto(row, now, freshness) : null,
          consent: consent
            ? {
                version: consent.disclosure_version,
                locale: consent.locale,
                acceptedAt: consent.accepted_at.toISOString(),
              }
            : null,
        };
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/guards/:id/location-history',
    summary:
      "A guard's location history for one shift or up to 24 hours, thinned for drawing. Audited before any point is read (INV-14).",
    policy: {
      access: { kind: 'permission', permission: 'location.history.read' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'LOCATION_HISTORY_VIEWED',
    },
    params: idParams,
    query: locationHistoryQuerySchema,
    responses: { 200: locationHistoryResponseSchema },
    handler: async ({ deps, ctx, params, query }) => {
      const org = orgOf(ctx);
      const now = deps.clock.now();
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const guard = await getGuard(trx, org.id, params.id);
        if (!guard) throw notFound();
        let from: Date;
        let to: Date;
        let shifts: ShiftRow[];
        if (query.shiftId) {
          const shift = await getShift(trx, org.id, query.shiftId);
          if (!shift || shift.guardId !== guard.id) throw notFound();
          from = new Date((shift.actualStartedAt ?? shift.startsAt).getTime() - SHIFT_WINDOW_MS);
          to = new Date(Math.min((shift.actualEndedAt ?? now).getTime() + SHIFT_WINDOW_MS, now.getTime()));
          shifts = [shift];
        } else {
          from = new Date(query.from!);
          to = new Date(query.to!);
          shifts = await listShifts(trx, org.id, { from, to, guardId: guard.id, limit: 100 });
        }

        // D-21: the reason field is always offered; the organization may make it mandatory.
        const reason = query.reason?.trim() || null;
        const settings = await organizationSettings(trx, org.id);
        if (settings['privacy.require_history_access_reason'] === true && !reason) {
          throw new AppError(
            'VALIDATION_FAILED',
            'Your organization asks for a reason to view location history.',
            [{ path: 'reason', issue: 'required' }],
          );
        }
        // INV-14, ADV-P02: the audit row comes first, in this transaction. If it can't be written,
        // the transaction fails and no point is ever read, let alone returned.
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'LOCATION_HISTORY_VIEWED',
          resourceType: 'guard',
          resourceId: guard.id,
          reason,
          metadata: { shiftId: query.shiftId ?? null, from: from.toISOString(), to: to.toISOString() },
        });

        const raw = await historyPoints(
          trx,
          org.id,
          { guardId: guard.id, ...(query.shiftId ? { shiftId: query.shiftId } : {}), from, to },
          HISTORY_READ_LIMIT,
        );
        const kept = downsampleTrack(
          raw.map((p) => ({ t: p.captured_at.getTime(), flagged: p.flags.length > 0 || p.is_mock === true })),
          HISTORY_MAX_POINTS,
          HISTORY_GAP_S * 1000,
        );
        const events = await historyEvents(
          trx,
          org.id,
          shifts.map((s) => s.id),
          from,
          to,
        );
        return {
          guard: { id: guard.id, displayName: guard.displayName, employeeNumber: guard.employeeNumber },
          from: from.toISOString(),
          to: to.toISOString(),
          totalPoints: raw.length,
          points: kept.map(({ index, gapBefore }) => {
            const p = raw[index]!;
            return {
              lat: p.latitude,
              lng: p.longitude,
              accuracyM: p.accuracy_m,
              capturedAt: p.captured_at.toISOString(),
              shiftId: p.shift_id,
              source: p.source,
              flags: p.flags,
              gapBefore,
            };
          }),
          shifts: shifts.map((s) => ({
            id: s.id,
            status: s.status,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt.toISOString(),
            startedAt: s.actualStartedAt?.toISOString() ?? null,
            endedAt: s.actualEndedAt?.toISOString() ?? null,
            site: { id: s.siteId, name: s.siteName, timezone: s.siteTimezone, boundary: s.siteBoundary },
          })),
          events: events.map((e) => ({
            shiftId: e.shift_id,
            type: e.type,
            occurredAt: e.occurred_at.toISOString(),
          })),
        };
      });
    },
  }),
];
