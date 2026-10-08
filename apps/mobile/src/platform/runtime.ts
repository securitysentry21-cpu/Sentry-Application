// Builds the one GuardApp of this JavaScript runtime from the phone's adapters. The screens and the
// headless location task both call getGuardApp(), so they share the outbox, the session and the
// single in-flight upload.
import Constants from 'expo-constants';
import { getRandomBytes } from 'expo-crypto';
import * as Network from 'expo-network';

import { GuardApp } from '../core/app.ts';
import { validateRuntimeConfig } from '../core/config.ts';
import { base64UrlEncode } from '../core/encoding.ts';
import { type Clocks, monotonic } from '../core/time.ts';
import { expoDevice } from './device.ts';
import { fetchTransport } from './http.ts';
import { expoLocation } from './location.ts';
import { appLogger } from './logger.ts';
import { secureKV } from './secure-store.ts';
import { openOutboxDatabase } from './sqlite.ts';

/**
 * This process run's clocks (ARCH §8.7). monoMs comes from performance.now(), which starts near 0
 * when the process starts; bootId is random per run, so the server only compares monoMs values
 * within one run. See README, "Time and the monotonic clock".
 */
const clocks: Clocks = {
  wall: { nowMs: () => Date.now() },
  mono: monotonic(() => performance.now()),
  bootId: `run-${base64UrlEncode(getRandomBytes(12))}`,
};

let instance: GuardApp | null = null;
let unsubscribeNetwork: (() => void) | null = null;

export function appVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}

/** Throws ConfigError when the build was made with an invalid variant or API URL. */
export function getGuardApp(): GuardApp {
  if (instance) return instance;
  const extra = Constants.expoConfig?.extra as { sentry?: unknown } | undefined;
  const runtime = validateRuntimeConfig(extra?.sentry);
  const app = new GuardApp({
    openDatabase: openOutboxDatabase,
    secure: secureKV,
    transport: fetchTransport,
    location: expoLocation,
    device: expoDevice,
    runtime,
    appVersion: appVersion(),
    clocks,
    random: (n) => getRandomBytes(n),
    random01: () => Math.random(),
    logger: appLogger,
  });
  instance = app;
  watchNetwork(app);
  return app;
}

/** A regained network triggers an upload (judged by the server's answer, never by this flag). */
function watchNetwork(app: GuardApp): void {
  if (unsubscribeNetwork) return;
  let online: boolean | null = null;
  const subscription = Network.addNetworkStateListener((state) => {
    const now = state.isConnected === true && state.isInternetReachable !== false;
    if (now && online === false) void app.onNetworkRegained();
    online = now;
  });
  unsubscribeNetwork = () => subscription.remove();
}

export const runtimeClocks = clocks;
