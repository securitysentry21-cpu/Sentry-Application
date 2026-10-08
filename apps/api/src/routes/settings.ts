// Organization settings (PROD §8.3, Appendix B). Stored as overrides on top of the defaults in
// packages/contracts; every write validates the merged result, cross-field rules included. Only the
// keys marked dashboardEditable can change here (P-06); the operator sets the rest.
import {
  defaultSettings,
  errorEnvelopeSchema,
  SETTINGS,
  settingsPatchRequestSchema,
  settingsResponseSchema,
  validateSettings,
  type SettingKey,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';

import { auditActor, can, orgOf, userOf } from '../context.ts';
import { AppError, validationError } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import { getSettingsRow, saveSettings } from '../repositories/organizations.ts';
import { defineRoute } from './registry.ts';

/** Settings whose values are phone numbers are audited as "changed", never by value (SEC §17.2). */
const MASKED: ReadonlySet<string> = new Set(['sos.emergency_contacts', 'sos.emergency_call_number']);

const EDITABLE = Object.entries(SETTINGS)
  .filter(([, def]) => def.dashboardEditable && def.scope === 'organization')
  .map(([key]) => key as SettingKey)
  .sort();

function merged(overrides: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = defaultSettings();
  if (overrides && typeof overrides === 'object') {
    for (const [key, value] of Object.entries(overrides)) if (key in base) base[key] = value;
  }
  return base;
}

export const settingsRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/settings',
    summary: 'Organization settings, defaults merged with overrides.',
    policy: {
      access: { kind: 'permission', permission: 'org.settings.read' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: null,
    },
    responses: { 200: settingsResponseSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const row = await withTenantTransaction(deps.db, org.id, (trx) => getSettingsRow(trx, org.id));
      return {
        settings: merged(row?.overrides),
        editableKeys: can(ctx, 'org.settings.write') ? EDITABLE : [],
        version: row?.version ?? 1,
      };
    },
  }),

  defineRoute({
    method: 'PATCH',
    url: '/api/v1/settings',
    summary: 'Changes dashboard-editable settings.',
    policy: {
      access: { kind: 'permission', permission: 'org.settings.write' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'SETTINGS_CHANGED',
    },
    body: settingsPatchRequestSchema,
    responses: { 200: settingsResponseSchema, 400: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const keys = Object.keys(body.changes);
      if (keys.length === 0) throw new AppError('VALIDATION_FAILED', 'Nothing to change.');
      const notEditable = keys.filter((k) => !EDITABLE.includes(k as SettingKey));
      if (notEditable.length > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Some settings cannot be changed from the dashboard.',
          notEditable.map((path) => ({ path, issue: 'not editable from the dashboard' })),
        );
      }
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const row = await getSettingsRow(trx, org.id);
        if (!row) throw new AppError('NOT_FOUND', 'Not found.');
        if (row.version !== body.version) {
          throw new AppError(
            'VERSION_CONFLICT',
            'Settings were changed by someone else.',
            undefined,
            undefined,
            {
              settings: merged(row.overrides),
              version: row.version,
            },
          );
        }
        const before = merged(row.overrides);
        const after = { ...before, ...body.changes };
        const check = validateSettings(after);
        if (!check.success) throw validationError(check.error);
        const overrides = { ...(row.overrides as Record<string, unknown>), ...body.changes };
        if (
          !(await saveSettings(trx, {
            organizationId: org.id,
            overrides,
            version: row.version,
            userId: actor.userId,
            now: deps.clock.now(),
          }))
        ) {
          throw new AppError('VERSION_CONFLICT', 'Settings were changed by someone else.');
        }
        const changes = Object.fromEntries(
          keys.map((k) => [k, MASKED.has(k) ? 'changed' : { from: before[k], to: body.changes[k] }]),
        );
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'SETTINGS_CHANGED',
          resourceType: 'organization',
          resourceId: org.id,
          metadata: { changes },
        });
        return { settings: after, editableKeys: EDITABLE, version: row.version + 1 };
      });
    },
  }),
];
