import type { GuardPatrolRun, SyncItem } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import { translator } from '../src/core/i18n/index.ts';
import { isCheckpointLabel, nextCheckpoint, roundsView } from '../src/core/patrol.ts';
import { scanLine } from '../src/core/presenter.ts';
import { SHIFT_1, SHIFT_2, testConfig } from './support/fake-server.ts';
import { makeApp, readyGuard, settle, type Harness } from './support/harness.ts';

const MIN = 60_000;
const t = translator('en');
const LABEL = 'SG1:AbCdEfGhIjKlMnOpQrStUv';

const uuid = (n: number) => `0190a0d2-7c5e-7000-8000-${String(900 + n).padStart(12, '0')}`;

function run(n: number, dueMs: number, overrides: Partial<GuardPatrolRun> = {}): GuardPatrolRun {
  return {
    id: uuid(n),
    routeName: 'Night round',
    sequenceNo: n,
    dueAt: new Date(dueMs).toISOString(),
    windowEndsAt: new Date(dueMs + 30 * MIN).toISOString(),
    status: 'PENDING',
    requiredCount: 2,
    countedCount: 0,
    enforceOrder: false,
    checkpoints: [
      { checkpointId: uuid(50), name: 'Main gate', sequence: 1, required: true, done: null },
      { checkpointId: uuid(51), name: 'Store room', sequence: 2, required: true, done: null },
      { checkpointId: uuid(52), name: 'Roof', sequence: 3, required: false, done: null },
    ],
    ...overrides,
  };
}

describe('patrol rounds on the phone (PROD §7.7)', () => {
  it('knows a checkpoint label from other codes, as the server reads it (ARCH §11.1)', () => {
    expect(isCheckpointLabel(LABEL)).toBe(true);
    expect(isCheckpointLabel(` ${LABEL} `)).toBe(true);
    for (const other of ['K7Q4-M9XP', 'SGE1:K7Q4M9XP', 'https://example.test/', `${LABEL}x`, 'SG1:short']) {
      expect(isCheckpointLabel(other), other).toBe(false);
    }
  });

  it('shows the round whose window is open, else the next one; done and cancelled rounds drop out', () => {
    const now = Date.parse('2026-10-08T22:10:00Z');
    const runs = [
      run(1, now - 70 * MIN, { status: 'COMPLETED' }),
      run(2, now - 10 * MIN, { status: 'IN_PROGRESS' }),
      run(3, now + 50 * MIN),
      run(4, now + 110 * MIN),
      run(5, now + 170 * MIN, { status: 'CANCELLED' }),
    ];
    const view = roundsView(runs, now);
    expect(view.current?.sequenceNo).toBe(2);
    expect(view.upcoming.map((r) => r.sequenceNo)).toEqual([3, 4]);
    // Between rounds: the next one is current, and it says when it opens.
    expect(roundsView(runs.slice(2), now).current?.sequenceNo).toBe(3);
    // A window that closed without the server closing it yet is not offered.
    expect(roundsView([run(1, now - 40 * MIN)], now).current).toBeNull();
  });

  it('the next checkpoint is the first required one not done, in route order', () => {
    const r = run(1, 0);
    expect(nextCheckpoint(r)?.name).toBe('Main gate');
    const half = run(1, 0, {
      checkpoints: r.checkpoints.map((c) =>
        c.name === 'Main gate' ? { ...c, done: 'QR_ONLY' as const } : c,
      ),
    });
    expect(nextCheckpoint(half)?.name).toBe('Store room');
    const all = run(1, 0, {
      checkpoints: r.checkpoints.map((c) => (c.required ? { ...c, done: 'VERIFIED' as const } : c)),
    });
    expect(nextCheckpoint(all)).toBeNull();
  });
});

async function onShift(patrols = true): Promise<Harness> {
  const h = await makeApp();
  h.server.config = testConfig({ features: { sos: false, patrols, incidents: true } });
  await readyGuard(h);
  expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
  await settle();
  return h;
}

