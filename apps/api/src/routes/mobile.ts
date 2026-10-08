// Guard-app configuration and consent (ARCH §15.2, SEC §16.3). Guard self only: the guard, device
// and organization all come from the device-bound session, never from the request.
import {
  defaultSettings,
  errorEnvelopeSchema,
  MAX_BATCH_ITEMS,
  mobileConfigSchema,
  trackingConsentRequestSchema,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';
import { z } from 'zod';

import { auditActor, guardOf, orgOf } from '../context.ts';
import { uuidv7 } from '../ids.ts';
import { recordAudit } from '../repositories/audit.ts';
import { insertConsent } from '../repositories/guards.ts';
import { getSettingsRow } from '../repositories/organizations.ts';
import { defineRoute } from './registry.ts';

const GUARD_SELF = { kind: 'permission', permission: 'shifts.self' } as const;

function setting(settings: Record<string, unknown>, key: string): number {
  const value = settings[key];
  return typeof value === 'number' ? value : 0;
}

export const mobileRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/mobile/config',
    summary: 'Versions, tracking and sync parameters and feature flags for the guard app.',
    policy: { access: GUARD_SELF, ownership: 'guard-self', rateLimit: 'default', audit: null },
    responses: { 200: mobileConfigSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      const row = await withTenantTransaction(deps.db, org.id, (trx) => getSettingsRow(trx, org.id));
      const settings: Record<string, unknown> = {
        ...defaultSettings(),
        ...((row?.overrides ?? {}) as object),
      };
      const requireBackground = settings['shift.require_background_permission'] === 'WARN' ? 'WARN' : 'BLOCK';
      return {
        serverTime: deps.clock.now().toISOString(),
        minSupportedVersion: deps.config.MOBILE_MIN_VERSION,
        recommendedVersion: deps.config.MOBILE_RECOMMENDED_VERSION,
        revokedVersions: deps.config.MOBILE_REVOKED_VERSIONS,
        disclosureVersion: deps.config.DISCLOSURE_VERSION,
        organization: { id: org.id, name: org.name },
        guard: { id: guard.guardId, displayName: guard.name, preferredLocale: guard.preferredLocale },
        tracking: {
          movingDistanceFilterM: setting(settings, 'tracking.moving_distance_filter_m'),
          minIntervalS: setting(settings, 'tracking.min_interval_s'),
          maxIntervalS: setting(settings, 'tracking.max_interval_s'),
          stationaryFixIntervalS: setting(settings, 'tracking.stationary_fix_interval_s'),
          sosIntervalS: setting(settings, 'tracking.sos_interval_s'),
        },
        sync: {
          uploadIntervalS: setting(settings, 'sync.upload_interval_s'),
          heartbeatIntervalS: setting(settings, 'sync.heartbeat_interval_s'),
          maxOfflineAgeHours: setting(settings, 'sync.max_offline_age_hours'),
          maxBatchItems: MAX_BATCH_ITEMS,
        },
        shift: {
          earliestStartMinutes: setting(settings, 'shift.earliest_start_minutes'),
          autoEndAfterMinutes: setting(settings, 'shift.auto_end_after_minutes'),
          startMaxFixAgeSeconds: setting(settings, 'shift.start_max_fix_age_seconds'),
          requireBackgroundPermission: requireBackground,
        },
        features: { sos: deps.config.FEATURE_SOS, patrols: false, incidents: true },
      };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/tracking-consents',
    summary: "Records the guard's acceptance of the tracking disclosure (append-only).",
    policy: {
      access: GUARD_SELF,
      ownership: 'guard-self',
      rateLimit: 'default',
      audit: 'TRACKING_CONSENT_RECORDED',
    },
    body: trackingConsentRequestSchema,
    responses: { 201: z.object({ recordedAt: z.string() }), 422: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      const now = deps.clock.now();
      await withTenantTransaction(deps.db, org.id, async (trx) => {
        const id = uuidv7(deps.clock);
        await insertConsent(trx, {
          id,
          organizationId: org.id,
          guardId: guard.guardId,
          userId: guard.userId,
          deviceId: guard.deviceId,
          disclosureVersion: body.disclosureVersion,
          locale: body.locale,
          now,
        });
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'TRACKING_CONSENT_RECORDED',
          resourceType: 'guard',
          resourceId: guard.guardId,
          metadata: {
            disclosureVersion: body.disclosureVersion,
            locale: body.locale,
            deviceId: guard.deviceId,
          },
        });
      });
      void reply.code(201);
      return { recordedAt: now.toISOString() };
    },
  }),
];
