// The Android permission lists of the guard app, in a module of their own with no imports: Expo reads
// them through app.config.ts, and the release-manifest check (scripts/check-android-manifest.ts,
// ADV-X08) reads them under plain Node, which cannot load app.config.ts.

/** Every Android permission the app asks for, and why (merged-manifest allow-list, ARCH §19.3). */
export const ANDROID_PERMISSIONS = [
  'android.permission.ACCESS_FINE_LOCATION', // precise location during shifts (PROD §7.3)
  'android.permission.ACCESS_COARSE_LOCATION', // required alongside fine location
  'android.permission.ACCESS_BACKGROUND_LOCATION', // "Allow all the time": resume after a kill or reboot (D-35 rejected)
  'android.permission.FOREGROUND_SERVICE', // the shift's location foreground service (ARCH §8.2)
  'android.permission.FOREGROUND_SERVICE_LOCATION', // its declared type (Android 14+, EXT-31)
  'android.permission.POST_NOTIFICATIONS', // the persistent tracking notification (Android 13+)
  'android.permission.RECEIVE_BOOT_COMPLETED', // lets the task manager restore an active shift's updates after a reboot
  'android.permission.CAMERA', // QR codes (enrollment, patrol checkpoints) and incident photos (PROD §7.8)
  'android.permission.VIBRATE', // haptic feedback on critical actions and the SOS hold (PROD §7.1, §11.1)
  'android.permission.ACCESS_NETWORK_STATE', // expo-network: upload when the network returns (never proof of delivery)
  // android.permission.INTERNET comes from React Native itself (BASELINE_PERMISSIONS in
  // scripts/android-manifest.ts).
] as const;

/** Permissions libraries add that this app must not have (SEC §11; a new one fails review). */
export const BLOCKED_ANDROID_PERMISSIONS = [
  'android.permission.RECORD_AUDIO', // expo-camera's video recording; no audio is ever collected
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.GET_ACCOUNTS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.READ_PHONE_NUMBERS',
  'android.permission.CALL_PHONE', // "Call supervisor" opens the dialer; it never calls by itself
  'android.permission.READ_CALL_LOG',
  'android.permission.WRITE_CALL_LOG',
  'android.permission.SEND_SMS', // EXT-34: the SMS fallback opens the composer
  'android.permission.RECEIVE_SMS',
  'android.permission.READ_SMS',
  'android.permission.READ_EXTERNAL_STORAGE', // added by expo-file-system and expo-image-picker; private storage only
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES', // gallery photos come through the system photo picker, which needs none (D-18)
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.ACCESS_MEDIA_LOCATION',
  'android.permission.ACCESS_WIFI_STATE', // added by expo-network for an IP lookup the app never makes
  'android.permission.ACTIVITY_RECOGNITION', // PROD §8.2: no motion permission in V1
  'com.google.android.gms.permission.ACTIVITY_RECOGNITION',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', // EXT-33: the settings screen is opened instead
  'android.permission.SCHEDULE_EXACT_ALARM', // EXT-36: failsafes run on callbacks, not alarms
  'android.permission.USE_EXACT_ALARM',
  'android.permission.USE_FULL_SCREEN_INTENT', // EXT-35
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.NFC',
  'android.permission.BODY_SENSORS',
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
  'com.google.android.gms.permission.AD_ID',
] as const;
