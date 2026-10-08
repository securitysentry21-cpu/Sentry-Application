// Update required (ARCH §15.2). Below the minimum version no new shift starts, but data already on
// the phone keeps uploading and SOS still works (INV-15). A version revoked for security stops
// everything; only updating helps.
import type { Navigate } from '../App.tsx';
import { Banner, Button, Screen, Txt } from '../components.tsx';
import { useI18n } from '../context.tsx';
import { SosHold, StatusBanners } from './Common.tsx';

export function UpdateRequiredScreen({ revoked, navigate }: { revoked: boolean; navigate: Navigate }) {
  const { t } = useI18n();
  return (
    <Screen>
      <Txt kind="title">{t('update.title')}</Txt>
      <Banner tone="danger" text={revoked ? t('update.revoked') : t('update.body')} />
      {revoked ? null : <StatusBanners />}
      <Button
        kind="secondary"
        icon="ⓘ"
        label={t('home.diagnostics')}
        onPress={() => navigate({ name: 'diagnostics' })}
      />
      {revoked ? null : <SosHold navigate={navigate} />}
    </Screen>
  );
}
