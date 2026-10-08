// Organization settings — the implementation of PROD Appendix B. A test (ADV-X04) fails if the
// defaults here and the table in the spec differ. Cross-field rules implement PROD §8.3 and
// Appendix B so a healthy phone can never trip a freshness threshold (review C-01).
import { z } from 'zod';

import { ROLES } from './permissions.ts';

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'must be an E.164 phone number');

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const CHANNELS = ['DASHBOARD', 'WEB_PUSH', 'SMS'] as const;

const routingRule = z.object({
  roles: z.array(z.enum(ROLES)),
  channels: z.array(z.enum(CHANNELS)),
  escalate: z.boolean(),
});

const escalationStep = z.object({
  atSeconds: int(0, 3600),
  dashboardAlarm: z.boolean(),
  webPushTo: z.array(z.enum(ROLES)),
  smsTo: z.array(z.enum(ROLES)),
  smsEmergencyContacts: z.boolean(),
});

export type SettingScope = 'organization' | 'system';

type SettingDef = {
  readonly schema: z.ZodType;
  readonly default: unknown;
  readonly scope: SettingScope;
  /** P-06: only these few are editable in the V1 dashboard; the operator sets the rest. */
  readonly dashboardEditable: boolean;
  readonly note: string;
};

const s = (
  schema: z.ZodType,
  defaultValue: unknown,
  note: string,
  options: { scope?: SettingScope; dashboardEditable?: boolean } = {},
): SettingDef => ({
  schema,
  default: defaultValue,
  scope: options.scope ?? 'organization',
  dashboardEditable: options.dashboardEditable ?? false,
  note,
});

