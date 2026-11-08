// The phone's Firebase push address and its notification channels (D-26). expo-notifications gives
// the native Firebase token directly, so no Expo push service sits between our server and the phone.
// The build needs Firebase's app file (GOOGLE_SERVICES_JSON, see app.config.ts); without it the
// token is unavailable, getToken() answers null and the app runs on without pushes.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { PushPort } from '../core/ports.ts';
import { appLogger } from './logger.ts';

export const expoPush: PushPort = {
  async getToken() {
    try {
      const token = await Notifications.getDevicePushTokenAsync();
      return typeof token.data === 'string' && token.data.length > 0 ? token.data : null;
    } catch {
      // No Firebase file in this build, or Google services unavailable on this phone.
      return null;
    }
  },
  onTokenChange(listener) {
    const subscription = Notifications.addPushTokenListener((token) => {
      if (typeof token.data === 'string' && token.data.length > 0) listener(token.data);
    });
    return () => subscription.remove();
  },
};

let configured = false;

/**
 * Android notification channels the server's pushes are sent to (apps/api/src/notify/fcm.ts), and what
 * to do with a push that arrives while the app is open. Channel names are what the guard sees in the
 * phone's settings. Safe to call more than once.
 */
export async function configureNotifications(): Promise<void> {
  if (configured) return;
  configured = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: () =>
        Promise.resolve({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('sos', {
        name: 'SOS',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 400, 200, 400],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
      await Notifications.setNotificationChannelAsync('shift', {
        name: 'Shifts',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
  } catch (error) {
    configured = false;
    appLogger.warn('push.channels-failed', { errorKind: error instanceof Error ? error.name : 'unknown' });
  }
}
