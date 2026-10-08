// Home (PROD §7.5): who is signed in, the guard's shifts in each site's timezone, and the honest
// status lines. Times are 24-hour in the site's zone (PROD §6.1).
import { View } from 'react-native';

import { formatAgo, formatDay, formatTime } from '../../core/i18n/format.ts';
import { shiftLine } from '../../core/presenter.ts';
import type { Navigate } from '../App.tsx';
import { Banner, Button, Card, Screen, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';
import { space } from '../theme.ts';
import { SosHold, StatusBanners } from './Common.tsx';

export function HomeScreen({ navigate }: { navigate: Navigate }) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t, locale } = useI18n();
  const now = Date.now();
  const shifts = [...snap.shifts].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  return (
    <Screen>
      <Txt kind="title">{t('home.greeting', { name: snap.identity?.guardDisplayName ?? '' })}</Txt>
      <Txt tone="muted">{snap.identity?.organizationName ?? ''}</Txt>
      <StatusBanners />
      <Txt kind="heading">{t('home.shifts')}</Txt>
      {snap.shiftsFromCache ? <Banner tone="warning" text={t('home.cached')} /> : null}
      {shifts.length === 0 ? <Txt tone="muted">{t('home.noShifts')}</Txt> : null}
      {shifts.map((shift) => {
        const zone = shift.site.timezone;
        const start = Date.parse(shift.startsAt);
        const end = Date.parse(shift.endsAt);
        const local = shiftLine(snap.localShifts[shift.id], t);
        return (
          <Card key={shift.id}>
            <Txt kind="heading">{shift.site.name}</Txt>
            <Txt>{`${formatDay(start, zone, locale)} · ${t('shift.time', {
              start: formatTime(start, zone, locale),
              end: formatTime(end, zone, locale),
            })}`}</Txt>
            <Txt tone="muted">{t(`shiftStatus.${shift.status}`)}</Txt>
            {local ? <Txt tone={local.tone}>{local.text}</Txt> : null}
            <Button
              kind="secondary"
              icon="›"
              label={t('home.open')}
              onPress={() => navigate({ name: 'shift', shiftId: shift.id })}
            />
          </Card>
        );
      })}
      {snap.shiftsFetchedAtMs !== null ? (
        <Txt kind="small" tone="muted">
          {t('home.updated', { ago: formatAgo(now - snap.shiftsFetchedAtMs, t) })}
        </Txt>
      ) : null}
      <View style={{ gap: space.sm }}>
        <Button kind="secondary" icon="↻" label={t('home.refresh')} onPress={() => void app.onForeground()} />
        <Button
          kind="secondary"
          icon="ⓘ"
          label={t('home.diagnostics')}
          onPress={() => navigate({ name: 'diagnostics' })}
        />
        <Button
          kind="secondary"
          icon="A/ا"
          label={t('home.language')}
          onPress={() => navigate({ name: 'language' })}
        />
      </View>
      <SosHold navigate={navigate} />
    </Screen>
  );
}
