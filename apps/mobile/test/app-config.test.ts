import { describe, expect, it } from 'vitest';

import appConfig, {
  ANDROID_PERMISSIONS,
  BLOCKED_ANDROID_PERMISSIONS,
  buildConfig,
  resolveApiBaseUrl,
  resolveVariant,
  withInlinePlugins,
} from '../app.config.ts';

const STAGING = { APP_VARIANT: 'staging', EXPO_PUBLIC_API_BASE_URL: 'https://staging-api.example.com' };

describe('app variants (SEC §11, ARCH §19.7)', () => {
  it('each variant has its own identifier and name, so builds never get mixed up', () => {
    const dev = buildConfig({});
    const staging = buildConfig(STAGING);
    expect(dev.android?.package).toBe('pk.sentryops.guard.dev');
    expect(dev.ios?.bundleIdentifier).toBe('pk.sentryops.guard.dev');
    expect(dev.name).toBe('SENTRY Dev');
    expect(staging.android?.package).toBe('pk.sentryops.guard.staging');
    expect(staging.name).toBe('SENTRY Staging');
    expect(dev.extra?.sentry).toEqual({ variant: 'development', apiBaseUrl: 'http://10.0.2.2:4000' });
  });

  it('staging and production require an explicit HTTPS origin; production requires the production origin', () => {
    expect(() => resolveApiBaseUrl('staging', {})).toThrow(/must be set/);
    expect(() =>
      resolveApiBaseUrl('staging', { EXPO_PUBLIC_API_BASE_URL: 'http://staging.example.com' }),
    ).toThrow(/HTTPS/);
    expect(() =>
      resolveApiBaseUrl('production', { EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com' }),
    ).toThrow(/PRODUCTION_API_ORIGIN/);
    expect(
      resolveApiBaseUrl(
        'production',
        { EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com/' },
        'https://api.example.com',
      ),
    ).toBe('https://api.example.com');
    expect(() =>
      resolveApiBaseUrl(
        'production',
        { EXPO_PUBLIC_API_BASE_URL: 'https://other.example.com' },
        'https://api.example.com',
      ),
    ).toThrow(/production API origin/);
  });

  it('a development or staging build can never point at the production API', () => {
    const prod = 'https://api.example.com';
    expect(() => resolveApiBaseUrl('staging', { EXPO_PUBLIC_API_BASE_URL: prod }, prod)).toThrow(
      /never point at production/,
    );
    expect(() => resolveApiBaseUrl('development', { EXPO_PUBLIC_API_BASE_URL: prod }, prod)).toThrow(
      /never point at production/,
    );
  });

  it('refuses an unknown variant or a URL with a path', () => {
    expect(() => resolveVariant({ APP_VARIANT: 'beta' })).toThrow();
    expect(() =>
      resolveApiBaseUrl('development', { EXPO_PUBLIC_API_BASE_URL: 'http://10.0.2.2:4000/api' }),
    ).toThrow();
  });
});

describe('native permissions and declarations', () => {
  it('asks for exactly the permissions the product needs, and blocks the ones libraries add', () => {
    const config = buildConfig(STAGING);
    expect(config.android?.permissions).toEqual([...ANDROID_PERMISSIONS]);
    for (const p of [
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.FOREGROUND_SERVICE_LOCATION',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.CAMERA',
    ]) {
      expect(config.android?.permissions).toContain(p);
    }
    for (const p of [
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_CONTACTS',
      'android.permission.ACTIVITY_RECOGNITION',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
    ]) {
      expect(config.android?.blockedPermissions).toContain(p);
    }
    const asked = new Set<string>(ANDROID_PERMISSIONS);
    expect(BLOCKED_ANDROID_PERMISSIONS.filter((p) => asked.has(p))).toEqual([]);
    expect(config.android?.allowBackup).toBe(false);
  });

  it('turns on background location and the Android foreground service, with product-specific iOS texts and no motion or microphone', () => {
    const config = buildConfig(STAGING);
    const location = config.plugins?.find((p) => Array.isArray(p) && p[0] === 'expo-location') as [
      string,
      Record<string, unknown>,
    ];
    expect(location[1]).toMatchObject({
      isIosBackgroundLocationEnabled: true,
      isAndroidBackgroundLocationEnabled: true,
      isAndroidForegroundServiceEnabled: true,
      isAndroidMotionActivityEnabled: false,
      motionUsagePermission: false,
    });
    expect(String(location[1].locationAlwaysAndWhenInUsePermission)).toContain(
      'Tracking stops when your shift ends',
    );
    const camera = config.plugins?.find((p) => Array.isArray(p) && p[0] === 'expo-camera') as [
      string,
      Record<string, unknown>,
    ];
    expect(camera[1]).toMatchObject({ microphonePermission: false, recordAudioAndroid: false });
    expect(config.ios?.infoPlist?.NSAppTransportSecurity).toEqual({ NSAllowsArbitraryLoads: false });
  });

  it('registers the Play monitoring-tool declaration and the background-mode clean-up as config mods', () => {
    const config = withInlinePlugins(buildConfig({})) as { mods?: Record<string, Record<string, unknown>> };
    expect(typeof config.mods?.android?.manifest).toBe('function');
    expect(typeof config.mods?.ios?.infoPlist).toBe('function');
    expect(typeof appConfig).toBe('function');
  });
});
