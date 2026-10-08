// The SOS screen (PROD §11): the state of the latest SOS exactly as the server has confirmed it
// (INV-10: "waiting for network" until the server answered, never "notified" or "acknowledged"),
// the call fallback after 15 s, and what SOS is (an alert to the company's control room, not an
// emergency service: Apple guideline 5.1.5, EXT-21). Only reachable when features.sos is on.
import { formatTime } from '../../core/i18n/format.ts';
import { sosLine } from '../../core/presenter.ts';
import { showCallFallback } from '../../core/sos/machine.ts';
import { openDialer } from '../../platform/permissions.ts';
import type { Navigate } from '../App.tsx';
import { Banner, Button, Screen, Txt } from '../components.tsx';
import { useI18n, useSnapshot } from '../context.tsx';
import { SosHold } from './Common.tsx';

export function SosScreen({ navigate }: { navigate: Navigate }) {
  const snap = useSnapshot();
  const { t, locale } = useI18n();
  const sos = snap.sos;
  const line = sos ? sosLine(sos, t) : null;
  const zone = snap.shifts[0]?.site.timezone ?? 'Asia/Karachi';

  return (
    <Screen>
      <Txt kind="title">SOS</Txt>
      {line ? (
        <Banner
          tone={line.tone === 'ok' ? 'ok' : line.tone === 'warning' ? 'warning' : 'danger'}
          text={line.text}
        />
      ) : null}
      {sos?.phase === 'RECEIVED' && sos.receivedAt ? (
        <Txt tone="muted">
          {t('sos.receivedAt', { time: formatTime(Date.parse(sos.receivedAt), zone, locale) })}
        </Txt>
      ) : null}
      {sos && (showCallFallback(sos, Date.now()) || sos.phase === 'FAILED') ? (
        <Button kind="danger" icon="☎" label={t('sos.callFallback')} onPress={() => void openDialer()} />
      ) : null}
      <Txt kind="small" tone="muted">
        {t('sos.disclaimer')}
      </Txt>
      <SosHold navigate={navigate} />
      <Button kind="secondary" icon="←" label={t('common.back')} onPress={() => navigate({ name: 'home' })} />
    </Screen>
  );
}
