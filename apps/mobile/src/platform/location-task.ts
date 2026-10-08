// The background location task, defined at module top level (expo-task-manager requires it): index.ts
// imports this file before anything else, so the task exists even when Android starts the app
// headless, with no screen, to deliver locations or restore the task after a reboot.
import type { LocationObject } from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { errorKind } from '../core/log.ts';
import { LOCATION_TASK, toRawFix } from './location.ts';
import { appLogger } from './logger.ts';
import { getGuardApp } from './runtime.ts';

type LocationTaskData = { locations?: LocationObject[] };

TaskManager.defineTask<LocationTaskData>(LOCATION_TASK, async ({ data, error }) => {
  try {
    const app = getGuardApp();
    if (error) {
      appLogger.warn('tracking.task-error', { errorKind: String(error.code) });
      await app.onLocationError();
      return;
    }
    await app.onLocations((data.locations ?? []).map(toRawFix));
  } catch (caught) {
    appLogger.error('tracking.task-failed', { errorKind: errorKind(caught) });
  }
});
