// Expo app configuration for the guard app (replaces app.json). Native behaviour is configured
// here and in config plugins, never by editing the generated android/ and ios/ folders.
//
// Variants (SEC §11, ARCH §19.7): APP_VARIANT = development | staging | production picks the app
// identifier and name, so a debug or staging build can be installed next to production and can
// never be mistaken for it, and EXPO_PUBLIC_API_BASE_URL picks the API origin. Staging and production
// must use HTTPS and must set the URL explicitly; production must use the production origin below,
// and no other variant may.
import type { ConfigContext, ExpoConfig } from 'expo/config';
import { AndroidConfig, type ConfigPlugin, withAndroidManifest, withInfoPlist } from 'expo/config-plugins';

import { ANDROID_PERMISSIONS, BLOCKED_ANDROID_PERMISSIONS } from './android-permissions.ts';

// The lists live in a module of their own so the release-manifest check (ADV-X08) can read them
// under plain Node, which cannot load this file.
export { ANDROID_PERMISSIONS, BLOCKED_ANDROID_PERMISSIONS };

export type AppVariant = 'development' | 'staging' | 'production';

export const APP_VERSION = '0.1.0';

const VARIANTS: Record<AppVariant, { name: string; id: string; defaultApi: string | null }> = {
  // 10.0.2.2 is the development machine as seen from the Android emulator.
  development: { name: 'SENTRY Dev', id: 'pk.sentryops.guard.dev', defaultApi: 'http://10.0.2.2:4000' },
  staging: { name: 'SENTRY Staging', id: 'pk.sentryops.guard.staging', defaultApi: null },
  production: { name: 'SENTRY', id: 'pk.sentryops.guard', defaultApi: null },
};

/**
 * The production API origin. Set it (in code, reviewed) once the production domain exists: until
 * then a production build cannot be made, and once set no other variant can point at it.
 */
export const PRODUCTION_API_ORIGIN: string | null = null;

export function resolveVariant(env: Readonly<Record<string, string | undefined>>): AppVariant {
  const value = env.APP_VARIANT ?? 'development';
  if (value === 'development' || value === 'staging' || value === 'production') return value;
  throw new Error(`APP_VARIANT must be development, staging or production (got "${value}")`);
}

export function resolveApiBaseUrl(
  variant: AppVariant,
  env: Readonly<Record<string, string | undefined>>,
  productionOrigin: string | null = PRODUCTION_API_ORIGIN,
): string {
  const raw = env.EXPO_PUBLIC_API_BASE_URL?.trim() || VARIANTS[variant].defaultApi;
  if (!raw) throw new Error(`EXPO_PUBLIC_API_BASE_URL must be set for ${variant} builds`);
  const match = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?\/?$/.exec(raw);
  if (!match) throw new Error('EXPO_PUBLIC_API_BASE_URL must be an origin, e.g. https://api.example.com');
  const origin = `${match[1]}://${match[2]}${match[3] ?? ''}`;
  if (variant !== 'development' && match[1] !== 'https') throw new Error(`${variant} builds must use HTTPS`);
  if (variant === 'production') {
    if (!productionOrigin) throw new Error('PRODUCTION_API_ORIGIN is not set in app.config.ts yet');
    if (origin !== productionOrigin) throw new Error('a production build must use the production API origin');
  } else if (productionOrigin && origin === productionOrigin) {
    throw new Error(`a ${variant} build must never point at production (SEC §11)`);
  }
  return origin;
}

const IOS_USAGE = {
  whenInUse:
    'SENTRY uses your location during your security shift to confirm you are at your assigned site and to help your control room in an emergency.',
  always:
    "SENTRY shares your location with your security company's control room while your shift is active, including when the screen is locked. Tracking stops when your shift ends.",
  camera:
    'SENTRY uses the camera to scan QR codes (your enrollment code and patrol checkpoint labels) and to take the photos you add to an incident report.',
  photos: 'SENTRY opens your photos only when you choose one to add to an incident report.',
  temporaryFullAccuracy: 'SENTRY needs your precise location to confirm this patrol checkpoint scan.',
};

/** Google Play's employee-monitoring declaration (EXT-20, ADV-X08), in every build of every track. */
export const withMonitoringToolDeclaration: ConfigPlugin = (config) =>
  withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      'isMonitoringTool',
      'enterprise_management',
    );
    return mod;
  });

/**
 * expo-task-manager adds the iOS background mode `fetch`, which this app does not use (its task is a
 * location task, covered by the `location` mode). Fewer background modes, fewer review questions.
 */
export const withoutBackgroundFetch: ConfigPlugin = (config) =>
  withInfoPlist(config, (mod) => {
    const modes = mod.modResults.UIBackgroundModes;
    if (Array.isArray(modes)) mod.modResults.UIBackgroundModes = modes.filter((m) => m !== 'fetch');
    return mod;
  });

