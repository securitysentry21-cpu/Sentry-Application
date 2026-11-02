// Incidents on the phone (PROD §7.8, §10; ARCH §12; D-18): reports with photos, offline first; the
// photos upload only after the server has their report; a report during an open SOS off shift; notes.
import type { SyncItem } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import { fixAt } from './support/fakes.ts';
import { SHIFT_1 } from './support/fake-server.ts';
import { makeApp, readyGuard, settle } from './support/harness.ts';

const photo = (n: number, source: 'IN_APP_CAMERA' | 'GALLERY') => ({
  uri: `file:///cache/picked-${n}.jpg`,
  width: 4000,
  height: 3000,
  source,
});

const sentItems = (h: Awaited<ReturnType<typeof makeApp>>) =>
  h.server.batches.flatMap((b) => b.items as SyncItem[]);

describe('a report with photos (ARCH §12, D-18)', () => {
  it('photos wait on the phone until the server has the report, then upload through their slots and are removed', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    h.server.mode = { kind: 'offline' };
    h.location.nextFix = fixAt(h.clocks.wall.nowMs(), { accuracyM: 6 });
    const id = await h.app.reportIncident({
      shiftId: SHIFT_1,
      type: 'FIRE',
      severity: 'HIGH',
      description: 'Smoke behind the depot',
      photos: [photo(1, 'IN_APP_CAMERA'), photo(2, 'GALLERY')],
    });
    expect(id).not.toBeNull();
    expect(h.photos.prepared.map((p) => p.sourceUri)).toEqual([
      'file:///cache/picked-1.jpg',
      'file:///cache/picked-2.jpg',
    ]);
    expect(h.app.snapshot().pendingPhotos).toBe(2);
    expect(h.server.photoSlots.size).toBe(0);

    h.server.mode = { kind: 'online' };
    await h.app.flush({ urgent: true });
    expect((await h.app.receipt(id ?? ''))?.referenceNumber).toMatch(/^INC-\d{6}$/);
    expect([...h.server.photoSlots.values()].map((s) => s.captureSource)).toEqual([
      'IN_APP_CAMERA',
      'GALLERY',
    ]);
    expect(h.photos.uploads.map((u) => u.headers['content-type'])).toEqual(['image/jpeg', 'image/jpeg']);
    expect(h.server.photoCompletes.map((c) => c.sha256)).toEqual(['ab'.repeat(32), 'ab'.repeat(32)]);
    expect(h.photos.removed).toHaveLength(2);
    expect(h.app.snapshot().pendingPhotos).toBe(0);
  });

  it('an upload the storage refuses is retried later, never reported as done', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    h.photos.uploadStatus = 503;
    await h.app.reportIncident({
      shiftId: SHIFT_1,
      type: 'THEFT',
      severity: 'MEDIUM',
      description: '',
      photos: [photo(1, 'IN_APP_CAMERA')],
    });
    await h.app.flush({ urgent: true });
    expect(h.server.photoCompletes).toHaveLength(0);
    expect(h.app.snapshot().pendingPhotos).toBe(1);
    h.photos.uploadStatus = 200;
    h.clocks.advance(10 * 60_000);
    await h.app.flush({ urgent: true });
    expect(h.server.photoCompletes).toHaveLength(1);
    expect(h.app.snapshot().pendingPhotos).toBe(0);
  });

  it('an upload the storage answers 412 (already there from a try whose answer was lost) goes on to complete', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    h.photos.uploadStatus = 412;
    await h.app.reportIncident({
      shiftId: SHIFT_1,
      type: 'THEFT',
      severity: 'MEDIUM',
      description: '',
      photos: [photo(1, 'GALLERY')],
    });
    await h.app.flush({ urgent: true });
    expect(h.server.photoCompletes).toHaveLength(1);
    expect(h.app.snapshot().pendingPhotos).toBe(0);
  });

  it('a report the server refuses takes its photos with it: they leave the phone, nothing uploads', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    h.server.decide = (item) =>
      item.type === 'INCIDENT' ? { status: 'REJECTED', code: 'SHIFT_NOT_ACTIVE' } : { status: 'ACCEPTED' };
    await h.app.reportIncident({
      shiftId: SHIFT_1,
      type: 'OTHER',
      severity: 'LOW',
      description: '',
      photos: [photo(1, 'GALLERY')],
    });
    await h.app.flush({ urgent: true });
    await h.app.flush({ urgent: true });
    expect(h.server.photoSlots.size).toBe(0);
    expect(h.photos.removed).toHaveLength(1);
    expect(h.app.snapshot().pendingPhotos).toBe(0);
  });
});

describe('when a guard may report (INV-08)', () => {
  it('off shift with no SOS, nothing can be reported; during an open SOS a report goes without a shift', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect(h.app.incidentContext()).toBeNull();
    expect(
      await h.app.reportIncident({ shiftId: null, type: 'OTHER', severity: 'LOW', description: '' }),
    ).toBeNull();
    await h.app.triggerSos();
    await settle();
    expect(h.app.incidentContext()).toEqual({ shiftId: null });
    const id = await h.app.reportIncident({
      shiftId: null,
      type: 'ALTERCATION',
      severity: 'CRITICAL',
      description: 'Attacked at the gate',
    });
    await h.app.flush({ urgent: true });
    expect(sentItems(h).find((i) => i.clientEventId === id)).toMatchObject({
      type: 'INCIDENT',
      shiftId: null,
    });
  });

  it('the time may be set back up to 24 hours, never more, never ahead', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    const now = h.clocks.wall.nowMs();
    const ids = [
      await h.app.reportIncident({
        shiftId: SHIFT_1,
        type: 'THEFT',
        severity: 'LOW',
        description: '',
        occurredAtMs: now - 2 * 3_600_000,
      }),
      await h.app.reportIncident({
        shiftId: SHIFT_1,
        type: 'THEFT',
        severity: 'LOW',
        description: '',
        occurredAtMs: now - 30 * 3_600_000,
      }),
      await h.app.reportIncident({
        shiftId: SHIFT_1,
        type: 'THEFT',
        severity: 'LOW',
        description: '',
        occurredAtMs: now + 3_600_000,
      }),
    ];
    await h.app.flush({ urgent: true });
    const occurred = ids.map((id) => {
      const item = sentItems(h).find((i) => i.clientEventId === id);
      return item?.type === 'INCIDENT' ? Date.parse(item.incident.occurredAt) : null;
    });
    expect(occurred).toEqual([now - 2 * 3_600_000, now - 24 * 3_600_000, now]);
  });
});

describe('notes on the guard’s own report (PROD §10.2)', () => {
  it('a note names the report by the phone’s id when the server id is not known yet', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    h.server.mode = { kind: 'offline' };
    const reportId = await h.app.reportIncident({
      shiftId: SHIFT_1,
      type: 'INTRUSION',
      severity: 'HIGH',
      description: '',
    });
    const noteId = await h.app.addIncidentNote(
      { id: null, clientEventId: reportId },
      'They ran towards the canal',
    );
    h.server.mode = { kind: 'online' };
    await h.app.flush({ urgent: true });
    expect(sentItems(h).find((i) => i.clientEventId === noteId)).toMatchObject({
      type: 'INCIDENT_NOTE',
      incidentClientEventId: reportId,
      body: 'They ran towards the canal',
    });
    expect((await h.app.receipt(noteId ?? ''))?.status).toBe('ACCEPTED');
  });
});
