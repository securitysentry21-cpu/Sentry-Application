// SOS on the phone after the server has it (PROD §11.2–§11.8, INV-10/16): the later states only from
// the server's answers, "I'm safe", SOS tracking whatever the shift, and an SOS that survives a
// restart. Driven through the GuardApp with a fake server, the way the screens drive it.
import { describe, expect, it } from 'vitest';

import { sosDisplay, sosTrackingActive } from '../src/core/sos/machine.ts';
import { fixAt, north } from './support/fakes.ts';
import { SHIFT_1 } from './support/fake-server.ts';
import { makeApp, readyGuard, settle, tempDbPath } from './support/harness.ts';

describe('SOS states after RECEIVED (PROD §11.3)', () => {
  it('ADV-S01 the phone shows ALERT_SENT, NOTIFIED, ACKNOWLEDGED and RESOLVED only as the server reports them', async () => {
    const h = await makeApp();
    await readyGuard(h);
    const id = await h.app.triggerSos();
    await settle();
    const sosEventId = h.server.sos.get(id)?.sosEventId ?? '';
    const shown = () => {
      const sos = h.app.snapshot().sos;
      return sos ? sosDisplay(sos) : null;
    };
    await h.app.refreshSos();
    expect(shown()).toBe('RECEIVED');

    // A provider accepted the messages: "Alert sent", never "notified".
    h.server.sosStatus.set(sosEventId, { phase: 'ALERT_SENT', alertSentTo: 4 });
    await h.app.refreshSos();
    expect(shown()).toBe('ALERT_SENT');
    expect(h.app.snapshot().sos?.server?.alertSentTo).toBe(4);

    h.server.sosStatus.set(sosEventId, { phase: 'NOTIFIED', alertSentTo: 4, shownInControlRoom: true });
    await h.app.refreshSos();
    expect(shown()).toBe('NOTIFIED');

    h.server.sosStatus.set(sosEventId, {
      phase: 'ACKNOWLEDGED',
      acknowledgedBy: 'Sarah K.',
      acknowledgedAt: new Date(h.clocks.realMs()).toISOString(),
    });
    await h.app.refreshSos();
    expect(shown()).toBe('ACKNOWLEDGED');
    expect(h.app.snapshot().sos?.server?.acknowledgedBy).toBe('Sarah K.');

    // Offline, nothing new is invented: the last answer stays.
    h.server.mode = { kind: 'offline' };
    await h.app.refreshSos();
    expect(shown()).toBe('ACKNOWLEDGED');
    h.server.mode = { kind: 'online' };

    h.server.sosStatus.set(sosEventId, {
      phase: 'RESOLVED',
      resolvedAt: new Date(h.clocks.realMs()).toISOString(),
    });
    await h.app.refreshSos();
    expect(shown()).toBe('RESOLVED');
    // Resolved: SOS tracking stops (it was off shift, so nothing tracks now).
    await settle();
    expect(h.location.running).toBe(false);
  });

  it('pressed again after an acknowledgement, the phone follows the server back to unacknowledged', async () => {
    const h = await makeApp();
    await readyGuard(h);
    const id = await h.app.triggerSos();
    await settle();
    const sosEventId = h.server.sos.get(id)?.sosEventId ?? '';
    h.server.sosStatus.set(sosEventId, {
      phase: 'ACKNOWLEDGED',
      acknowledgedBy: 'Sarah K.',
      acknowledgedAt: new Date(h.clocks.realMs()).toISOString(),
    });
    await h.app.refreshSos();
    h.server.sosStatus.set(sosEventId, { phase: 'NOTIFIED', shownInControlRoom: true });
    await h.app.triggerSos();
    await settle();
    await h.app.refreshSos();
    expect(h.server.sos.size).toBe(2); // two presses, the server folds them into one SOS
    const sos = h.app.snapshot().sos;
    expect(sos && sosDisplay(sos)).toBe('NOTIFIED');
  });
});

