import { rmSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SyncItem } from '@sentryops/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { SECURE_KEYS } from '../src/core/identity.ts';
import { failsafeDeadlineMs } from '../src/core/shift/local-shift.ts';
import type { ManualClocks } from '../src/core/time.ts';
import { fixAt, north } from './support/fakes.ts';
import { type FakeServer, SHIFT_1, testConfig } from './support/fake-server.ts';
import { makeApp, readyGuard, settle, tempDbPath } from './support/harness.ts';

const MIN = 60_000;
const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0)) rmSync(dirname(p), { recursive: true, force: true, maxRetries: 5 });
});

const types = (items: readonly unknown[]) => items.map((i) => (i as SyncItem).type);
const sentItems = (server: FakeServer) => server.batches.flatMap((b) => b.items as SyncItem[]);

describe('guard app flows (core, end to end against the fake API)', () => {
  it('enrolls with a contract-valid request and keeps tokens only in the secure store', async () => {
    const h = await makeApp();
    await readyGuard(h);
    const snap = h.app.snapshot();
    expect(snap.phase).toBe('READY');
    expect(snap.identity?.guardDisplayName).toBe('Ahmed K.');
    expect(h.kv.values.get(SECURE_KEYS.session)).toContain('access-');
    expect(h.kv.values.get(SECURE_KEYS.deviceKey)).toMatch(/^[0-9a-f]{64}$/);
    // Every request carried the mobile headers; authenticated ones the device ID.
    for (const r of h.server.requests) {
      expect(r.headers['X-App-Version']).toBe('0.1.0');
      expect(r.headers['X-Platform']).toBe('ANDROID');
      expect(r.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
      if (r.path !== '/api/v1/enrollments/redeem' && r.path !== '/api/v1/sessions/refresh') {
        expect(r.headers['X-Device-Id']).toBeTruthy();
        expect(r.headers.Authorization).toMatch(/^Bearer access-/);
      }
    }
    expect(h.server.consents).toHaveLength(1);
    expect(h.server.consents[0]).toEqual({
      disclosureVersion: '1',
      locale: 'en',
      guardId: snap.identity?.guardId,
    });
  });

  it('ADV-O02 a shift started offline shows “waiting to confirm”, then ACTIVE once the server accepted it', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.server.mode = { kind: 'offline' };
    const result = await h.app.startShift(SHIFT_1);
    expect(result.kind).toBe('OK');
    await settle();
    let local = h.app.snapshot().localShifts[SHIFT_1];
    expect(local?.phase).toBe('START_PENDING');
    expect(h.location.running).toBe(true); // tracking starts at once (D-06)
    expect(h.server.shifts[0]?.status).toBe('SCHEDULED'); // the server does not know yet
    await h.app.onLocations([fixAt(h.clocks.wall.nowMs())]);

    h.server.mode = { kind: 'online' };
    await h.app.onNetworkRegained();
    local = h.app.snapshot().localShifts[SHIFT_1];
    expect(local?.phase).toBe('ACTIVE');
    expect(local?.startResult).toBe('ACCEPTED');
    expect(types(sentItems(h.server)).slice(0, 1)).toEqual(['SHIFT_START']);
    // Every item names the run its monoMs came from (ARCH §8.7).
    expect(sentItems(h.server).every((i) => i.bootId === 'run-1')).toBe(true);
  });

  it('ADV-O03 an offline start the server rejects: tracking stops, the reason shows, queued points are dropped', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.server.config = testConfig({ sync: { ...testConfig().sync, maxBatchItems: 1 } });
    await h.app.refresh();
    h.server.mode = { kind: 'offline' };
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    const t = h.clocks.wall.nowMs();
    for (let i = 1; i <= 5; i++) {
      h.clocks.advance(20_000);
      await h.app.onLocations([north(fixAt(t), i * 30, h.clocks.wall.nowMs())]);
    }
    h.server.decide = (item) =>
      item.type === 'SHIFT_START'
        ? { status: 'REJECTED', code: 'SHIFT_OUTSIDE_START_WINDOW' }
        : { status: 'ACCEPTED' };
    h.server.mode = { kind: 'online' };
    await h.app.flush({ urgent: true });
    const snap = h.app.snapshot();
    const local = snap.localShifts[SHIFT_1];
    expect(local?.phase).toBe('START_REJECTED');
    expect(local?.startErrorCode).toBe('SHIFT_OUTSIDE_START_WINDOW');
    expect(h.location.running).toBe(false);
    // Only the start went up; the shift's points were dropped, and the drop is counted (no "All data sent").
    expect(types(sentItems(h.server)).filter((t2) => t2 === 'LOCATION')).toHaveLength(0);
    expect(snap.discarded.lastReason).toBe('START_REJECTED');
    expect(snap.syncDisplay.kind).toBe('DISCARDED');
  });

  it('ADV-O06 an access token that expired while offline is renewed, then everything uploads', async () => {
    const h = await makeApp();
    h.server.accessTtlMs = 5 * MIN;
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    h.server.mode = { kind: 'offline' };
    const t = h.clocks.wall.nowMs();
    for (let i = 1; i <= 10; i++) {
      h.clocks.advance(60_000);
      await h.app.onLocations([north(fixAt(t), i * 40, h.clocks.wall.nowMs())]);
    }
    h.server.mode = { kind: 'online' };
    await h.app.onNetworkRegained();
    expect(h.server.requests.some((r) => r.path === '/api/v1/sessions/refresh')).toBe(true);
    expect(h.app.snapshot().queue.pending).toBe(0);
    expect(types(sentItems(h.server)).filter((x) => x === 'LOCATION').length).toBeGreaterThanOrEqual(10);
    expect(h.app.snapshot().phase).toBe('READY');
  });

  it('ADV-SH05 with no server contact, the phone stops tracking by itself at the deadline and records nothing after', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    h.server.mode = { kind: 'offline' };
    const local = h.app.snapshot().localShifts[SHIFT_1];
    if (!local) throw new Error('no local shift');
    const deadline = failsafeDeadlineMs(local);
    h.clocks.advance(deadline - h.clocks.wall.nowMs() - 30_000);
    await h.app.onLocations([fixAt(h.clocks.wall.nowMs())]);
    expect(h.location.running).toBe(true);
    const queuedBefore = h.app.snapshot().queue.pending;
    h.clocks.advance(60_000); // past the deadline
    await h.app.onLocations([fixAt(h.clocks.wall.nowMs()), fixAt(h.clocks.wall.nowMs() + 1)]);
    const after = h.app.snapshot();
    expect(after.localShifts[SHIFT_1]?.phase).toBe('AUTO_STOPPED');
    expect(h.location.running).toBe(false);
    expect(after.queue.pending).toBe(queuedBefore); // the late readings were not recorded (INV-08)
  });

  it('INV-08 the failsafe still fires when the guard turns the phone clock back during the shift', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    h.server.mode = { kind: 'offline' };
    const local = h.app.snapshot().localShifts[SHIFT_1];
    if (!local) throw new Error('no local shift');
    const deadline = failsafeDeadlineMs(local);
    h.clocks.advance(deadline - h.clocks.realMs() + 60_000);
    h.clocks.setWall(h.clocks.wall.nowMs() - 6 * 3_600_000); // six hours back
    await h.app.tick();
    expect(h.app.snapshot().localShifts[SHIFT_1]?.phase).toBe('AUTO_STOPPED');
    expect(h.location.running).toBe(false);
  });

  it('INV-08 nothing is recorded before a shift starts or after it ends', async () => {
    const h = await makeApp();
    await readyGuard(h);
    await h.app.onLocations([fixAt(h.clocks.wall.nowMs())]);
    expect(h.app.snapshot().queue.pending).toBe(0);
    expect(h.location.running).toBe(false);

    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    await h.app.endShift(SHIFT_1);
    await settle();
    expect(h.location.running).toBe(false);
    const pending = h.app.snapshot().queue.pending;
    h.clocks.advance(30_000);
    await h.app.onLocations([fixAt(h.clocks.wall.nowMs())]);
    expect(h.app.snapshot().queue.pending).toBe(pending);
    const sent = types(sentItems(h.server));
    expect(sent[0]).toBe('SHIFT_START');
    expect(sent.at(-1)).toBe('SHIFT_END');
    expect(h.app.snapshot().localShifts[SHIFT_1]?.endResult).toBe('ACCEPTED');
  });

  it('ADV-O04 the queue survives the app being killed; the next run resumes tracking and uploads both runs', async () => {
    const dbPath = tempDbPath();
    paths.push(dbPath);
    const first = await makeApp({ dbPath });
    await readyGuard(first);
    first.server.mode = { kind: 'offline' };
    expect((await first.app.startShift(SHIFT_1)).kind).toBe('OK');
    const t = first.clocks.wall.nowMs();
    for (let i = 1; i <= 3; i++) {
      first.clocks.advance(20_000);
      await first.app.onLocations([north(fixAt(t), i * 30, first.clocks.wall.nowMs())]);
    }
    const pending = first.app.snapshot().queue.pending;
    expect(pending).toBeGreaterThan(3);
    await first.app.close(); // killed

    first.location.running = false; // the OS killed the service too
    const clocks: ManualClocks = first.clocks.restart('run-2', 2_000);
    clocks.advance(5 * MIN);
    const second = await makeApp({
      dbPath,
      clocks,
      server: first.server,
      kv: first.kv,
      location: first.location,
    });
    expect(second.app.snapshot().phase).toBe('READY');
    expect(second.app.snapshot().queue.pending).toBe(pending);
    expect(second.app.snapshot().localShifts[SHIFT_1]?.phase).toBe('START_PENDING');
    expect(second.location.running).toBe(true); // tracking resumed on launch
    await second.app.onLocations([fixAt(clocks.wall.nowMs())]);

    second.server.mode = { kind: 'online' };
    await second.app.onNetworkRegained();
    expect(second.app.snapshot().queue.pending).toBe(0);
    // Every batch speaks for the run that sends it; each item names the run its monoMs came from,
    // so the server uses the monotonic estimate only for run-2's items (ARCH §8.7).
    expect(second.server.batches.every((b) => b.bootId === 'run-2' && b.sentMonoMs > 0)).toBe(true);
    const itemRuns = new Set(
      second.server.batches.flatMap((b) => (b.items as SyncItem[]).map((i) => i.bootId)),
    );
    expect(itemRuns).toEqual(new Set(['run-1', 'run-2']));
    expect(second.app.snapshot().localShifts[SHIFT_1]?.phase).toBe('ACTIVE');
    await second.app.close();
  });

  it('signed out by the organization: tracking stops, the queue is kept and the guard is told', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    h.server.mode = { kind: 'offline' };
    h.clocks.advance(60_000);
    await h.app.onLocations([north(fixAt(h.clocks.wall.nowMs()), 50, h.clocks.wall.nowMs())]);
    h.server.revokeAll();
    h.server.mode = { kind: 'online' };
    h.clocks.advance(20 * MIN);
    await h.app.flush({ urgent: true });
    const snap = h.app.snapshot();
    expect(snap.phase).toBe('SIGNED_OUT');
    expect(snap.signedOutReason).toBe('REVOKED');
    expect(h.location.running).toBe(false);
    expect(snap.queue.pending).toBeGreaterThan(0);
    expect(snap.syncDisplay).toMatchObject({ kind: 'SIGNED_OUT', pending: snap.queue.pending });
    expect(h.kv.values.has(SECURE_KEYS.session)).toBe(false);
    expect(h.kv.values.has(SECURE_KEYS.deviceKey)).toBe(true); // a signed SOS remains possible
  });

  it('heartbeats every heartbeat interval during a shift, and only then', async () => {
    const h = await makeApp();
    await readyGuard(h);
    h.server.mode = { kind: 'offline' };
    await h.app.tick();
    expect(h.app.snapshot().queue.pending).toBe(0);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    for (let i = 0; i < 10; i++) {
      h.clocks.advance(30_000);
      await h.app.tick();
    }
    h.server.mode = { kind: 'online' };
    await h.app.flush({ urgent: true });
    const heartbeats = types(sentItems(h.server)).filter((t) => t === 'HEARTBEAT');
    expect(heartbeats.length).toBeGreaterThanOrEqual(5);
    expect(heartbeats.length).toBeLessThanOrEqual(6);
  });
});
