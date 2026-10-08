// The pre-shift readiness check with its fixes (PROD §7.3–§7.4). Each permission is asked for from
// a button the guard taps, after the screen has said why; declining never loops or crashes, it just
// leaves the item marked as needed.
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import type { ReadinessItem, ReadinessKey } from '../../core/tracking/readiness.ts';
import {
  openAppSettings,
  openBatteryOptimizationSettings,
  openLocationSettings,
  requestBackgroundLocation,
  requestForegroundLocation,
  requestNotifications,
} from '../../platform/permissions.ts';
import { Button, Card, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';
import { space } from '../theme.ts';

const TONE = { OK: 'ok', WARNING: 'warning', BLOCKING: 'danger' } as const;
const ICON = { OK: '✓', WARNING: '⚠', BLOCKING: '✕' } as const;

export function useReadiness(): ReadinessItem[] {
  const app = useGuardApp();
  const snap = useSnapshot();
  const [items, setItems] = useState<ReadinessItem[]>([]);
  useEffect(() => {
    let alive = true;
    void app.readinessItems().then((next) => {
      if (alive) setItems(next);
    });
    return () => {
      alive = false;
    };
    // Re-checked when the phone's permissions, consent or version state change.
  }, [app, snap.probe, snap.consent.required, snap.versionGate, snap.phase]);
  return items;
}

export function ReadinessCard({ items }: { items: readonly ReadinessItem[] }) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t } = useI18n();
  const after = (action: () => Promise<unknown>) => () => {
    void action()
      .catch(() => undefined)
      .then(() => app.onPermissionsChanged());
  };
  const fixes: Partial<Record<ReadinessKey, { label: string; explain?: string; run: () => void }>> = {
    LOCATION_SERVICES: { label: t('common.openSettings'), run: after(openLocationSettings) },
    LOCATION_ALWAYS:
      snap.probe?.locationPermission === 'WHEN_IN_USE'
        ? {
            label: t('perm.background'),
            explain: t('perm.backgroundExplain'),
            run: after(requestBackgroundLocation),
          }
        : snap.probe?.locationPermission === 'DENIED'
          ? { label: t('common.openSettings'), run: after(openAppSettings) }
          : { label: t('perm.location'), run: after(requestForegroundLocation) },
    PRECISE_LOCATION: { label: t('perm.location'), run: after(requestForegroundLocation) },
    NOTIFICATIONS: { label: t('perm.notifications'), run: after(requestNotifications) },
    BATTERY_OPTIMIZATION: {
      label: t('perm.battery'),
      explain: t('perm.batteryExplain'),
      run: after(openBatteryOptimizationSettings),
    },
  };
  return (
    <Card>
      <Txt kind="heading">{t('shift.readiness')}</Txt>
      {items.map((item) => {
        const fix = item.level === 'OK' ? undefined : fixes[item.key];
        return (
          <View key={item.key} style={{ gap: space.xs }}>
            <Txt
              tone={TONE[item.level]}
            >{`${ICON[item.level]}  ${t(`ready.${item.key}`)} — ${t(`ready.${item.level}`)}`}</Txt>
            {fix?.explain ? (
              <Txt kind="small" tone="muted">
                {fix.explain}
              </Txt>
            ) : null}
            {fix ? <Button kind="secondary" icon="⚙" label={fix.label} onPress={fix.run} /> : null}
          </View>
        );
      })}
    </Card>
  );
}
