// Diagnostics (PROD §7.11, ARCH §18.6): app version, permissions, tracking service, queue, oldest
// item, last successful sync, clock offset, IDs. "All data sent" only when the outbox is empty and
// every item was answered by the server (ADV-U03). Nothing here shows a location.
import { useEffect, useState } from 'react';

import type { Diagnostics } from '../../core/app.ts';
import { formatAgo, formatDuration } from '../../core/i18n/format.ts';
import { receiptLine } from '../../core/presenter.ts';
import { allDataSent } from '../../core/status.ts';
import { trackingServiceState } from '../../core/tracking/device-status.ts';
import type { Navigate } from '../App.tsx';
import { Banner, Button, Card, Row, Screen, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';

export function DiagnosticsScreen({ navigate }: { navigate: Navigate }) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t } = useI18n();
  const [details, setDetails] = useState<Diagnostics | null>(null);
  const now = Date.now();

  useEffect(() => {
    void app.probeDevice();
  }, [app]);
  useEffect(() => {
    void app.diagnostics().then(setDetails);
  }, [app, snap.queue]);

  const sent = allDataSent({
    queue: snap.queue,
    sync: snap.sync,
    signedOut: snap.signedOutReason !== null,
    discarded: snap.discarded,
  });
  const yesNo = (v: boolean | null | undefined) =>
    v === undefined || v === null ? t('diag.unknown') : v ? t('diag.yes') : t('diag.no');
  const probe = snap.probe;
  const service = probe ? trackingServiceState(probe, snap.tracking.running) : 'UNKNOWN';
  const offset = snap.serverOffsetMs;

  return (
    <Screen>
      <Txt kind="title">{t('diag.title')}</Txt>
      <Banner tone={sent ? 'ok' : 'warning'} text={sent ? t('diag.allSent') : t('diag.notAllSent')} />
      <Card>
        <Row
          label={t('diag.queue')}
          value={String(snap.queue.pending)}
          tone={snap.queue.pending > 0 ? 'warning' : 'default'}
        />
        <Row
          label={t('diag.oldest')}
          value={
            snap.queue.oldestRecordedAtMs === null
              ? t('diag.none')
              : formatDuration(now - snap.queue.oldestRecordedAtMs, t)
          }
        />
        <Row
          label={t('diag.lastSync')}
          value={
            snap.sync.lastSuccessAtMs === null
              ? t('diag.never')
              : formatAgo(now - snap.sync.lastSuccessAtMs, t)
          }
        />
        <Row
          label={t('diag.lastError')}
          value={
            snap.sync.lastError
              ? `${snap.sync.lastError.kind}${snap.sync.lastError.errorCode ? ` · ${snap.sync.lastError.errorCode}` : ''}`
              : t('diag.none')
          }
        />
        <Row
          label={t('diag.serverOffset')}
          value={
            offset === null
              ? t('diag.unknown')
              : `${offset >= 0 ? '+' : '−'}${Math.round(Math.abs(offset) / 1_000)} s`
          }
          tone={snap.clockSkewed ? 'danger' : 'default'}
        />
      </Card>
      <Card>
        <Row
          label={t('diag.locationPermission')}
          value={probe ? t(`diag.permission.${probe.locationPermission}`) : t('diag.unknown')}
        />
        <Row label={t('diag.precise')} value={yesNo(probe?.preciseLocation)} />
        <Row label={t('diag.services')} value={yesNo(probe?.locationServicesEnabled)} />
        <Row label={t('diag.notifications')} value={yesNo(probe?.notificationsEnabled)} />
        <Row label={t('diag.batteryOptimization')} value={yesNo(probe?.batteryOptimizationExempt)} />
        <Row
          label={t('diag.battery')}
          value={probe?.batteryPct === undefined ? t('diag.unknown') : `${probe.batteryPct}%`}
        />
        <Row label={t('diag.trackingService')} value={t(`diag.service.${service}`)} />
      </Card>
      <Card>
        <Row label={t('diag.appVersion')} value={snap.appVersion} />
        <Row label={t('diag.build')} value={snap.variant} />
        <Row label={t('diag.deviceId')} value={snap.identity?.deviceId ?? t('diag.none')} />
        <Row label={t('diag.installationId')} value={snap.installationId ?? t('diag.unknown')} />
        <Row label={t('diag.runId')} value={details?.bootId ?? ''} />
      </Card>
      {details && details.recent.length > 0 ? (
        <Card>
          <Txt kind="heading">{t('diag.recent')}</Txt>
          {details.recent.map((r) => {
            const line = receiptLine(r, t);
            return (
              <Row
                key={r.clientEventId}
                label={`${r.type} · ${formatAgo(now - r.updatedAtMs, t)}`}
                value={line.text}
                tone={line.tone}
              />
            );
          })}
        </Card>
      ) : null}
      <Button icon="↻" label={t('diag.sendNow')} onPress={() => void app.flush({ urgent: true })} />
      <Button kind="secondary" icon="←" label={t('common.back')} onPress={() => navigate({ name: 'home' })} />
    </Screen>
  );
}
