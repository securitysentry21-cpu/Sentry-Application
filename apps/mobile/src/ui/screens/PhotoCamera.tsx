// The in-app camera for incident photos (PROD §7.8; D-18 labels these "in-app camera"). It uses the
// camera permission the app already has for QR codes; the picture goes straight to the app's own
// storage (re-encoded without metadata) and never to the shared gallery.
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { openAppSettings } from '../../platform/permissions.ts';
import { Button, Screen, Txt } from '../components.tsx';
import { useI18n } from '../context.tsx';
import { space } from '../theme.ts';

export type TakenPhoto = { readonly uri: string; readonly width: number; readonly height: number };

export function PhotoCamera({
  onPhoto,
  onCancel,
}: {
  onPhoto: (photo: TakenPhoto) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const [torch, setTorch] = useState(false);

  if (!permission?.granted) {
    const denied = permission !== null && !permission.canAskAgain;
    return (
      <Screen>
        <Txt kind="title">{t('incident.photo.title')}</Txt>
        <Txt>{denied ? t('qr.denied') : t('incident.photo.permission')}</Txt>
        {denied ? (
          <Button label={t('common.openSettings')} icon="⚙" onPress={() => void openAppSettings()} />
        ) : (
          <Button label={t('qr.allow')} icon="▣" onPress={() => void requestPermission()} />
        )}
        <Button kind="secondary" label={t('common.back')} icon="←" onPress={onCancel} />
      </Screen>
    );
  }

  const take = () => {
    if (!camera.current || busy) return;
    setBusy(true);
    void camera.current
      .takePictureAsync({ quality: 0.9, exif: false })
      .then((picture) => {
        if (picture) onPhoto({ uri: picture.uri, width: picture.width, height: picture.height });
      })
      .finally(() => setBusy(false));
  };

  return (
    <Screen scroll={false}>
      <Txt kind="heading">{t('incident.photo.title')}</Txt>
      <View style={styles.camera}>
        <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} />
      </View>
      <Button icon="◉" label={t('incident.photo.take')} busy={busy} onPress={take} />
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
