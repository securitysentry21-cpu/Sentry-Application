// The SOS screen (PROD §11): the state of the latest SOS exactly as the server has confirmed it
// (INV-10: "waiting for network" until the server answered, never "notified" or "acknowledged" before
// the server says so), "I'm safe / false alarm", the call and SMS fallbacks after 15 s, and what SOS
// is (an alert to the company's control room, not an emergency service: Apple guideline 5.1.5,
// EXT-21). Only reachable when features.sos is on.
import { useEffect } from 'react';

import { formatTime } from '../../core/i18n/format.ts';
import { sosLine } from '../../core/presenter.ts';
import { showCallFallback, sosDisplay, sosOpen, sosTrackingActive } from '../../core/sos/machine.ts';
import { openDialer, openSmsComposer } from '../../platform/permissions.ts';
import type { Navigate } from '../App.tsx';
import { Banner, Button, Screen, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';
import { SosHold } from './Common.tsx';

export function SosScreen({ navigate }: { navigate: Navigate }) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t, locale } = useI18n();
  const sos = snap.sos;
  const zone = snap.shifts[0]?.site.timezone ?? 'Asia/Karachi';
  const time = (iso: string) => formatTime(Date.parse(iso), zone, locale);
  const line = sos ? sosLine(sos, t, time) : null;
  const now = Date.now() + (snap.serverOffsetMs ?? 0);
  const callNumber = snap.settings.support.emergencyCallNumber;
  // A report during the SOS (INV-08: an open SOS allows one even off shift).
  const incidentContext = app.incidentContext();

  // The lane asks the server every 5 s by itself; opening the screen asks at once.
  useEffect(() => {
    void app.refreshSos();
  }, [app]);

  const smsBody = () =>
    t('sos.smsBody', {
      name: snap.identity?.guardDisplayName ?? '',
      site: snap.shifts[0]?.site.name ?? '',
      position: snap.lastPosition
        ? `${snap.lastPosition.lat.toFixed(5)},${snap.lastPosition.lon.toFixed(5)}`
        : '—',
      time: formatTime(Date.now(), zone, locale),
    });
  const offerFallbacks = sos !== null && (showCallFallback(sos, Date.now()) || sos.phase === 'FAILED');

  return (
    <Screen>
      <Txt kind="title">SOS</Txt>
      {sos?.isDrill ? <Banner tone="warning" text={t('sos.drill')} /> : null}
      {line ? (
        <Banner
          tone={line.tone === 'ok' ? 'ok' : line.tone === 'warning' ? 'warning' : 'danger'}
          text={line.text}
        />
      ) : null}
      {sos?.phase === 'RECEIVED' && sos.receivedAt ? (
        <Txt tone="muted">{t('sos.receivedAt', { time: time(sos.receivedAt) })}</Txt>
      ) : null}
      {sos && sosTrackingActive(sos, now) ? (
        <Txt tone="muted">{t('sos.tracking', { seconds: String(snap.settings.tracking.sosIntervalS) })}</Txt>
      ) : null}
      {offerFallbacks ? (
        <>
          <Button
            kind="danger"
            icon="☎"
            label={t('sos.callFallback')}
            onPress={() => void openDialer(callNumber)}
          />
          <Button
            kind="secondary"
            icon="✉"
            label={t('sos.smsFallback')}
            onPress={() => void openSmsComposer(callNumber, smsBody())}
          />
        </>
      ) : null}
      {sos && sosOpen(sos) && sosDisplay(sos) !== 'RESOLVED' ? (
        sos.cancelRequested ? (
          <Txt tone="muted">{sos.server?.cancelRequestedAt ? t('sos.safeSent') : t('sos.safeQueued')}</Txt>
        ) : (
          <Button kind="secondary" label={t('sos.safe')} onPress={() => void app.requestSosCancel()} />
        )
      ) : null}
      {incidentContext ? (
        <Button
          kind="secondary"
          icon="✎"
          label={t('shift.report')}
          onPress={() => navigate({ name: 'incident', shiftId: incidentContext.shiftId })}
        />
      ) : null}
      <Txt kind="small" tone="muted">
        {t('sos.disclaimer')}
      </Txt>
      <SosHold navigate={navigate} />
      <Button kind="secondary" icon="←" label={t('common.back')} onPress={() => navigate({ name: 'home' })} />
    </Screen>
  );
}
