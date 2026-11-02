// Scans a QR code with the camera: the enrollment code the supervisor shows (round-6 decision: codes
// are handed over from the dashboard as a code and a QR code), and checkpoint labels on patrol
// (PROD §7.7). The camera runs only while this screen is open, and no picture is kept.
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { openAppSettings } from '../../platform/permissions.ts';
import { Button, Screen, Txt } from '../components.tsx';
import { useI18n } from '../context.tsx';
import { space } from '../theme.ts';

export function QrScanner({
  onCode,
  onCancel,
  title,
  permissionText,
  accept = (code) => code.length >= 6 && code.length <= 64, // an enrollment code
}: {
  onCode: (code: string) => void;
  onCancel: () => void;
  title?: string;
  permissionText?: string;
  /** Codes that don't pass are ignored, and the camera keeps looking. */
  accept?: (code: string) => boolean;
}) {
  const { t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);
  // Dark corners and stairwells: the guard can switch the light on (PROD §7.7).
  const [torch, setTorch] = useState(false);
  const heading = title ?? t('qr.title');

  if (!permission?.granted) {
    const denied = permission !== null && !permission.canAskAgain;
    return (
      <Screen>
        <Txt kind="title">{heading}</Txt>
        <Txt>{denied ? t('qr.denied') : (permissionText ?? t('qr.permission'))}</Txt>
        {denied ? (
          <Button label={t('common.openSettings')} icon="⚙" onPress={() => void openAppSettings()} />
        ) : (
          <Button label={t('qr.allow')} icon="▣" onPress={() => void requestPermission()} />
        )}
        <Button kind="secondary" label={t('common.back')} icon="←" onPress={onCancel} />
      </Screen>
    );
  }

  return (
    <Screen scroll={false}>
      <Txt kind="heading">{heading}</Txt>
      <View style={styles.camera}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(result) => {
            if (handled.current) return;
            const code = result.data.trim();
            if (!accept(code)) return;
            handled.current = true;
            onCode(code);
          }}
        />
      </View>
      <Button
        kind="secondary"
        label={torch ? t('qr.torchOff') : t('qr.torchOn')}
        icon="☀"
        onPress={() => setTorch(!torch)}
      />
      <Button kind="secondary" label={t('common.back')} icon="←" onPress={onCancel} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  camera: { flex: 1, minHeight: 320, borderRadius: 16, overflow: 'hidden', marginVertical: space.md },
});
