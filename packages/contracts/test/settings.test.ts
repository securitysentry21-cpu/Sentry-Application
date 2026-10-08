import { describe, expect, it } from 'vitest';

import { defaultSettings, SETTING_RULES, validateSettings } from '../src/settings.ts';

function withChanges(changes: Record<string, unknown>) {
  return { ...defaultSettings(), ...changes };
}

describe('settings validation (PROD §8.3, Appendix B)', () => {
  it('accepts the defaults', () => {
    const result = validateSettings(defaultSettings());
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(validateSettings(withChanges({ 'tracking.unknown_key': 1 })).success).toBe(false);
  });

  it('rejects values outside a key’s bounds', () => {
    expect(validateSettings(withChanges({ 'geofence.radius_m': 10 })).success).toBe(false);
    expect(validateSettings(withChanges({ 'retention.audit_months': 6 })).success).toBe(false);
  });

  // Each cross-field rule must be able to fail: these are the thresholds that, if violated, make
  // a healthy phone trip freshness alerts (review C-01).
  const violations: Record<string, Record<string, number>> = {
    'shift.missed_after_minutes must be ≥ shift.late_alert_after_minutes': {
      'shift.late_alert_after_minutes': 60,
      'shift.missed_after_minutes': 30,
    },
    'shift.overrun_alert_after_minutes must be < shift.auto_end_after_minutes': {
      'shift.overrun_alert_after_minutes': 60,
      'shift.auto_end_after_minutes': 60,
    },
    'tracking.min_interval_s must be ≤ tracking.max_interval_s': {
      'tracking.min_interval_s': 60,
      'tracking.max_interval_s': 30,
    },
    'tracking.stationary_fix_interval_s must be ≥ tracking.max_interval_s': {
      'tracking.max_interval_s': 300,
      'tracking.stationary_fix_interval_s': 120,
      'freshness.location_current_max_s': 400,
    },
    'sync.upload_interval_s must be ≤ sync.heartbeat_interval_s': {
      'sync.upload_interval_s': 120,
    },
    'freshness.health_live_max_s must be ≥ sync.heartbeat_interval_s + 30': {
      'sync.heartbeat_interval_s': 120,
      'freshness.health_live_max_s': 120,
    },
    'freshness.offline_after_s must be ≥ 3 × sync.heartbeat_interval_s': {
      'sync.heartbeat_interval_s': 180,
      'freshness.health_live_max_s': 240,
      'freshness.offline_after_s': 300,
    },
    'freshness.location_current_max_s must be ≥ tracking.max_interval_s + sync.upload_interval_s + 30': {
      'freshness.location_current_max_s': 120,
    },
    'freshness.location_stale_after_s must be ≥ tracking.stationary_fix_interval_s + sync.upload_interval_s + 60':
      {
        'freshness.location_stale_after_s': 300,
      },
    'alerts.device_offline_after_s must be ≥ freshness.offline_after_s': {
      'alerts.device_offline_after_s': 200,
    },
  };

  it('has a failing example for every cross-field rule', () => {
    expect(Object.keys(violations).sort()).toEqual(SETTING_RULES.map((r) => r.message).sort());
  });

  for (const [message, changes] of Object.entries(violations)) {
    it(`rejects: ${message}`, () => {
      const result = validateSettings(withChanges(changes));
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.message)).toContain(message);
    });
  }
});