describe('"I\'m safe / false alarm" (PROD §11.8)', () => {
  it('ADV-S07 offline it waits on the phone; the SOS stays open and tracked; the server is told once online', async () => {
    const h = await makeApp();
    await readyGuard(h);
    const id = await h.app.triggerSos();
    await settle();
    h.server.mode = { kind: 'offline' };
    expect(await h.app.requestSosCancel()).toBe(true);
    expect(await h.app.requestSosCancel()).toBe(false); // once
    expect(h.app.snapshot().sos).toMatchObject({ cancelRequested: true, server: null });
    expect(h.server.sosCancels).toHaveLength(0);
    h.server.mode = { kind: 'online' };
    await h.app.flush({ urgent: true });
    expect(h.server.sosCancels.map((c) => c.sosEventId)).toEqual([h.server.sos.get(id)?.sosEventId]);
    const sos = h.app.snapshot().sos;
    expect(sos?.server?.cancelRequestedAt).not.toBeNull();
    // Still open: "I'm safe" never resolves an SOS.
    expect(sos && sosDisplay(sos)).not.toBe('RESOLVED');
    expect(sos && sosTrackingActive(sos, h.clocks.realMs())).toBe(true);
  });
});

describe('SOS tracking (PROD §11.2)', () => {
  it('off shift, a point every 10 s goes up on the SOS lane until the server reports the SOS resolved', async () => {
    const h = await makeApp();
    await readyGuard(h);
    const id = await h.app.triggerSos();
    await settle();
    await h.app.flush({ urgent: true });
    const sosEventId = h.server.sos.get(id)?.sosEventId ?? '';
    const before = h.server.sosPoints.length;
    // Readings every 5 s for a minute: one point per 10 s is kept.
    for (let i = 0; i < 12; i++) {
      h.clocks.advance(5_000);
      const at = h.clocks.wall.nowMs();
      await h.app.onLocations([north(fixAt(at), i * 3, at)]);
    }
    await h.app.flush({ urgent: true });
    const added = h.server.sosPoints.slice(before);
    expect(added.every((p) => p.sosEventId === sosEventId)).toBe(true);
    expect(added.length).toBeGreaterThanOrEqual(5);
    expect(added.length).toBeLessThanOrEqual(7);
    // Nothing went to the main lane as a shift location (there is no shift).
    expect(
      h.server.batches.flatMap((b) => b.items as { type: string }[]).some((i) => i.type === 'LOCATION'),
    ).toBe(false);

    h.server.sosStatus.set(sosEventId, {
      phase: 'RESOLVED',
      resolvedAt: new Date(h.clocks.realMs()).toISOString(),
    });
    await h.app.refreshSos();
    await settle();
    expect(h.location.running).toBe(false);
  });

  it('during a shift, SOS tracking replaces the shift interval and the shift tracking comes back after', async () => {
    const h = await makeApp();
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await settle();
    const shiftInterval = h.location.starts.at(-1)?.timeIntervalMs;
    const id = await h.app.triggerSos();
    await settle();
    expect(h.location.starts.at(-1)?.timeIntervalMs).toBe(10_000);
    const sosEventId = h.server.sos.get(id)?.sosEventId ?? '';
    h.server.sosStatus.set(sosEventId, {
      phase: 'RESOLVED',
      resolvedAt: new Date(h.clocks.realMs()).toISOString(),
    });
    await h.app.refreshSos();
    await settle();
    expect(h.location.running).toBe(true);
    expect(h.location.starts.at(-1)?.timeIntervalMs).toBe(shiftInterval);
  });

  it('a received SOS survives the app being killed: it comes back, is asked about, and is tracked again', async () => {
    const dbPath = tempDbPath();
    const first = await makeApp({ dbPath });
    await readyGuard(first);
    const id = await first.app.triggerSos();
    await settle();
    await first.app.close();

    const second = await makeApp({ dbPath, kv: first.kv, server: first.server, clocks: first.clocks });
    await settle();
    const sos = second.app.snapshot().sos;
    expect(sos).toMatchObject({
      clientEventId: id,
      phase: 'RECEIVED',
      sosEventId: first.server.sos.get(id)?.sosEventId,
    });
    expect(second.location.running).toBe(true);
  });
});
