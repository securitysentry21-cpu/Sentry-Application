import { describe, expect, it } from 'vitest';

import {
  checkApiOrigin,
  compareVersions,
  ConfigError,
  DEFAULT_SETTINGS,
  effectiveSettings,
  validateRuntimeConfig,
  versionGate,
} from '../src/core/config.ts';
import { normalizePhone } from '../src/core/app.ts';
import { testConfig } from './support/fake-server.ts';

describe('build configuration (SEC §11)', () => {
  it('only development builds may use plain HTTP; staging and production need HTTPS', () => {
    expect(validateRuntimeConfig({ variant: 'development', apiBaseUrl: 'http://10.0.2.2:4000' })).toEqual({
      variant: 'development',
      apiBaseUrl: 'http://10.0.2.2:4000',
    });
    expect(() =>
      validateRuntimeConfig({ variant: 'staging', apiBaseUrl: 'http://staging.example.com' }),
    ).toThrow(ConfigError);
    expect(() =>
      validateRuntimeConfig({ variant: 'production', apiBaseUrl: 'http://api.example.com' }),
    ).toThrow(ConfigError);
    expect(
      validateRuntimeConfig({ variant: 'production', apiBaseUrl: 'https://api.example.com/' }).apiBaseUrl,
    ).toBe('https://api.example.com');
  });

  it('accepts an origin only, never a path, query or credentials', () => {
    for (const bad of [
      'https://api.example.com/v1',
      'https://user:pw@api.example.com',
      'https://api.example.com?x=1',
      'ftp://x.com',
      '',
    ]) {
      expect(() => checkApiOrigin(bad, 'production'), bad).toThrow(ConfigError);
    }
  });

  it('refuses an unknown variant or a missing URL', () => {
    expect(() => validateRuntimeConfig({ variant: 'beta', apiBaseUrl: 'https://x.example' })).toThrow(
      ConfigError,
    );
    expect(() => validateRuntimeConfig({ variant: 'production' })).toThrow(ConfigError);
    expect(() => validateRuntimeConfig(undefined)).toThrow(ConfigError);
  });
});

describe('server settings (ARCH §15.2)', () => {
  it('uses the product defaults with every optional feature off until the first config arrives', () => {
    expect(effectiveSettings(null)).toBe(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.features).toEqual({ sos: false, patrols: false, incidents: false });
    expect(DEFAULT_SETTINGS.sync.heartbeatIntervalS).toBe(60);
  });

  it('clamps nonsense values so a bad setting cannot stop tracking or uploads', () => {
    const config = testConfig({
      tracking: {
        movingDistanceFilterM: 0,
        minIntervalS: 0,
        maxIntervalS: 1,
        stationaryFixIntervalS: 0,
        sosIntervalS: 0,
      },
      sync: { uploadIntervalS: 0, heartbeatIntervalS: 0, maxOfflineAgeHours: 0, maxBatchItems: 100_000 },
    });
    const s = effectiveSettings(config);
    expect(s.tracking.minIntervalS).toBe(5);
    expect(s.tracking.maxIntervalS).toBeGreaterThanOrEqual(s.tracking.minIntervalS);
    expect(s.tracking.stationaryFixIntervalS).toBeGreaterThanOrEqual(s.tracking.maxIntervalS);
    expect(s.sync.maxBatchItems).toBe(500);
    expect(s.sync.heartbeatIntervalS).toBe(15);
    expect(s.sync.maxOfflineAgeHours).toBe(1);
  });

  it('dials the supervisor only with a plausible E.164 number; otherwise an empty dialer', () => {
    expect(effectiveSettings(testConfig()).support.emergencyCallNumber).toBeNull();
    const set = (n: string | null) =>
      effectiveSettings(testConfig({ support: { emergencyCallNumber: n } })).support.emergencyCallNumber;
    expect(set('+923001234567')).toBe('+923001234567');
    expect(set(null)).toBeNull();
    // Nothing that is not a phone number ever reaches a tel: link.
    for (const bad of ['0300 1234567', '+92;300', 'tel:+92300', '+0123456789', '+1'])
      expect(set(bad)).toBeNull();
  });

  it('gates the app version: revoked, below minimum, below recommended', () => {
    const base = testConfig({
      minSupportedVersion: '0.2.0',
      recommendedVersion: '0.3.0',
      revokedVersions: ['0.1.5'],
    });
    expect(versionGate('0.1.9', base)).toBe('UPDATE_REQUIRED');
    expect(versionGate('0.1.5', base)).toBe('REVOKED');
    expect(versionGate('0.2.1', base)).toBe('UPDATE_RECOMMENDED');
    expect(versionGate('0.10.0', base)).toBe('OK');
    expect(versionGate('0.1.0', null)).toBe('OK');
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('the guard’s phone number (enrollment)', () => {
  it('turns Pakistani numbers as people type them into E.164', () => {
    for (const typed of [
      '03001234567',
      '0300 1234567',
      '3001234567',
      '923001234567',
      '+92 300 1234567',
      '0092-300-1234567',
    ]) {
      expect(normalizePhone(typed), typed).toBe('+923001234567');
    }
    for (const bad of ['', '12345', '0300123456', 'abc', '+0123456789'])
      expect(normalizePhone(bad), bad).toBeNull();
  });
});
