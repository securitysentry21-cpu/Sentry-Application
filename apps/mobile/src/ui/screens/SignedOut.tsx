// Signed out (ARCH §5.3): the session was revoked, the device removed, or the sign-in expired after
// a long time offline. Tracking has stopped; the queue is kept; the guard is told plainly that
// pending data cannot be sent until the phone is set up again. SOS stays available: it is signed
// with the device key when there is no session (INV-15).
import type { Navigate } from '../App.tsx';
import { Banner, Button, Screen, Txt } from '../components.tsx';
import { useI18n, useSnapshot } from '../context.tsx';
import { SosHold } from './Common.tsx';

export function SignedOutScreen({ onReEnroll, navigate }: { onReEnroll: () => void; navigate: Navigate }) {
  const snap = useSnapshot();
  const { t } = useI18n();
  return (
    <Screen>
      <Txt kind="title">{t('signedOut.title')}</Txt>
      <Banner
        tone="danger"
        text={snap.signedOutReason === 'EXPIRED' ? t('signedOut.expired') : t('signedOut.body')}
      />
      {snap.queue.pending > 0 ? (
        <Txt tone="warning">{t('signedOut.pending', { count: snap.queue.pending })}</Txt>
      ) : null}
      <Button icon="✓" label={t('signedOut.again')} onPress={onReEnroll} />
      <SosHold navigate={navigate} />
    </Screen>
  );
}
