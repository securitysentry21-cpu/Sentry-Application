// The guard's own reports of the last two weeks (PROD §10.2): reference, status and photos as the
// server has them, the guard's own notes, and a note to add (queued like every offline item). The
// original report is never edited: corrections are notes.
import type { GuardIncident, GuardIncidentsResponse } from '@sentryops/contracts';
import { useCallback, useEffect, useState } from 'react';

import { formatAgo } from '../../core/i18n/format.ts';
import type { Receipt } from '../../core/outbox/outbox.ts';
import { receiptLine } from '../../core/presenter.ts';
import type { Navigate } from '../App.tsx';
import { Banner, Button, Card, Field, Screen, Txt } from '../components.tsx';
import { useGuardApp, useI18n, useSnapshot } from '../context.tsx';

export function MyIncidentsScreen({ navigate }: { navigate: Navigate }) {
  const app = useGuardApp();
  const { t } = useI18n();
  const [list, setList] = useState<GuardIncidentsResponse | null | 'loading'>('loading');
  const load = useCallback(() => {
    void app.myIncidents().then(setList);
  }, [app]);
  useEffect(load, [load]);

  return (
    <Screen>
      <Txt kind="title">{t('incident.mine')}</Txt>
      {list === 'loading' ? <Txt tone="muted">{t('common.loading')}</Txt> : null}
      {list === null ? <Banner tone="warning" text={t('incident.mine.unavailable')} /> : null}
      {list && list !== 'loading' && list.incidents.length === 0 ? (
        <Txt>{t('incident.mine.none')}</Txt>
      ) : null}
      {list && list !== 'loading'
        ? list.incidents.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} serverNowMs={Date.parse(list.serverTime)} />
          ))
        : null}
      <Button kind="secondary" icon="↻" label={t('home.refresh')} onPress={load} />
      <Button kind="secondary" icon="←" label={t('common.back')} onPress={() => navigate({ name: 'home' })} />
    </Screen>
  );
}

function IncidentCard({ incident, serverNowMs }: { incident: GuardIncident; serverNowMs: number }) {
  const app = useGuardApp();
  const snap = useSnapshot();
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [noteId, setNoteId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const rejected = incident.photos.filter((p) => p.status === 'REJECTED').length;

  useEffect(() => {
    if (!noteId) return;
    void app.receipt(noteId).then(setReceipt);
  }, [app, noteId, snap.queue]);

  const send = () => {
    void app.addIncidentNote({ id: incident.id, clientEventId: null }, note).then((id) => {
      if (!id) return;
      setNoteId(id);
      setNote('');
    });
  };
  const line = noteId ? receiptLine(receipt, t) : null;

  return (
    <Card>
      <Txt kind="heading">{`${incident.referenceNumber} · ${t(`incident.type.${incident.type}`)}`}</Txt>
      <Txt tone={incident.status === 'RESOLVED' ? 'muted' : 'default'}>
        {`${t(`incident.status.${incident.status}`)} · ${t(`incident.severity.${incident.severity}`)} · ${formatAgo(
          serverNowMs - Date.parse(incident.receivedAt),
          t,
        )}`}
      </Txt>
      <Txt>{incident.title}</Txt>
      {incident.photos.length > 0 ? (
        <Txt tone="muted">{t('incident.mine.photos', { count: incident.photos.length })}</Txt>
      ) : null}
      {rejected > 0 ? (
        <Txt tone="warning">{t('incident.mine.photosRejected', { count: rejected })}</Txt>
      ) : null}
      {incident.notes.map((n) => (
        <Txt key={`${n.createdAt}:${n.body}`} tone="muted">{`— ${n.body}`}</Txt>
      ))}
      {/* Also after it is closed: a correction is a note (PROD §10.2). */}
      <Field
        label={t('incident.note.label')}
        value={note}
        onChangeText={setNote}
        autoCapitalize="sentences"
        multiline
        maxLength={4_000}
      />
      <Button
        kind="secondary"
        icon="✎"
        label={t('incident.note.send')}
        disabled={note.trim().length === 0}
        onPress={send}
      />
      {line ? <Txt tone={line.tone}>{line.tone === 'ok' ? t('incident.note.saved') : line.text}</Txt> : null}
    </Card>
  );
}
