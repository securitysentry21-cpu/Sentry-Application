// Patrol rounds (PROD §7.7): the round under way with its checkpoints in order and the next one to
// scan, later rounds, and the scanner. Each scan shows what the server said about it, never more
// (INV-16): "Saved — will verify when online" until it answers. Only during the active shift.
import type { GuardPatrolsResponse } from '@sentryops/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ScanStart } from '../../core/app.ts';
import { formatTime } from '../../core/i18n/format.ts';
import type { Receipt } from '../../core/outbox/outbox.ts';
import { nextCheckpoint, roundsView } from '../../core/patrol.ts';
import { scanLine, scanProgress } from '../../core/presenter.ts';
import type { Navigate } from '../App.tsx';
import { Banner, Button, Card, Screen, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';
import { QrScanner } from './QrScanner.tsx';

type Mode =
  | { readonly kind: 'rounds' }
  | { readonly kind: 'scanning' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'result'; readonly clientEventId: string }
  | { readonly kind: 'refused'; readonly reason: Extract<ScanStart, { kind: 'REFUSED' }>['reason'] };

type Rounds = { rounds: GuardPatrolsResponse; fromCache: boolean } | null;

export function PatrolScreen({ shiftId, navigate }: { shiftId: string; navigate: Navigate }) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<Mode>({ kind: 'rounds' });
  const [rounds, setRounds] = useState<Rounds | 'loading'>('loading');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const answered = useRef<string | null>(null);
  const tracking = snap.localShifts[shiftId]?.tracking ?? false;
  const zone = snap.shifts.find((s) => s.id === shiftId)?.site.timezone ?? 'UTC';

  const load = useCallback(() => {
    void app.patrols(shiftId).then(setRounds);
  }, [app, shiftId]);
  useEffect(load, [load]);

  // The receipt changes when the server answers; the rounds are read again once it has.
  const resultId = mode.kind === 'result' ? mode.clientEventId : null;
  useEffect(() => {
    if (!resultId) return;
    void app.receipt(resultId).then((r) => {
      setReceipt(r);
      if (r && r.status !== 'QUEUED' && answered.current !== resultId) {
        answered.current = resultId;
        load();
      }
    });
  }, [app, resultId, snap.queue, load]);

  const back = () => navigate({ name: 'shift', shiftId });
  const scanAgain = () => {
    setReceipt(null);
    setMode({ kind: 'scanning' });
  };

  if (!tracking && mode.kind !== 'result') {
    return (
      <Screen>
        <Txt kind="title">{t('patrol.title')}</Txt>
        <Banner tone="info" text={t('patrol.onlyDuringShift')} />
        <Button kind="secondary" icon="←" label={t('common.back')} onPress={back} />
      </Screen>
    );
  }

  if (mode.kind === 'scanning') {
    return (
      <QrScanner
        title={t('scan.title')}
        permissionText={t('scan.permission')}
        accept={(code) => code.length > 0 && code.length <= 80}
        onCancel={() => setMode({ kind: 'rounds' })}
        onCode={(code) => {
          setMode({ kind: 'saving' });
          void app
            .scanCheckpoint(shiftId, code)
            .then((start) =>
              setMode(
                start.kind === 'SAVED'
                  ? { kind: 'result', clientEventId: start.clientEventId }
                  : { kind: 'refused', reason: start.reason },
              ),
            );
        }}
      />
    );
  }

  if (mode.kind === 'saving') {
    return (
      <Screen>
        <Txt kind="title">{t('patrol.title')}</Txt>
        <Banner tone="info" text={t('scan.gettingLocation')} />
      </Screen>
    );
  }

  if (mode.kind === 'result' || mode.kind === 'refused') {
    const line =
      mode.kind === 'result'
        ? scanLine(receipt, snap.syncDisplay.kind === 'SENDING', t)
        : {
            text: mode.reason === 'NOT_A_CHECKPOINT' ? t('scan.notCheckpoint') : t('patrol.onlyDuringShift'),
            tone: 'danger' as const,
          };
    const progress = mode.kind === 'result' ? scanProgress(receipt, t) : null;
    return (
      <Screen>
        <Txt kind="title">{t('patrol.title')}</Txt>
        <Banner
          tone={
            line.tone === 'ok'
              ? 'ok'
              : line.tone === 'danger'
                ? 'danger'
                : line.tone === 'info'
                  ? 'info'
                  : 'warning'
          }
          text={line.text}
        />
        {progress ? <Txt>{progress}</Txt> : null}
        {tracking ? (
          <Button
            icon="▣"
            label={mode.kind === 'result' ? t('patrol.scanNext') : t('common.retry')}
            onPress={scanAgain}
          />
        ) : null}
        <Button
          kind="secondary"
          icon="←"
          label={t('patrol.title')}
          onPress={() => setMode({ kind: 'rounds' })}
        />
      </Screen>
    );
  }

  const nowMs = Date.now() + (snap.serverOffsetMs ?? 0);
  const loaded = rounds === 'loading' ? null : rounds;
  const view = loaded ? roundsView(loaded.rounds.runs, nowMs) : null;
  const current = view?.current ?? null;
  const next = current ? nextCheckpoint(current) : null;
  const time = (iso: string) => formatTime(Date.parse(iso), zone, locale);

  return (
    <Screen>
      <Txt kind="title">{t('patrol.title')}</Txt>
      {rounds === 'loading' ? <Txt tone="muted">{t('common.loading')}</Txt> : null}
      {rounds === null ? <Banner tone="warning" text={t('patrol.unavailable')} /> : null}
      {loaded?.fromCache ? <Banner tone="info" text={t('patrol.cached')} /> : null}
      {loaded && loaded.rounds.runs.length === 0 ? <Txt>{t('patrol.none')}</Txt> : null}
      {loaded && loaded.rounds.runs.length > 0 && !current ? <Txt>{t('patrol.allDone')}</Txt> : null}

      {current ? (
        <Card>
          <Txt kind="heading">{t('patrol.round', { n: current.sequenceNo, route: current.routeName })}</Txt>
          <Txt tone="muted">
            {t('patrol.window', { due: time(current.dueAt), end: time(current.windowEndsAt) })}
          </Txt>
          {Date.parse(current.dueAt) > nowMs ? (
            <Banner tone="info" text={t('patrol.opensAt', { time: time(current.dueAt) })} />
          ) : null}
          <Txt tone={current.countedCount === current.requiredCount ? 'ok' : 'default'}>
            {current.countedCount === current.requiredCount
              ? t('patrol.complete')
              : t('patrol.progress', { counted: current.countedCount, required: current.requiredCount })}
          </Txt>
          {current.enforceOrder ? <Txt tone="muted">{t('patrol.order')}</Txt> : null}
          {current.checkpoints.map((c) => (
            <Txt
              key={c.checkpointId}
              tone={c.done === 'VERIFIED' ? 'ok' : c.done === 'QR_ONLY' ? 'warning' : 'default'}
            >
              {c.done === 'VERIFIED'
                ? t('patrol.doneVerified', { name: c.name })
                : c.done === 'QR_ONLY'
                  ? t('patrol.doneQrOnly', { name: c.name })
                  : c.required
                    ? t('patrol.todo', { name: c.name })
                    : t('patrol.optional', { name: c.name })}
            </Txt>
          ))}
          {next ? <Txt kind="heading">{t('patrol.next', { name: next.name })}</Txt> : null}
        </Card>
      ) : null}

      {view && view.upcoming.length > 0 ? (
        <Card>
          <Txt kind="heading">{t('patrol.later')}</Txt>
          {view.upcoming.map((r) => (
            <Txt key={r.id} tone="muted">
              {t('patrol.laterItem', { n: r.sequenceNo, time: time(r.dueAt) })}
            </Txt>
          ))}
        </Card>
      ) : null}

      <Button icon="▣" label={t('patrol.scan')} onPress={scanAgain} />
      <Button kind="secondary" icon="←" label={t('common.back')} onPress={back} />
    </Screen>
  );
}
