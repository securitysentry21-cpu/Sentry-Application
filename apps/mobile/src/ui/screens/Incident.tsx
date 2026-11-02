// Incident report (PROD §7.8, §10): type, severity (preset by type), optional title and details, up
// to 5 photos from the in-app camera or the system photo picker (D-18, each labelled), when it
// happened (now, or up to 24 hours back), and the location captured automatically. Only during the
// shift this phone tracks or an open SOS (INV-08). Works offline: the report is "Saved on this phone"
// until the server answers for it, and its photos upload after that.
import {
  DEFAULT_INCIDENT_SEVERITY,
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES,
  MAX_INCIDENT_PHOTOS,
  type IncidentSeverity,
  type IncidentType,
} from '@sentryops/contracts';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import type { IncidentPhoto } from '../../core/app.ts';
import type { Receipt } from '../../core/outbox/outbox.ts';
import { receiptLine } from '../../core/presenter.ts';
import { pickFromGallery } from '../../platform/photos.ts';
import type { Navigate } from '../App.tsx';
import { Banner, Button, Field, Screen, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';
import { space } from '../theme.ts';
import { SosHold } from './Common.tsx';
import { PhotoCamera } from './PhotoCamera.tsx';

/** How far back the guard may set the time (PROD §10.1: up to 24 hours). */
const BACK_MINUTES = [0, 15, 30, 60, 120, 240, 480, 720, 1440] as const;

export type CheckpointProblem = { readonly checkpointId: string; readonly name: string };

export function IncidentScreen({
  shiftId,
  checkpoint,
  navigate,
}: {
  shiftId: string | null;
  /** "Checkpoint problem" (PROD §7.7): a LOW report linked to a damaged or missing label. */
  checkpoint?: CheckpointProblem | undefined;
  navigate: Navigate;
}) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t } = useI18n();
  const [kind, setKind] = useState<IncidentType | null>(checkpoint ? 'OTHER' : null);
  const [severity, setSeverity] = useState<IncidentSeverity>(checkpoint ? 'LOW' : 'MEDIUM');
  const [title, setTitle] = useState(
    checkpoint ? t('incident.checkpointTitle', { name: checkpoint.name }) : '',
  );
  const [description, setDescription] = useState('');
  const [backMinutes, setBackMinutes] = useState<number>(0);
  const [photos, setPhotos] = useState<IncidentPhoto[]>([]);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const context = app.incidentContext();
  const back = () =>
    navigate(
      shiftId && checkpoint
        ? { name: 'patrol', shiftId }
        : shiftId
          ? { name: 'shift', shiftId }
          : { name: snap.sos ? 'sos' : 'home' },
    );

  // The receipt changes when the server answers; the queue counts change with it.
  useEffect(() => {
    if (!sentId) return;
    void app.receipt(sentId).then(setReceipt);
  }, [app, sentId, snap.queue, snap.pendingPhotos]);

  if (camera) {
    return (
      <PhotoCamera
        onPhoto={(photo) => {
          setPhotos((list) =>
            [...list, { ...photo, source: 'IN_APP_CAMERA' as const }].slice(0, MAX_INCIDENT_PHOTOS),
          );
          setCamera(false);
        }}
        onCancel={() => setCamera(false)}
      />
    );
  }

  if ((!context || context.shiftId !== shiftId) && !sentId) {
    return (
      <Screen>
        <Txt kind="title">{t('incident.title')}</Txt>
        <Banner tone="info" text={t('incident.onlyDuringShift')} />
        <Button kind="secondary" icon="←" label={t('common.back')} onPress={back} />
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
        {receipt?.referenceNumber ? <Txt>{receipt.referenceNumber}</Txt> : null}
        {snap.pendingPhotos > 0 ? (
          <Txt tone="muted">{t('incident.photosWaiting', { count: String(snap.pendingPhotos) })}</Txt>
        ) : null}
        {severity === 'CRITICAL' && snap.settings.features.sos ? (
          <>
            <Txt>{t('incident.alsoSos')}</Txt>
            <SosHold navigate={navigate} />
          </>
        ) : null}
        <Button
          kind="secondary"
          icon="☰"
          label={t('incident.mine')}
          onPress={() => navigate({ name: 'myIncidents' })}
        />
        <Button kind="secondary" icon="←" label={t('common.back')} onPress={back} />
      </Screen>
    );
  }

  const submit = () => {
    if (!kind) return;
    setBusy(true);
    setProblem(null);
    void app
      .reportIncident({
        shiftId,
        type: kind,
        severity,
        ...(title.trim() ? { title } : {}),
        description,
        occurredAtMs: Date.now() - backMinutes * 60_000,
        ...(checkpoint ? { checkpointId: checkpoint.checkpointId } : {}),
        photos,
      })
      .then((id) => {
        if (id) setSentId(id);
        else setProblem(t('incident.onlyDuringShift'));
      })
      .finally(() => setBusy(false));
  };

  const addFromGallery = () => {
    void pickFromGallery().then((picked) => {
      if (picked)
        setPhotos((list) =>
          [...list, { ...picked, source: 'GALLERY' as const }].slice(0, MAX_INCIDENT_PHOTOS),
        );
    });
  };

  return (
    <Screen>
      <Txt kind="title">{checkpoint ? t('incident.checkpointProblem') : t('incident.title')}</Txt>
      {checkpoint ? <Txt tone="muted">{t('incident.checkpointHint')}</Txt> : null}
      {!checkpoint ? (
        <>
          <Txt kind="heading">{t('incident.type')}</Txt>
          <View style={{ gap: space.sm }}>
            {INCIDENT_TYPES.map((type) => (
              <Button
                key={type}
                kind={kind === type ? 'primary' : 'secondary'}
                icon={kind === type ? '●' : '○'}
                label={t(`incident.type.${type}`)}
                onPress={() => {
                  setKind(type);
                  setSeverity(DEFAULT_INCIDENT_SEVERITY[type]);
                }}
              />
            ))}
          </View>
        </>
      ) : null}
      {kind ? (
        <>
          {/* A checkpoint problem is always LOW (PROD §7.7). */}
          {!checkpoint ? (
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
            </>
          ) : null}
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
          <Txt kind="heading">{t('incident.when')}</Txt>
          <View style={{ gap: space.sm }}>
            {BACK_MINUTES.map((minutes) => (
              <Button
                key={minutes}
                kind={backMinutes === minutes ? 'primary' : 'secondary'}
                icon={backMinutes === minutes ? '●' : '○'}
                label={
                  minutes === 0
                    ? t('incident.when.now')
                    : minutes < 60
                      ? t('incident.when.minutes', { count: String(minutes) })
                      : t('incident.when.hours', { count: String(minutes / 60) })
                }
                onPress={() => setBackMinutes(minutes)}
              />
            ))}
          </View>
          <Txt kind="heading">
            {t('incident.photos', { count: String(photos.length), max: String(MAX_INCIDENT_PHOTOS) })}
          </Txt>
          {photos.map((photo, index) => (
            <Button
              key={photo.uri}
              kind="secondary"
              icon="✕"
              label={t(
                photo.source === 'GALLERY' ? 'incident.photo.fromGallery' : 'incident.photo.fromCamera',
                {
                  n: String(index + 1),
                },
              )}
              onPress={() => setPhotos((list) => list.filter((p) => p.uri !== photo.uri))}
            />
          ))}
          {photos.length < MAX_INCIDENT_PHOTOS ? (
            <>
              <Button
                kind="secondary"
                icon="◉"
                label={t('incident.photo.take')}
                onPress={() => setCamera(true)}
              />
              <Button kind="secondary" icon="▦" label={t('incident.photo.pick')} onPress={addFromGallery} />
            </>
          ) : null}
          {problem ? <Banner tone="danger" text={problem} /> : null}
          <Button
            icon="➤"
            label={busy ? t('incident.saving') : t('incident.submit')}
            busy={busy}
            onPress={submit}
          />
        </>
      ) : null}
      <Button kind="secondary" icon="←" label={t('common.back')} onPress={back} />
    </Screen>
  );
}