export const SETTINGS = {
  'shift.earliest_start_minutes': s(int(0, 120), 30, '0–120'),
  'shift.late_alert_after_minutes': s(int(1, 120), 10, '1–120', { dashboardEditable: true }),
  'shift.missed_after_minutes': s(int(1, 1440), 120, '≥ late_alert_after', { dashboardEditable: true }),
  'shift.auto_end_after_minutes': s(int(15, 240), 60, '15–240'),
  'shift.overrun_alert_after_minutes': s(int(1, 239), 15, '< auto_end_after'),
  'shift.start_max_fix_age_seconds': s(int(30, 600), 120, '30–600'),
  'shift.start_required_accuracy_m': s(int(5, 5000), 100, 'flag only'),
  'shift.require_background_permission': s(z.enum(['BLOCK', 'WARN']), 'BLOCK', 'BLOCK · WARN'),
  'shift.start_outside_geofence': s(
    z.enum(['ALLOW_AND_FLAG', 'BLOCK']),
    'ALLOW_AND_FLAG',
    'ALLOW_AND_FLAG · BLOCK (D-15)',
  ),
  'shift.reminder_minutes_before': s(int(0, 240), 30, '0 = off'),
  'tracking.moving_distance_filter_m': s(int(10, 100), 20, '10–100'),
  'tracking.min_interval_s': s(int(5, 60), 15, '5–60'),
  'tracking.max_interval_s': s(int(30, 300), 60, '30–300'),
  'tracking.stationary_fix_interval_s': s(int(60, 900), 300, '60–900'),
  'tracking.sos_interval_s': s(int(5, 30), 10, '5–30'),
  'tracking.sos_max_hours': s(int(1, 12), 4, '1–12'),
  'sync.upload_interval_s': s(int(15, 300), 60, '15–300'),
  'sync.heartbeat_interval_s': s(int(30, 300), 60, '30–300; provisional, Phase 0B sets the default'),
  'sync.max_offline_age_hours': s(int(1, 720), 168, 'older data rejected', { scope: 'system' }),
  'freshness.health_live_max_s': s(int(30, 900), 90, '≥ heartbeat interval + 30'),
  'freshness.offline_after_s': s(int(60, 3600), 300, '≥ 3 × heartbeat interval'),
  'freshness.location_current_max_s': s(
    int(30, 1800),
    150,
    '≥ tracking.max_interval_s + upload interval + 30',
  ),
  'freshness.location_stale_after_s': s(
    int(60, 3600),
    420,
    '≥ stationary fix interval + upload interval + 60',
  ),
  'alerts.device_offline_after_s': s(int(60, 7200), 600, '≥ freshness.offline_after_s'),
  'geofence.radius_m': s(int(50, 5000), 100, 'system bounds 50–5,000', { dashboardEditable: true }),
  'geofence.max_usable_accuracy_m': s(int(20, 500), 100, '20–500'),
  'geofence.outside_buffer_m': s(int(0, 200), 25, '0–200'),
  'geofence.departure_persistence_s': s(int(60, 1800), 300, '60–1,800'),
  'geofence.departure_min_points': s(int(2, 10), 3, '2–10'),
  'geofence.return_accuracy_m': s(int(5, 500), 50, ''),
  'checkpoint.radius_m': s(int(10, 500), 30, 'system bounds 10–500'),
  'checkpoint.max_fix_age_s': s(int(5, 120), 30, '5–120'),
  'checkpoint.max_usable_accuracy_m': s(int(10, 200), 50, '10–200'),
  'checkpoint.duplicate_window_s': s(int(0, 3600), 300, '0–3,600'),
  'checkpoint.max_plausible_speed_mps': s(int(2, 50), 15, '2–50'),
  'patrol.count_unconfirmed_as_completed': s(z.boolean(), true, 'D-17'),
  'patrol.treat_mock_as_unconfirmed': s(z.boolean(), true, ''),
  'alerts.reopen_suppression_s': s(int(0, 1800), 120, '0–1,800'),
  'alerts.incident_high_enabled': s(z.boolean(), true, ''),
  'alerts.routing': s(
    z.record(z.enum(SEVERITIES), routingRule),
    {
      CRITICAL: {
        roles: ['SUPERVISOR', 'DISPATCHER', 'ADMIN'],
        channels: ['DASHBOARD', 'WEB_PUSH'],
        escalate: true,
      },
      HIGH: { roles: ['SUPERVISOR'], channels: ['DASHBOARD', 'WEB_PUSH'], escalate: false },
      MEDIUM: { roles: [], channels: ['DASHBOARD'], escalate: false },
      LOW: { roles: [], channels: ['DASHBOARD'], escalate: false },
    },
    'see PROD §12.5',
    { dashboardEditable: true },
  ),
  'sos.hold_duration_ms': s(int(1000, 10000), 3000, '', { scope: 'system' }),
  'sos.escalation': s(
    z.object({ steps: z.array(escalationStep).min(1), repeatEverySeconds: int(30, 3600) }),
    {
      steps: [
        {
          atSeconds: 0,
          dashboardAlarm: true,
          webPushTo: ['SUPERVISOR', 'DISPATCHER', 'ADMIN'],
          smsTo: ['SUPERVISOR'],
          smsEmergencyContacts: false,
        },
        {
          atSeconds: 60,
          dashboardAlarm: true,
          webPushTo: ['SUPERVISOR', 'DISPATCHER', 'ADMIN'],
          smsTo: ['ADMIN'],
          smsEmergencyContacts: false,
        },
        {
          atSeconds: 180,
          dashboardAlarm: true,
          webPushTo: ['OWNER'],
          smsTo: ['OWNER'],
          smsEmergencyContacts: true,
        },
      ],
      repeatEverySeconds: 120,
    },
    'PROD §11.4',
    { dashboardEditable: true },
  ),
  'sos.sms_include_coordinates': s(z.boolean(), false, '', { dashboardEditable: true }),
  'sos.emergency_contacts': s(z.array(e164).max(10), [], 'phone numbers', { dashboardEditable: true }),
  'sos.emergency_call_number': s(e164.nullable(), null, 'used by "Call supervisor"', {
    dashboardEditable: true,
  }),
  'battery.low_alert_pct': s(int(5, 50), 15, '5–50'),
  'privacy.require_history_access_reason': s(z.boolean(), false, 'D-21', { dashboardEditable: true }),
  'retention.location_days': s(int(7, 3650), 90, 'legal review', { dashboardEditable: true }),
  'retention.device_status_days': s(int(7, 3650), 30, ''),
  'retention.operational_months': s(int(1, 120), 12, ''),
  'retention.audit_months': s(int(12, 120), 24, '≥ 12'),
  'retention.incident_evidence_window_minutes': s(int(0, 240), 30, 'location kept around incidents/SOS'),
  'notifications.non_sos_sms_monthly_cap': s(int(0, 100000), 3000, 'SOS never capped'),
  'exports.max_range_days': s(int(1, 366), 92, '', { scope: 'system' }),
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export type Settings = { [K in SettingKey]: unknown };

export function defaultSettings(): Settings {
  return Object.fromEntries(
    Object.entries(SETTINGS).map(([key, def]) => [key, structuredClone(def.default)]),
  ) as Settings;
}

type Rule = { message: string; holds: (v: Record<SettingKey, number>) => boolean };

// Cross-field rules (PROD §8.3, Appendix B).
export const SETTING_RULES: readonly Rule[] = [
  {
    message: 'shift.missed_after_minutes must be ≥ shift.late_alert_after_minutes',
    holds: (v) => v['shift.missed_after_minutes'] >= v['shift.late_alert_after_minutes'],
  },
  {
    message: 'shift.overrun_alert_after_minutes must be < shift.auto_end_after_minutes',
    holds: (v) => v['shift.overrun_alert_after_minutes'] < v['shift.auto_end_after_minutes'],
  },
  {
    message: 'tracking.min_interval_s must be ≤ tracking.max_interval_s',
    holds: (v) => v['tracking.min_interval_s'] <= v['tracking.max_interval_s'],
  },
  {
    message: 'freshness.health_live_max_s must be ≥ sync.heartbeat_interval_s + 30',
    holds: (v) => v['freshness.health_live_max_s'] >= v['sync.heartbeat_interval_s'] + 30,
  },
  {
    message: 'freshness.offline_after_s must be ≥ 3 × sync.heartbeat_interval_s',
    holds: (v) => v['freshness.offline_after_s'] >= 3 * v['sync.heartbeat_interval_s'],
  },
  {
    message:
      'freshness.location_current_max_s must be ≥ tracking.max_interval_s + sync.upload_interval_s + 30',
    holds: (v) =>
      v['freshness.location_current_max_s'] >=
      v['tracking.max_interval_s'] + v['sync.upload_interval_s'] + 30,
  },
  {
    message:
      'freshness.location_stale_after_s must be ≥ tracking.stationary_fix_interval_s + sync.upload_interval_s + 60',
    holds: (v) =>
      v['freshness.location_stale_after_s'] >=
      v['tracking.stationary_fix_interval_s'] + v['sync.upload_interval_s'] + 60,
  },
  {
    message: 'alerts.device_offline_after_s must be ≥ freshness.offline_after_s',
    holds: (v) => v['alerts.device_offline_after_s'] >= v['freshness.offline_after_s'],
  },
];

const shape = Object.fromEntries(Object.entries(SETTINGS).map(([key, def]) => [key, def.schema])) as Record<
  SettingKey,
  z.ZodType
>;

export const settingsSchema = z
  .object(shape)
  .strict()
  .superRefine((value, ctx) => {
    const numbers = value as Record<SettingKey, number>;
    for (const rule of SETTING_RULES) {
      if (!rule.holds(numbers)) ctx.addIssue({ code: 'custom', message: rule.message });
    }
  });

export function validateSettings(candidate: unknown) {
  return settingsSchema.safeParse(candidate);
}
