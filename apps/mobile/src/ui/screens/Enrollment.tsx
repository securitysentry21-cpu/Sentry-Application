// Enrollment (ARCH §5.3, PROD §4.3): the code from the supervisor (typed or scanned) and the guard's
// own number. If the phone still holds unsent data, the guard must confirm its loss first, because
// another guard's queue is never sent with this guard's session (ARCH §5.5, ADV-O07).
import { useState } from 'react';

import type { EnrollResult } from '../../core/app.ts';
import type { MessageKey } from '../../core/i18n/index.ts';
import { Banner, Button, Field, Screen, Txt } from '../components.tsx';
import { useGuardApp, useI18n } from '../context.tsx';
import { QrScanner } from './QrScanner.tsx';

const ERROR_KEYS: Record<Extract<EnrollResult, { kind: 'ERROR' }>['reason'], MessageKey> = {
  INVALID: 'enroll.errorInvalid',
  EXPIRED: 'enroll.errorExpired',
  RATE_LIMITED: 'enroll.errorRateLimited',
  NETWORK: 'enroll.errorNetwork',
  PHONE_FORMAT: 'enroll.errorPhone',
  CODE_FORMAT: 'enroll.errorCode',
  ACTIVE_SHIFT: 'enroll.activeShift',
  GENERIC: 'enroll.errorGeneric',
};

export function EnrollmentScreen({ onCancel }: { onCancel?: () => void }) {
  const app = useGuardApp();
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<EnrollResult | null>(null);

  const submit = (confirmDataLoss: boolean) => {
    setBusy(true);
    void app
      .enroll({ code, phone, confirmDataLoss })
      .then(setResult)
      .finally(() => setBusy(false));
  };

  if (scanning) {
    return (
      <QrScanner
        onCode={(scanned) => {
          setCode(scanned);
          setScanning(false);
        }}
        onCancel={() => setScanning(false)}
      />
    );
  }

  return (
    <Screen>
      <Txt kind="title">{t('enroll.title')}</Txt>
      <Txt tone="muted">{t('enroll.intro')}</Txt>
      <Field
        label={t('enroll.codeLabel')}
        value={code}
        onChangeText={setCode}
        placeholder={t('enroll.codePlaceholder')}
        autoCapitalize="characters"
        maxLength={64}
      />
      <Button kind="secondary" icon="▣" label={t('enroll.scanQr')} onPress={() => setScanning(true)} />
      <Field
        label={t('enroll.phoneLabel')}
        value={phone}
        onChangeText={setPhone}
        placeholder={t('enroll.phonePlaceholder')}
        keyboardType="phone-pad"
        maxLength={20}
      />
      {result?.kind === 'ERROR' ? (
        <Banner
          tone="danger"
          text={`${t(ERROR_KEYS[result.reason])}${result.code ? ` (${t('common.errorCode', { code: result.code })})` : ''}`}
        />
      ) : null}
      {result?.kind === 'NEEDS_CONFIRMATION' ? (
        <>
          <Banner tone="warning" text={t('enroll.otherGuardData', { count: result.pending })} />
          <Button
            kind="danger"
            icon="⚠"
            label={t('enroll.confirmDiscard')}
            busy={busy}
            onPress={() => submit(true)}
          />
        </>
      ) : (
        <Button
          icon="✓"
          label={busy ? t('enroll.working') : t('enroll.submit')}
          busy={busy}
          onPress={() => submit(false)}
        />
      )}
      {onCancel ? <Button kind="secondary" icon="←" label={t('common.back')} onPress={onCancel} /> : null}
    </Screen>
  );
}
