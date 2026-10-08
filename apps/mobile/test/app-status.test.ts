import type { SyncItem } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import { allDataSent, syncDisplay } from '../src/core/status.ts';
import { fixAt, GOOD_PROBE, north } from './support/fakes.ts';
import { SHIFT_1, testConfig } from './support/fake-server.ts';
import { makeApp, readyGuard, settle } from './support/harness.ts';

const idle = { inFlight: false, lastSuccessAtMs: 1_000, blocked: null } as const;
const queue = (pending: number, inBatch = 0) => ({
  pending,
  pendingMain: pending,
  pendingSos: 0,
  inBatch,
  oldestRecordedAtMs: pending > 0 ? 500 : null,
});
const none = { count: 0, lastReason: null, lastAtMs: null };

describe('honest sync status (PROD §7.6, INV-16)', () => {
  it('ADV-U03 “All data sent” only when the outbox is empty and every item was answered', () => {
    expect(allDataSent({ queue: queue(0), sync: idle, signedOut: false, discarded: none })).toBe(true);
    expect(allDataSent({ queue: queue(3), sync: idle, signedOut: false, discarded: none })).toBe(false);
    expect(
      allDataSent({ queue: queue(0), sync: { ...idle, inFlight: true }, signedOut: false, discarded: none }),
    ).toBe(false);
    expect(allDataSent({ queue: queue(0, 2), sync: idle, signedOut: false, discarded: none })).toBe(false);
    // Items dropped on the phone were never answered: no "All data sent" until the guard has read why.
    expect(
      allDataSent({
        queue: queue(0),
        sync: idle,
        signedOut: false,
        discarded: { count: 4, lastReason: 'EXPIRED', lastAtMs: 1 },
      }),
    ).toBe(false);
    expect(allDataSent({ queue: queue(0), sync: idle, signedOut: true, discarded: none })).toBe(false);
    // Nothing ever sent is "nothing to send yet", not "all data sent".
    expect(
      syncDisplay({
        queue: queue(0),
        sync: { ...idle, lastSuccessAtMs: null },
        signedOut: false,
        discarded: none,
      }).kind,
    ).toBe('NOTHING_YET');
  });

  it('ADV-U03 end to end: waiting while offline, “all data sent” only after the server answered for every item', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.server.mode = { kind: 'offline' };
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await h.app.onLocations([fixAt(h.clocks.wall.nowMs())]);
    expect(h.app.snapshot().syncDisplay.kind).toBe('WAITING');
    h.server.mode = { kind: 'online' };
    h.server.decide = (item) => (item.type === 'LOCATION' ? { status: 'RETRY' } : { status: 'ACCEPTED' });
    await h.app.flush({ urgent: true });
    expect(h.app.snapshot().syncDisplay.kind).not.toBe('ALL_SENT'); // a RETRY item is still on the phone
    h.server.decide = () => ({ status: 'ACCEPTED' });
    h.clocks.advance(60_000);
    await h.app.flush({ urgent: true });
    expect(h.app.snapshot().queue.pending).toBe(0);
    expect(h.app.snapshot().syncDisplay.kind).toBe('ALL_SENT');
  });

  it('ADV-U02 a permission downgrade mid-shift is reported at once and shown as a tracking problem', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    expect(h.app.snapshot().tracking.problem).toBeNull();
    const sentBefore = h.server.batches.flatMap((b) => b.items).length;
    h.device.probeValue = { ...GOOD_PROBE, locationPermission: 'WHEN_IN_USE' };
    await h.app.onPermissionsChanged();
    expect(h.app.snapshot().tracking.problem).toBe('NOT_ALWAYS');
    await h.app.flush({ urgent: true });
    const statuses = h.server.batches
      .flatMap((b) => b.items as SyncItem[])
      .slice(sentBefore)
      .filter((i) => i.type === 'DEVICE_STATUS');
    expect(statuses.at(-1)).toMatchObject({ status: { locationPermission: 'WHEN_IN_USE' } });
  });

  it('warns about the phone clock when it is more than 2 minutes off the server’s', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect(h.app.snapshot().clockSkewed).toBe(false);
    h.clocks.setWall(h.clocks.wall.nowMs() + 5 * 60_000);
    await h.app.refresh();
    expect(h.app.snapshot().clockSkewed).toBe(true);
    expect(h.app.snapshot().serverOffsetMs).toBeLessThan(-4 * 60_000);
  });

  it('re-reading an unchanged phone does not re-render, so readiness checks cannot loop', async () => {
    const h = await makeApp();
    await readyGuard(h);
    await h.app.probeDevice();
    const probe = h.app.snapshot().probe;
    let renders = 0;
    const unsubscribe = h.app.subscribe(() => renders++);
    await h.app.probeDevice();
    await h.app.readinessItems();
    expect(renders).toBe(0);
    expect(h.app.snapshot().probe).toBe(probe); // same object: effects keyed on it do not re-run
    h.device.probeValue = { ...GOOD_PROBE, batteryPct: 40 };
    await h.app.probeDevice();
    expect(renders).toBe(1);
    unsubscribe();
  });
});