const scansSent = (h: Harness) =>
  h.server.batches.flatMap((b) => b.items as SyncItem[]).filter((i) => i.type === 'CHECKPOINT_SCAN');

describe('scanning a checkpoint (PROD §7.7)', () => {
  it("goes out at once with a fresh fix; the server's verdict lands on the scan's receipt", async () => {
    const h = await onShift();
    const start = await h.app.scanCheckpoint(SHIFT_1, LABEL);
    expect(start.kind).toBe('SAVED');
    await settle();
    expect(h.server.scans).toEqual([{ shiftId: SHIFT_1, token: LABEL, hadFix: true }]);
    const receipt = await h.app.receipt(start.kind === 'SAVED' ? start.clientEventId : '');
    expect(receipt).toMatchObject({ type: 'CHECKPOINT_SCAN', status: 'ACCEPTED' });
    expect(scanLine(receipt, false, t)).toEqual({ text: '✓ Verified: Main gate', tone: 'ok' });
  });

  it('INV-16 offline, the scan waits on the phone and reads “Saved — will verify when online”', async () => {
    const h = await onShift();
    h.server.mode = { kind: 'offline' };
    h.server.scanResult = {
      outcome: 'OUTSIDE_RADIUS',
      counted: false,
      checkpointName: 'Main gate',
      distanceM: 85,
      run: null,
    };
    const start = await h.app.scanCheckpoint(SHIFT_1, LABEL);
    const id = start.kind === 'SAVED' ? start.clientEventId : '';
    await settle();
    expect(scansSent(h)).toHaveLength(0);
    expect(scanLine(await h.app.receipt(id), false, t).text).toBe('Saved — will verify when online');
    h.server.mode = { kind: 'online' };
    await h.app.flush({ urgent: true });
    await settle();
    expect(scanLine(await h.app.receipt(id), false, t).text).toBe(
      'Not verified: about 85 m from this checkpoint',
    );
  });

  it('INV-08 off shift nothing is scanned and no location is taken; other codes are not sent', async () => {
    const h = await makeApp();
    h.server.config = testConfig({ features: { sos: false, patrols: true, incidents: true } });
    await readyGuard(h);
    const before = h.location.fixRequests;
    expect(await h.app.scanCheckpoint(SHIFT_1, LABEL)).toEqual({ kind: 'REFUSED', reason: 'NO_SHIFT' });
    expect(await h.app.scanCheckpoint(SHIFT_1, 'K7Q4-M9XP')).toEqual({
      kind: 'REFUSED',
      reason: 'NOT_A_CHECKPOINT',
    });
    await settle();
    expect(h.location.fixRequests).toBe(before);
    expect(scansSent(h)).toHaveLength(0);
    // Another shift than the one this phone tracks is refused too.
    const on = await onShift();
    expect(await on.app.scanCheckpoint(SHIFT_2, LABEL)).toEqual({ kind: 'REFUSED', reason: 'NO_SHIFT' });
  });

  it('with patrols off on the server, the app offers no scanning', async () => {
    const h = await onShift(false);
    expect(await h.app.scanCheckpoint(SHIFT_1, LABEL)).toEqual({ kind: 'REFUSED', reason: 'PATROLS_OFF' });
    expect(await h.app.patrols(SHIFT_1)).toBeNull();
  });

  it("the rounds come from the server, and from this phone's last copy while offline", async () => {
    const h = await onShift();
    h.server.patrolRuns = [run(1, h.clocks.wall.nowMs())];
    const online = await h.app.patrols(SHIFT_1);
    expect(online?.fromCache).toBe(false);
    expect(online?.rounds.runs.map((r) => r.routeName)).toEqual(['Night round']);
    h.server.mode = { kind: 'offline' };
    const offline = await h.app.patrols(SHIFT_1);
    expect(offline).toEqual({ rounds: online?.rounds, fromCache: true });
    // The copy belongs to its shift.
    expect(await h.app.patrols(SHIFT_2)).toBeNull();
  });
});
