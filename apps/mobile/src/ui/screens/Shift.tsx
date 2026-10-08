// One shift (PROD §6.4–§6.6, §7.5–§7.6): start, end, resume; honest states ("waiting to confirm"
// until the server confirmed, INV-16); tracking health and sync lines; interruptions; the readiness
// check before start; incidents and SOS during the shift.
import { useState } from 'react';

import type { StartResult } from '../../core/app.ts';
import { formatTime } from '../../core/i18n/format.ts';
import { shiftLine, trackingLine } from '../../core/presenter.ts';
import { openDialer } from '../../platform/permissions.ts';
import type { Navigate } from '../App.tsx';
import { Banner, Button, Screen, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';
import { SosHold, StatusBanners, useResumable } from './Common.tsx';
import { ReadinessCard, useReadiness } from './Readiness.tsx';

export function ShiftScreen({ shiftId, navigate }: { shiftId: string; navigate: Navigate }) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t, locale } = useI18n();
  const items = useReadiness();
  const [busy, setBusy] = useState<'start' | 'end' | 'resume' | null>(null);
  const [startResult, setStartResult] = useState<StartResult | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const resumable = useResumable(shiftId);

  const shift = snap.shifts.find((s) => s.id === shiftId);
  const local = snap.localShifts[shiftId];
  const zone = shift?.site.timezone ?? 'UTC';
  const tracking = local?.tracking ?? false;
  const phase = local?.phase ?? 'NOT_STARTED';
  const status = local ? shiftLine(local, t) : null;
  // A MISSED shift can no longer be started from the phone (a supervisor reopens it first, PROD §6.3).
  const startable =
    shift !== undefined &&
    shift.status === 'SCHEDULED' &&
    (phase === 'NOT_STARTED' || phase === 'START_REJECTED') &&
    !(phase === 'NOT_STARTED' && local?.serverStatus === 'ACTIVE');
  const endable = phase === 'START_PENDING' || phase === 'ACTIVE' || phase === 'AUTO_STOPPED';

  const start = () => {
    setBusy('start');
    setStartResult(null);
    void app
      .startShift(shiftId)
      .then(setStartResult)
      .finally(() => setBusy(null));
  };
  const end = () => {
    setBusy('end');
    setConfirmEnd(false);
    void app.endShift(shiftId).finally(() => setBusy(null));
  };
  const resume = () => {
    setBusy('resume');
    void app.resumeTracking(shiftId).finally(() => setBusy(null));
  };

  return (
    <Screen>
      <Txt kind="title">{shift?.site.name ?? t('home.shifts')}</Txt>
      {shift ? (
        <Txt>
          {t('shift.time', {
            start: formatTime(Date.parse(shift.startsAt), zone, locale),
            end: formatTime(Date.parse(shift.endsAt), zone, locale),
          })}
        </Txt>
      ) : null}
      {shift ? <Txt tone="muted">{t(`shiftStatus.${shift.status}`)}</Txt> : null}
      {status ? (
        <Banner
          tone={
            status.tone === 'ok'
              ? 'ok'
              : status.tone === 'danger'
                ? 'danger'
                : status.tone === 'warning'
                  ? 'warning'
                  : 'info'
          }
          text={status.text}
        />
      ) : null}
      {local?.startedAtMs ? (
        <Txt tone="muted">{t('shift.startedAt', { time: formatTime(local.startedAtMs, zone, locale) })}</Txt>
      ) : null}
      {tracking || phase === 'START_PENDING' || phase === 'ACTIVE' ? (
        <Txt tone={trackingLine(snap.tracking, tracking, Date.now(), t).tone}>
          {trackingLine(snap.tracking, tracking, Date.now(), t).text}
        </Txt>
      ) : null}
      <StatusBanners />
      {(local?.interruptions ?? []).map((gap) => (
        <Txt key={`${gap.fromMs}-${gap.toMs}`} tone="warning">
          {t('shift.interrupted', {
            from: formatTime(gap.fromMs, zone, locale),
            to: formatTime(gap.toMs, zone, locale),
          })}
        </Txt>
      ))}

      {startable ? (
        <ReadinessCard items={startResult?.kind === 'BLOCKED' ? startResult.items : items} />
      ) : null}
      {startResult?.kind === 'NO_FIX' ? <Banner tone="danger" text={t('shift.noFix')} /> : null}
      {startable ? (
        <Button
          icon="▶"
          label={busy === 'start' ? t('shift.starting') : t('shift.start')}
          busy={busy === 'start'}
          onPress={start}
        />
      ) : null}

      {resumable ? (
        <Button
          icon="▶"
          label={phase === 'NOT_STARTED' ? t('shift.startedBySupervisor') : t('shift.resume')}
          busy={busy === 'resume'}
          onPress={resume}
        />
      ) : null}

      {phase === 'START_REJECTED' ? (
        <Button
          kind="secondary"
          icon="☎"
          label={t('shift.callSupervisor')}
          onPress={() => void openDialer(snap.settings.support.emergencyCallNumber)}
        />
      ) : null}

      {tracking && snap.settings.features.incidents ? (
        <Button
          kind="secondary"
          icon="✎"
          label={t('shift.report')}
          onPress={() => navigate({ name: 'incident', shiftId })}
        />
      ) : null}

      {endable && !confirmEnd ? (
        <Button
          kind="danger"
          icon="■"
          label={t('shift.end')}
          busy={busy === 'end'}
          onPress={() => setConfirmEnd(true)}
        />
      ) : null}
      {endable && confirmEnd ? (
        <>
          <Banner tone="warning" text={t('shift.endConfirm')} />
          <Button kind="danger" icon="■" label={t('shift.endYes')} onPress={end} />
          <Button kind="secondary" icon="←" label={t('common.cancel')} onPress={() => setConfirmEnd(false)} />
        </>
      ) : null}

      <SosHold navigate={navigate} />
      <Button kind="secondary" icon="←" label={t('common.back')} onPress={() => navigate({ name: 'home' })} />
    </Screen>
  );
}
