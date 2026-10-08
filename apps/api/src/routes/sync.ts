// POST /sync/batch (ARCH §9.1) and the live snapshot (ARCH §14, D-36).
import {
  errorEnvelopeSchema,
  GUARD_LOCATION,
  syncBatchRequestSchema,
  syncBatchResponseSchema,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { locationAge, trackingHealth } from '@sentryops/domain';
import { z } from 'zod';

import { guardOf, orgOf } from '../context.ts';
import { numberSetting, organizationSettings } from '../repositories/organizations.ts';
import { liveSnapshot } from '../repositories/tracking.ts';
import { processBatch } from '../services/sync.ts';
import { defineRoute } from './registry.ts';

const freshness = z.object({ healthLiveMaxS: z.int(), offlineAfterS: z.int(), locationCurrentMaxS: z.int() });

export const liveGuardSchema = z.object({
  shiftId: z.uuid(),
  guard: z.object({ id: z.uuid(), displayName: z.string(), employeeNumber: z.string() }),
  site: z.object({ id: z.uuid(), name: z.string() }),
  startedAt: z.string().nullable(),
  endsAt: z.string(),
  manualStart: z.boolean(),
  startFlags: z.array(z.string()),
  /** A live coordinate: the snapshot is live-only, never history (ADV-X05, INV-14). */
  lastFix: z
    .object({ lat: z.number(), lng: z.number(), accuracyM: z.number().nullable(), capturedAt: z.string() })
    .meta(GUARD_LOCATION)
    .nullable(),
  lastContactAt: z.string().nullable(),
  trackingHealth: z.enum(['LIVE', 'DELAYED', 'OFFLINE']),
  locationAge: z.enum(['CURRENT', 'LAST_KNOWN', 'UNKNOWN']),
  trackingServiceState: z.string().nullable(),
  locationPermission: z.string().nullable(),
  batteryPct: z.number().nullable(),
  pendingQueueCount: z.int().nullable(),
});

export const syncRoutes = [
  defineRoute({
    method: 'POST',
    url: '/api/v1/sync/batch',
    summary: "The guard app's ordered upload: start, end, locations, heartbeats and device status.",
    policy: {
      access: { kind: 'permission', permission: 'shifts.self' },
      ownership: 'guard-self',
      rateLimit: 'sync',
      audit: null,
      replacedDeviceDrain: true,
    },
    body: syncBatchRequestSchema,
    responses: { 200: syncBatchResponseSchema, 429: errorEnvelopeSchema },
    handler: async ({ request, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      deps.rateLimiter.hit('sync', 'device', guard.deviceId);
      const appVersion =
        typeof request.headers['x-app-version'] === 'string'
          ? request.headers['x-app-version'].slice(0, 40)
          : null;
      return processBatch(
        deps,
        {
          organizationId: org.id,
          guardId: guard.guardId,
          deviceId: guard.deviceId,
          userId: guard.userId,
          appVersion,
          replacedAt: guard.replacedAt,
        },
        body,
      );
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/dashboard/snapshot',
    summary: 'Every guard on duty with tracking health and location age as separate signals (D-36).',
    policy: {
      access: { kind: 'permission', permission: 'live.read' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: null,
      // Current positions of guards on active shifts only; never history.
      locationScope: 'live',
    },
    responses: { 200: z.object({ serverTime: z.string(), freshness, guards: z.array(liveGuardSchema) }) },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const now = deps.clock.now();
      const { rows, settings } = await withTenantTransaction(deps.db, org.id, async (trx) => ({
        rows: await liveSnapshot(trx, org.id),
        settings: await organizationSettings(trx, org.id),
      }));
      const f = {
        healthLiveMaxS: numberSetting(settings, 'freshness.health_live_max_s', 90),
        offlineAfterS: numberSetting(settings, 'freshness.offline_after_s', 300),
        locationCurrentMaxS: numberSetting(settings, 'freshness.location_current_max_s', 150),
      };
      return {
        serverTime: now.toISOString(),
        freshness: f,
        guards: rows.map((r) => ({
          shiftId: r.shift_id,
          guard: { id: r.guard_id, displayName: r.display_name, employeeNumber: r.employee_number },
          site: { id: r.site_id, name: r.site_name },
          startedAt: r.actual_started_at?.toISOString() ?? null,
          endsAt: r.ends_at.toISOString(),
          manualStart: r.start_source === 'SUPERVISOR_MANUAL',
          startFlags: r.start_flags,
          lastFix:
            r.last_fix_latitude !== null && r.last_fix_longitude !== null && r.last_fix_captured_at
              ? {
                  lat: r.last_fix_latitude,
                  lng: r.last_fix_longitude,
                  accuracyM: r.last_fix_accuracy_m,
                  capturedAt: r.last_fix_captured_at.toISOString(),
                }
              : null,
          lastContactAt: r.last_contact_at?.toISOString() ?? null,
          trackingHealth: trackingHealth(now, r.last_contact_at, f),
          locationAge: locationAge(now, r.last_fix_captured_at, f),
          trackingServiceState: r.tracking_service_state,
          locationPermission: r.location_permission,
          batteryPct: r.battery_pct,
          pendingQueueCount: r.pending_queue_count,
        })),
      };
    },
  }),
];
