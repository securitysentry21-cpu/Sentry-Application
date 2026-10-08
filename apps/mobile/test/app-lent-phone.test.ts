import type { SyncItem } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import { fixAt, north } from './support/fakes.ts';
import { GUARD_A, GUARD_B, SHIFT_1, SHIFT_2, testShift } from './support/fake-server.ts';
import { makeApp, PHONE, readyGuard, settle } from './support/harness.ts';

describe('a lent phone (ARCH §5.5, D-05)', () => {
  it('ADV-O07 another guard enrolling cannot upload the first guard’s unsent data under the new identity', async () => {
    const h = await makeApp();
    await readyGuard(h, { guardId: GUARD_A });
    const aSession = h.server.sessions[0];

    // Guard A works a shift with no network, ends it, and hands the phone over.
    h.server.mode = { kind: 'offline' };
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    const t = h.clocks.wall.nowMs();
    for (let i = 1; i <= 4; i++) {
      h.clocks.advance(20_000);
      await h.app.onLocations([north(fixAt(t), i * 30, h.clocks.wall.nowMs())]);
    }
    await h.app.endShift(SHIFT_1);
    const aPending = h.app.snapshot().queue.pending;
    expect(aPending).toBeGreaterThan(4);

    // Guard B tries to enroll: the phone first asks for explicit confirmation of the data loss,
    // and nothing is redeemed until then (the code is not used up).
    h.server.mode = { kind: 'online' };
    h.server.pathModes.set('/api/v1/sync/batch', { kind: 'offline' }); // A's data still cannot get out
    h.server.addEnrollment('B-CODE-1234', PHONE, GUARD_B, 'Bilal R.');
    const redeems = () => h.server.requests.filter((r) => r.path === '/api/v1/enrollments/redeem').length;
    const before = redeems();
    const ask = await h.app.enroll({ code: 'B-CODE-1234', phone: PHONE, confirmDataLoss: false });
    expect(ask).toEqual({ kind: 'NEEDS_CONFIRMATION', pending: aPending });
    expect(redeems()).toBe(before);

    const ok = await h.app.enroll({ code: 'B-CODE-1234', phone: PHONE, confirmDataLoss: true });
    h.server.pathModes.delete('/api/v1/sync/batch');
    expect(ok.kind).toBe('OK');
    expect(h.app.snapshot().identity?.guardId).toBe(GUARD_B);
    // A's data is gone from the phone (as confirmed), and the loss is counted, not hidden.
    expect(h.app.snapshot().queue.pending).toBe(0);
    expect(h.app.snapshot().discarded).toMatchObject({ lastReason: 'OTHER_GUARD', count: aPending });

    // B works; everything that reaches the server under B's session is B's.
    h.server.mode = { kind: 'online' };
    h.server.shifts = [testShift(SHIFT_2, h.clocks.realMs() - 5 * 60_000)];
    await h.app.refresh();
    await h.app.acceptDisclosure();
    h.location.nextFix = fixAt(h.clocks.wall.nowMs());
    expect((await h.app.startShift(SHIFT_2)).kind).toBe('OK');
    await settle();
    await h.app.flush({ urgent: true });
    const sent = h.server.batches.flatMap((b) => b.items as SyncItem[]);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((item) => item.shiftId === SHIFT_2 || item.shiftId === null)).toBe(true);
    expect(sent.some((item) => item.shiftId === SHIFT_1)).toBe(false);
    // Every upload that reached the server came through B's own session.
    expect(h.server.batchGuards.length).toBeGreaterThan(0);
    expect(h.server.batchGuards.every((g) => g === GUARD_B)).toBe(true);
    expect(aSession?.guardId).toBe(GUARD_A);
  });

  it('ADV-O07 when the first guard is still signed in and online, their data is sent with their own session first', async () => {
    const h = await makeApp();
    await readyGuard(h, { guardId: GUARD_A });
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    await h.app.endShift(SHIFT_1);
    // Not flushed yet: make the next upload wait for the enrollment flush.
    h.server.addEnrollment('B-CODE-5678', PHONE, GUARD_B, 'Bilal R.');
    const tokenA = h.server.sessions[0]?.accessToken;
    const result = await h.app.enroll({ code: 'B-CODE-5678', phone: PHONE, confirmDataLoss: false });
    expect(result.kind).toBe('OK'); // nothing left to lose: no confirmation needed
    const batchRequests = h.server.requests.filter((r) => r.path === '/api/v1/sync/batch');
    expect(batchRequests.length).toBeGreaterThan(0);
    for (const r of batchRequests) expect(r.headers.Authorization).toBe(`Bearer ${tokenA}`);
    expect(h.app.snapshot().discarded.count).toBe(0);
    expect(h.app.snapshot().identity?.guardId).toBe(GUARD_B);
  });

  it('re-enrolling the same guard keeps their unsent data, which then uploads with the new session', async () => {
    const h = await makeApp();
    await readyGuard(h, { guardId: GUARD_A });
    h.server.mode = { kind: 'offline' };
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await h.app.endShift(SHIFT_1);
    const pending = h.app.snapshot().queue.pending;
    h.server.mode = { kind: 'online' };
    h.server.revokeAll();
    h.clocks.advance(20 * 60_000);
    await h.app.flush({ urgent: true });
    expect(h.app.snapshot().phase).toBe('SIGNED_OUT');
    expect(h.app.snapshot().queue.pending).toBe(pending);

    h.server.addEnrollment('A-AGAIN-123', PHONE, GUARD_A);
    const result = await h.app.enroll({ code: 'A-AGAIN-123', phone: PHONE, confirmDataLoss: true });
    expect(result.kind).toBe('OK');
    await settle();
    await h.app.flush({ urgent: true });
    expect(h.app.snapshot().queue.pending).toBe(0);
    expect(h.app.snapshot().discarded.count).toBe(0);
    const sent = h.server.batches.flatMap((b) => b.items as SyncItem[]);
    expect(sent.map((i) => i.type)).toContain('SHIFT_END');
  });
});
