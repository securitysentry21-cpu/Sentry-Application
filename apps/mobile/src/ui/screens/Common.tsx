// Pieces several screens share: the status banners (clock, version, dropped data, tracking problem,
// sync) and the SOS hold button, shown only when the organization has SOS switched on.
import { canResume } from '../../core/shift/local-shift.ts';
import { discardedReasonLine, syncLine, trackingLine } from '../../core/presenter.ts';
import { openAppSettings, openLocationSettings } from '../../platform/permissions.ts';
import type { Navigate } from '../App.tsx';
import { Banner, HoldButton, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';

export function StatusBanners({ showSync = true }: { showSync?: boolean }) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t } = useI18n();
  const now = Date.now();
  const tracking = Object.values(snap.localShifts).some((s) => s.tracking);
  const sync = syncLine(snap.syncDisplay, now, t);
  const discardedReason = discardedReasonLine(snap.discarded.lastReason, t);
  return (
    <>
      {snap.clockSkewed ? <Banner tone="warning" text={t('clock.wrong')} /> : null}
      {snap.versionGate === 'UPDATE_RECOMMENDED' ? (
        <Banner tone="info" text={t('update.recommended')} />
      ) : null}
      {snap.versionGate === 'UPDATE_REQUIRED' && tracking ? (
        <Banner tone="warning" text={t('update.duringShift')} />
      ) : null}
      {tracking && snap.tracking.problem ? (
        <Banner
          tone="danger"
          text={trackingLine(snap.tracking, true, now, t).text}
          action={{
            label: t('common.fix'),
            onPress: () =>
              void (snap.tracking.problem === 'LOCATION_SERVICES_OFF'
                ? openLocationSettings()
                : openAppSettings()),
          }}
        />
      ) : null}
      {snap.discarded.count > 0 ? (
        <Banner
          tone="danger"
          text={`${t('sync.discarded', { count: snap.discarded.count })}${discardedReason ? ` ${discardedReason}` : ''}`}
          action={{ label: t('sync.discardedAcknowledge'), onPress: () => void app.acknowledgeDiscarded() }}
        />
      ) : null}
      {showSync && snap.syncDisplay.kind !== 'DISCARDED' ? <Txt tone={sync.tone}>{sync.text}</Txt> : null}
    </>
  );
}

/** PROD §11.1: on every screen during a shift, and on the home screen off-shift. Hidden when SOS is off. */
export function SosHold({ navigate }: { navigate: Navigate }) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t } = useI18n();
  if (!snap.settings.features.sos) return null;
  return (
    <HoldButton
      label={t('sos.hold')}
      holdingLabel={t('sos.holding')}
      durationMs={3_000}
      onComplete={() => {
        void app.triggerSos();
        navigate({ name: 'sos' });
      }}
    />
  );
}

export function useResumable(shiftId: string): boolean {
  const snap = useSnapshot();
  const local = snap.localShifts[shiftId];
  return local ? canResume(local, Date.now() + (snap.serverOffsetMs ?? 0)) : false;
}