describe('consent (PROD §7.2, SEC §16.3)', () => {
  it('requires acceptance of the current disclosure version, and again when the version changes', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect(h.app.snapshot().consent).toEqual({ required: false, version: '1', bundled: true });
    h.server.config = testConfig({ disclosureVersion: '2' });
    await h.app.refresh();
    expect(h.app.snapshot().consent).toEqual({ required: true, version: '2', bundled: false });
    // This build has no text for version 2: it cannot record acceptance of words it never showed.
    await expect(h.app.acceptDisclosure()).rejects.toThrow();
    expect(h.server.consents).toHaveLength(1);
    const result = await h.app.startShift(SHIFT_1);
    expect(result.kind).toBe('BLOCKED');
  });

  it('records the acceptance on the server before tracking may start', async () => {
    const h = await makeApp();
    h.server.addEnrollment('K7Q4-M9XP', '+923001234567');
    await h.app.setLocale('ur');
    await h.app.enroll({ code: 'K7Q4-M9XP', phone: '03001234567', confirmDataLoss: false });
    await h.app.refresh();
    const blocked = await h.app.startShift('0190a0d2-7c5e-7000-8000-000000000101');
    expect(blocked.kind).not.toBe('OK');
    h.server.mode = { kind: 'offline' };
    await expect(h.app.acceptDisclosure()).rejects.toThrow();
    expect(h.app.snapshot().consent.required).toBe(true);
    h.server.mode = { kind: 'online' };
    await h.app.acceptDisclosure();
    expect(h.server.consents.at(-1)).toMatchObject({ disclosureVersion: '1', locale: 'ur' });
    expect(h.app.snapshot().consent.required).toBe(false);
  });
});

describe('incidents (PROD §7.8, INV-08)', () => {
  it('can be reported only during an active shift, with a fix, and show “saved on this phone” until answered', async () => {
    const h = await makeApp();
    await readyGuard(h);
    const input = {
      shiftId: SHIFT_1,
      type: 'THEFT',
      severity: 'HIGH' as const,
      title: 'Gate forced',
      description: 'Back gate',
    };
    expect(await h.app.reportIncident(input)).toBeNull(); // no active shift
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    h.server.mode = { kind: 'offline' };
    h.location.nextFix = north(fixAt(h.clocks.wall.nowMs()), 10, h.clocks.wall.nowMs());
    const id = await h.app.reportIncident(input);
    expect(id).not.toBeNull();
    expect((await h.app.receipt(id ?? ''))?.status).toBe('QUEUED');
    h.server.mode = { kind: 'online' };
    await h.app.flush({ urgent: true });
    expect((await h.app.receipt(id ?? ''))?.status).toBe('ACCEPTED');
    const sent = h.server.batches.flatMap((b) => b.items as SyncItem[]).find((i) => i.clientEventId === id);
    expect(sent).toMatchObject({ type: 'INCIDENT', incident: { title: 'Gate forced', severity: 'HIGH' } });
    expect(sent && 'fix' in sent ? sent.fix : null).not.toBeNull();
  });

  it('are neither created nor sent while the organization has incidents switched off (features.incidents)', async () => {
    const h = await makeApp();
    h.server.config = testConfig({ features: { sos: false, patrols: false, incidents: false } });
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    const input = {
      shiftId: SHIFT_1,
      type: 'OTHER',
      severity: 'LOW' as const,
      title: 'Note',
      description: '',
    };
    expect(await h.app.reportIncident(input)).toBeNull();
    await h.app.flush({ urgent: true });
    const types = h.server.batches.flatMap((b) => b.items as SyncItem[]).map((i) => i.type);
    expect(types).not.toContain('INCIDENT');
    expect(types).not.toContain('CHECKPOINT_SCAN');
  });
});

describe('readiness before Start (PROD §7.4)', () => {
  it('blocks a start without “Allow all the time” under the BLOCK policy, and only warns under WARN', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.device.probeValue = { ...GOOD_PROBE, locationPermission: 'WHEN_IN_USE' };
    const blocked = await h.app.startShift(SHIFT_1);
    expect(blocked.kind).toBe('BLOCKED');
    h.server.config = testConfig({ shift: { ...testConfig().shift, requireBackgroundPermission: 'WARN' } });
    await h.app.refresh();
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
  });

  it('refuses to start without a fresh fix (the server would refuse it too)', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.location.nextFix = null;
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('NO_FIX');
    h.location.nextFix = fixAt(h.clocks.wall.nowMs() - 5 * 60_000); // older than startMaxFixAgeSeconds
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('NO_FIX');
    expect(h.app.snapshot().queue.pending).toBe(0);
  });
});
