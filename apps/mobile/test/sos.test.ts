import { describe, expect, it } from 'vitest';

import {
  newSos,
  type SosEvent,
  type SosPhase,
  sosReducer,
  showCallFallback,
} from '../src/core/sos/machine.ts';
import { fixAt } from './support/fakes.ts';
import { SHIFT_1, testConfig } from './support/fake-server.ts';
import { makeApp, readyGuard, settle } from './support/harness.ts';

const EVENTS: SosEvent[] = [
  { type: 'SEND_STARTED' },
  { type: 'SEND_FAILED' },
  { type: 'SEND_REFUSED', errorCode: 'VALIDATION_FAILED' },
  { type: 'SERVER_CONFIRMED', sosEventId: 'sos-1', serverTime: '2026-10-08T15:00:00.000Z' },
];

describe('SOS client state machine (PROD §11.3)', () => {
  it('INV-10 no sequence of events shows RECEIVED without the server’s confirmation, or any later state', () => {
    // Every sequence of up to five events.
    const sequences: SosEvent[][] = [[]];
    for (let depth = 0; depth < 5; depth++) {
      for (const seq of [...sequences])
        if (seq.length === depth) for (const e of EVENTS) sequences.push([...seq, e]);
    }
    const allowed = new Set<SosPhase>(['QUEUED', 'SENDING', 'RECEIVED', 'FAILED']);
    for (const seq of sequences) {
      const end = seq.reduce(sosReducer, newSos('c', 0));
      expect(allowed.has(end.phase)).toBe(true);
      if (end.phase === 'RECEIVED') {
        expect(seq.some((e) => e.type === 'SERVER_CONFIRMED')).toBe(true);
        expect(end.sosEventId).toBe('sos-1');
      }
    }
  });

  it('once confirmed it stays confirmed: a later local failure cannot move it back', () => {
    const received = sosReducer(newSos('c', 0), EVENTS[3] ?? { type: 'SEND_STARTED' });
    expect(sosReducer(received, { type: 'SEND_FAILED' }).phase).toBe('RECEIVED');
    expect(sosReducer(received, { type: 'SEND_REFUSED', errorCode: 'X' }).phase).toBe('RECEIVED');
  });

  it('offers “Call supervisor” when the SOS is still only on the phone after 15 s (PROD §11.7)', () => {
    const queued = newSos('c', 1_000);
    expect(showCallFallback(queued, 15_999)).toBe(false);
    expect(showCallFallback(queued, 16_000)).toBe(true);
    const received = sosReducer(queued, EVENTS[3] ?? { type: 'SEND_STARTED' });
    expect(showCallFallback(received, 60_000)).toBe(false);
  });
});

describe('SOS lane (ARCH §13.1, INV-15)', () => {
  it('ADV-S02 with no network the SOS waits on the phone, is never shown as received, and arrives exactly once', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.server.mode = { kind: 'offline' };
    const id = await h.app.triggerSos();
    await settle();
    expect(h.app.snapshot().sos).toMatchObject({ clientEventId: id, phase: 'QUEUED', sosEventId: null });
    expect(h.app.snapshot().queue.pendingSos).toBe(1);
    expect(h.scheduler.tasks.length).toBeGreaterThan(0); // a retry is scheduled

    // Back online, but the first response is lost after the server stored it.
    h.server.mode = { kind: 'online' };
    h.server.loseResponse.add('/api/v1/sos');
    await h.app.onNetworkRegained();
    expect(h.app.snapshot().sos?.phase).toBe('QUEUED');
    await h.app.onNetworkRegained();
    expect(h.app.snapshot().sos?.phase).toBe('RECEIVED');
    expect(h.app.snapshot().sos?.sosEventId).toBe(h.server.sos.get(id)?.sosEventId);
    expect(h.server.sos.size).toBe(1); // the same clientEventId: one SOS on the server
    expect(h.app.snapshot().queue.pendingSos).toBe(0);
  });

  it('ADV-S11 when the session has expired and cannot be renewed, the SOS goes out signed with the device key', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.server.revokeAll(); // access expired, refresh refused
    h.clocks.advance(30 * 60_000);
    const id = await h.app.triggerSos();
    await settle();
    await h.app.flush();
    expect(h.server.sos.get(id)?.auth).toBe('signature');
    expect(h.app.snapshot().sos?.phase).toBe('RECEIVED');
    const sosRequest = h.server.requests.filter((r) => r.path === '/api/v1/sos').at(-1);
    expect(sosRequest?.headers['X-Device-Signature']).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{86}$/);
    expect(sosRequest?.headers['X-Device-Id']).toBeTruthy();
  });

  it('INV-15 the SOS lane ignores the main lane’s Retry-After, and a below-minimum app version', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.server.mode = { kind: 'status', status: 429, code: 'RATE_LIMITED', retryAfter: '600' };
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    const sync = h.app.snapshot().sync;
    expect(sync.retryAfterUntilMs).toBeGreaterThan(h.clocks.wall.nowMs()); // the main lane is held back

    h.server.mode = { kind: 'online' };
    h.server.config = testConfig({ minSupportedVersion: '9.0.0' });
    await h.app.refresh();
    expect(h.app.snapshot().versionGate).toBe('UPDATE_REQUIRED');
    h.location.nextFix = null;
    const id = await h.app.triggerSos();
    await settle();
    expect(h.server.sos.get(id)?.auth).toBe('bearer');
    expect(h.app.snapshot().sos?.phase).toBe('RECEIVED');
    expect(h.app.snapshot().queue.pendingMain).toBeGreaterThan(0); // the main lane still waits
  });

  it('below the minimum version no new shift can start (data and SOS still go up)', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.server.config = testConfig({ minSupportedVersion: '9.0.0' });
    await h.app.refresh();
    const result = await h.app.startShift(SHIFT_1);
    expect(result.kind).toBe('BLOCKED');
    if (result.kind === 'BLOCKED')
      expect(result.items).toContainEqual({ key: 'APP_VERSION', level: 'BLOCKING' });
  });

  it('a permanent refusal is shown as such (FAILED, call your supervisor), never as received', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.server.next.set('/api/v1/sos', { kind: 'status', status: 403, code: 'DEVICE_REVOKED' });
    await h.app.triggerSos();
    await settle();
    expect(h.app.snapshot().sos).toMatchObject({
      phase: 'FAILED',
      errorCode: 'DEVICE_REVOKED',
      sosEventId: null,
    });
  });

  it('during a shift, the best fix within 10 s follows the SOS as a location update of that shift', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    const before = h.server.batches.flatMap((b) => b.items).length;
    h.location.nextFix = fixAt(h.clocks.wall.nowMs(), { accuracyM: 5 });
    await h.app.triggerSos();
    await settle();
    await h.app.flush({ urgent: true });
    const after = h.server.batches.flatMap((b) => b.items as { type: string }[]).slice(before);
    expect(after.some((i) => i.type === 'LOCATION')).toBe(true);
  });
});
