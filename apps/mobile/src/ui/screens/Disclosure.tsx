// The tracking disclosure (PROD §7.2, SEC §16.3), before any permission request and again whenever
// the version changes. "I understand" is recorded on the server with the version and language; only
// text bundled in this build can be accepted.
import { useState } from 'react';
import { View } from 'react-native';

import { disclosureFor } from '../../core/i18n/disclosure.ts';
import { Banner, Button, Card, Screen, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';
import { space } from '../theme.ts';

export function DisclosureScreen() {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const version = snap.consent.version;
  const text = version ? disclosureFor(version, locale) : null;

  if (!version || !text) {
    return (
      <Screen>
        <Txt kind="title">SENTRY</Txt>
        <Banner tone="warning" text={version ? t('disclosure.unknownVersion') : t('common.loading')} />
        {version ? null : (
          <Button kind="secondary" icon="↻" label={t('home.refresh')} onPress={() => void app.refresh()} />
        )}
      </Screen>
    );
  }

  const accept = () => {
    setBusy(true);
    setFailed(false);
    void app
      .acceptDisclosure()
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <Screen>
      <Txt kind="title">{text.title}</Txt>
      <Card>
        <Txt>{text.intro}</Txt>
        <View style={{ gap: space.xs }}>
          {text.purposes.map((purpose) => (
            <Txt key={purpose}>{`•  ${purpose}`}</Txt>
          ))}
        </View>
      </Card>
      {text.paragraphs.map((paragraph) => (
        <Txt key={paragraph}>{paragraph}</Txt>
      ))}
      <Txt kind="small" tone="muted">
        {t('disclosure.version', { version })}
      </Txt>
      {failed ? <Banner tone="danger" text={t('disclosure.error')} /> : null}
      <Button
        icon="✓"
        label={busy ? t('disclosure.saving') : t('disclosure.accept')}
        busy={busy}
        onPress={accept}
      />
    </Screen>
  );
}
