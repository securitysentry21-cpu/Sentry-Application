// Incident report, text only in this build (PROD §7.8, §10): type, severity (preset by type), title
// and details; the location is captured automatically; only during an active shift (INV-08). Works
// offline: the report is "Saved on this phone" until the server answers for it.
import { INCIDENT_SEVERITIES } from '@sentryops/contracts';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import type { Receipt } from '../../core/outbox/outbox.ts';
import { receiptLine } from '../../core/presenter.ts';
import type { Navigate } from '../App.tsx';
import { Banner, Button, Field, Screen, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';
import { space } from '../theme.ts';
import { SosHold } from './Common.tsx';

const TYPES = [
  'THEFT',
  'INTRUSION',
  'FIRE',
  'MEDICAL',
  'PROPERTY_DAMAGE',
  'ALTERCATION',
  'SUSPICIOUS_ACTIVITY',
  'OTHER',
] as const;
type IncidentType = (typeof TYPES)[number];
type Severity = (typeof INCIDENT_SEVERITIES)[number];

/** PROD §7.8: severity preset by type (fire and medical start at HIGH). */
const PRESET: Record<IncidentType, Severity> = {
  THEFT: 'MEDIUM',
  INTRUSION: 'HIGH',
  FIRE: 'HIGH',
  MEDICAL: 'HIGH',
  PROPERTY_DAMAGE: 'MEDIUM',
  ALTERCATION: 'HIGH',
  SUSPICIOUS_ACTIVITY: 'MEDIUM',
  OTHER: 'LOW',
};

export function IncidentScreen({ shiftId, navigate }: { shiftId: string; navigate: Navigate }) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t } = useI18n();
  const [kind, setKind] = useState<IncidentType | null>(null);
  const [severity, setSeverity] = useState<Severity>('MEDIUM');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const tracking = snap.localShifts[shiftId]?.tracking ?? false;

  // The receipt changes when the server answers; the queue counts change with it.
  useEffect(() => {
    if (!sentId) return;
    void app.receipt(sentId).then(setReceipt);
  }, [app, sentId, snap.queue]);

  if (!tracking && !sentId) {
    return (
      <Screen>
        <Txt kind="title">{t('incident.title')}</Txt>
        <Banner tone="info" text={t('incident.onlyDuringShift')} />
        <Button
          kind="secondary"
          icon="←"
          label={t('common.back')}
          onPress={() => navigate({ name: 'shift', shiftId })}
        />
      </Screen>
    );
  }

  if (sentId) {
    const line = receiptLine(receipt, t);
    return (
      <Screen>
        <Txt kind="title">{t('incident.sent')}</Txt>
        <Banner
          tone={line.tone === 'ok' ? 'ok' : line.tone === 'danger' ? 'danger' : 'warning'}
          text={line.text}
        />
        {severity === 'CRITICAL' && snap.settings.features.sos ? (
          <>
            <Txt>{t('incident.alsoSos')}</Txt>
            <SosHold navigate={navigate} />
          </>
        ) : null}
        <Button
          kind="secondary"
          icon="←"
          label={t('common.back')}
          onPress={() => navigate({ name: 'shift', shiftId })}
        />
      </Screen>
    );
  }

  const submit = () => {
    if (!kind) return;
    if (title.trim().length === 0) {
      setProblem(t('incident.titleRequired'));
      return;
    }
    setBusy(true);
    setProblem(null);
    void app
      .reportIncident({ shiftId, type: kind, severity, title, description })
      .then((id) => {
        if (id) setSentId(id);
        else setProblem(t('incident.onlyDuringShift'));
      })
      .finally(() => setBusy(false));
  };

  return (
    <Screen>
      <Txt kind="title">{t('incident.title')}</Txt>
      <Txt kind="heading">{t('incident.type')}</Txt>
      <View style={{ gap: space.sm }}>
        {TYPES.map((type) => (
          <Button
            key={type}
            kind={kind === type ? 'primary' : 'secondary'}
            icon={kind === type ? '●' : '○'}
            label={t(`incident.type.${type}`)}
            onPress={() => {
              setKind(type);
              setSeverity(PRESET[type]);
            }}
          />
        ))}
      </View>
      {kind ? (
        <>
          <Txt kind="heading">{t('incident.severity')}</Txt>
          <View style={{ gap: space.sm }}>
            {INCIDENT_SEVERITIES.map((level) => (
              <Button
                key={level}
                kind={severity === level ? (level === 'CRITICAL' ? 'danger' : 'primary') : 'secondary'}
                icon={severity === level ? '●' : '○'}
                label={t(`incident.severity.${level}`)}
                onPress={() => setSeverity(level)}
              />
            ))}
          </View>
          <Field
            label={t('incident.titleLabel')}
            value={title}
            onChangeText={setTitle}
            autoCapitalize="sentences"
            maxLength={120}
          />
          <Field
            label={t('incident.descriptionLabel')}
            value={description}
            onChangeText={setDescription}
            autoCapitalize="sentences"
            multiline
            maxLength={4_000}
          />
          {problem ? <Banner tone="danger" text={problem} /> : null}
          <Button
            icon="➤"
            label={busy ? t('incident.saving') : t('incident.submit')}
            busy={busy}
            onPress={submit}
          />
        </>
      ) : null}
      <Button
        kind="secondary"
        icon="←"
        label={t('common.back')}
        onPress={() => navigate({ name: 'shift', shiftId })}
      />
    </Screen>
  );
}
