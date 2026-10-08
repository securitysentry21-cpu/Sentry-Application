// Scans the enrollment QR code the supervisor shows (round-6 decision: codes are handed over from the
// dashboard as a code and a QR code). The camera runs only while this screen is open.
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { openAppSettings } from '../../platform/permissions.ts';
import { Button, Screen, Txt } from '../components.tsx';
import { useI18n } from '../context.tsx';
import { space } from '../theme.ts';

export function QrScanner({ onCode, onCancel }: { onCode: (code: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  if (!permission?.granted) {
    const denied = permission !== null && !permission.canAskAgain;
    return (
      <Screen>
        <Txt kind="title">{t('qr.title')}</Txt>
        <Txt>{denied ? t('qr.denied') : t('qr.permission')}</Txt>
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
      <Txt kind="heading">{t('qr.title')}</Txt>
      <View style={styles.camera}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(result) => {
            if (handled.current) return;
            const code = result.data.trim();
            if (code.length < 6 || code.length > 64) return; // not an enrollment code
            handled.current = true;
            onCode(code);
          }}
        />
      </View>
      <Button kind="secondary" label={t('common.back')} icon="←" onPress={onCancel} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  camera: { flex: 1, minHeight: 320, borderRadius: 16, overflow: 'hidden', marginVertical: space.md },
});
