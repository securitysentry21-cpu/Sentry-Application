// Secrets on the phone (SEC §5, §11): the installation ID, the device key and the session tokens, in
// expo-secure-store (iOS Keychain; Android values encrypted with a Keystore key). Readable after the
// first unlock, so the location task can upload while the phone is locked; THIS_DEVICE_ONLY, so
// nothing migrates to another phone through a backup.
import * as SecureStore from 'expo-secure-store';

import type { SecureKV } from '../core/ports.ts';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureKV: SecureKV = {
  get: (key) => SecureStore.getItemAsync(key, OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  delete: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
};