export function buildConfig(
  env: Readonly<Record<string, string | undefined>>,
  base: Partial<ExpoConfig> = {},
): ExpoConfig {
  const variant = resolveVariant(env);
  const apiBaseUrl = resolveApiBaseUrl(variant, env);
  const { name, id } = VARIANTS[variant];
  const blocked: string[] = [...BLOCKED_ANDROID_PERMISSIONS];
  // The React Native dev menu overlay needs this in debug builds only.
  if (variant !== 'development') blocked.push('android.permission.SYSTEM_ALERT_WINDOW');

  return {
    ...base,
    name,
    slug: 'sentry-guard',
    version: APP_VERSION,
    platforms: ['android', 'ios'],
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'dark',
    // The screens' background (src/ui/theme.ts), shown before they paint.
    backgroundColor: '#17181B',
    ios: {
      bundleIdentifier: id,
      buildNumber: '1',
      supportsTablet: false,
      infoPlist: {
        NSLocationTemporaryUsageDescriptionDictionary: { CheckpointScan: IOS_USAGE.temporaryFullAccuracy },
        // TLS only outside development (SEC §11): App Transport Security's defaults, no exceptions.
        // Development keeps Expo's template setting so a debug build can reach Metro on the LAN.
        ...(variant === 'development' ? {} : { NSAppTransportSecurity: { NSAllowsArbitraryLoads: false } }),
      },
      // ARCH §8.2: the uptime/boot-time APIs behind monoMs (performance.now) are "required reason" APIs.
      privacyManifests: {
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
            NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
            NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
            NSPrivacyAccessedAPITypeReasons: ['C617.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
            NSPrivacyAccessedAPITypeReasons: ['E174.1'],
          },
        ],
        NSPrivacyTracking: false,
      },
    },
    android: {
      package: id,
      versionCode: 1,
      adaptiveIcon: {
        backgroundColor: '#12161B',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      // Location queues and identity must never be copied to cloud backups or restored onto another phone.
      allowBackup: false,
      permissions: [...ANDROID_PERMISSIONS],
      blockedPermissions: blocked,
      predictiveBackGestureEnabled: false,
      // Firebase's app file, for pushes to the phone (D-26). It names our Firebase project and is kept
      // out of the repository: EAS hands it to the build as a file variable, or a developer points
      // GOOGLE_SERVICES_JSON at a local copy. Without it the app builds and runs, but gets no pushes.
      ...(env.GOOGLE_SERVICES_JSON?.trim() ? { googleServicesFile: env.GOOGLE_SERVICES_JSON.trim() } : {}),
    },
    plugins: [
      [
        'expo-location',
        {
          locationWhenInUsePermission: IOS_USAGE.whenInUse,
          locationAlwaysAndWhenInUsePermission: IOS_USAGE.always,
          locationAlwaysPermission: IOS_USAGE.always,
          motionUsagePermission: false, // no motion permission (PROD §8.2)
          isIosBackgroundLocationEnabled: true, // UIBackgroundModes: location
          isAndroidBackgroundLocationEnabled: true,
          isAndroidForegroundServiceEnabled: true,
          isAndroidMotionActivityEnabled: false,
        },
      ],
      [
        'expo-camera',
        {
          cameraPermission: IOS_USAGE.camera,
          microphonePermission: false,
          recordAudioAndroid: false,
          barcodeScannerEnabled: true,
        },
      ],
      [
        // D-18: gallery photos through the system photo picker only; the in-app camera is expo-camera's.
        'expo-image-picker',
        {
          photosPermission: IOS_USAGE.photos,
          cameraPermission: IOS_USAGE.camera,
          microphonePermission: false,
        },
      ],
      // D-26: the phone's Firebase token and notification channels. No Expo push service is involved.
      ['expo-notifications', { defaultChannel: 'shift' }],
      ['expo-secure-store', { faceIDPermission: false, configureAndroidBackup: true }],
      'expo-sqlite',
      'expo-task-manager',
    ],
    extra: {
      ...(base.extra ?? {}),
      // Read at runtime by src/platform/runtime.ts and validated again there (src/core/config.ts).
      sentry: { variant, apiBaseUrl },
    },
  };
}

/**
 * The inline plugins are applied to the config object itself. Mods run in reverse order of
 * registration, and these are registered before the `plugins` list is applied, so they run after
 * every library's mods: withoutBackgroundFetch can remove what expo-task-manager adds.
 */
export function withInlinePlugins(config: ExpoConfig): ExpoConfig {
  return withMonitoringToolDeclaration(withoutBackgroundFetch(config));
}

export default ({ config }: ConfigContext): ExpoConfig => withInlinePlugins(buildConfig(process.env, config));
