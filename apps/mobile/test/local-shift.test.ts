import { describe, expect, it } from 'vitest';

import {
  awaitingServerConfirmation,
  canResume,
  failsafeDeadlineMs,
  type LocalShift,
  newLocalShift,
  type ShiftEvent,
  shiftReducer,
  shouldTrack,
} from '../src/core/shift/local-shift.ts';

const T0 = Date.parse('2026-10-08T15:00:00.000Z');
const ENDS = T0 + 8 * 3_600_000;
const MIN = 60_000;

const run = (shift: LocalShift, ...events: ShiftEvent[]) => events.reduce(shiftReducer, shift);
const fresh = () => newLocalShift('shift-1', ENDS, 60);
const started = () =>
  run(fresh(), {
    type: 'START_QUEUED',
    eventId: 'start-1',
    atMs: T0,
    endsAtMs: ENDS,
    autoEndAfterMinutes: 60,
  });

describe('local shift state (PROD §6.3–§6.6)', () => {
  it('ADV-O02 an offline start tracks at once and says “waiting to confirm” until the server accepted it and reports ACTIVE', () => {
    let shift = started();
    expect(shift.phase).toBe('START_PENDING');
    expect(shouldTrack(shift, T0 + 1)).toBe(true);
    expect(awaitingServerConfirmation(shift)).toBe(true);

    // The server has not processed the start yet: it still says SCHEDULED.
    shift = run(shift, { type: 'SERVER_STATUS', status: 'SCHEDULED', endsAtMs: ENDS, nowMs: T0 + MIN });
    expect(awaitingServerConfirmation(shift)).toBe(true);
    // ACCEPTED alone is not enough…
    shift = run(shift, { type: 'START_RESULT', status: 'ACCEPTED', errorCode: null, atMs: T0 + 2 * MIN });
    expect(awaitingServerConfirmation(shift)).toBe(true);
    // …until the server also reports the shift ACTIVE.
    shift = run(shift, { type: 'SERVER_STATUS', status: 'ACTIVE', endsAtMs: ENDS, nowMs: T0 + 2 * MIN });
    expect(shift.phase).toBe('ACTIVE');
    expect(awaitingServerConfirmation(shift)).toBe(false);
  });

  it('INV-16 ACTIVE on the server with the start still unanswered (or quarantined) stays “waiting”', () => {
    let shift = run(started(), { type: 'SERVER_STATUS', status: 'ACTIVE', endsAtMs: ENDS, nowMs: T0 });
    expect(shift.phase).toBe('START_PENDING');
    shift = run(shift, { type: 'START_RESULT', status: 'QUARANTINED', errorCode: null, atMs: T0 });
    expect(shift.phase).toBe('START_PENDING');
    shift = run(shift, { type: 'START_RESULT', status: 'DUPLICATE', errorCode: null, atMs: T0 });
    expect(shift.phase).toBe('ACTIVE');
  });

  it('ADV-O03 a rejected offline start stops tracking and keeps the reason', () => {
    const shift = run(
      started(),
      { type: 'SERVER_STATUS', status: 'MISSED', endsAtMs: ENDS, nowMs: T0 + 3 * 3_600_000 },
      {
        type: 'START_RESULT',
        status: 'REJECTED',
        errorCode: 'SHIFT_OUTSIDE_START_WINDOW',
        atMs: T0 + 3 * 3_600_000,
      },
    );
    expect(shift.phase).toBe('START_REJECTED');
    expect(shift.tracking).toBe(false);
    expect(shift.stopReason).toBe('START_REJECTED');
    expect(shift.startErrorCode).toBe('SHIFT_OUTSIDE_START_WINDOW');
    expect(shouldTrack(shift, T0 + 3 * 3_600_000)).toBe(false);
  });

  it('server state wins: a rejected start on a shift the server reports ACTIVE (supervisor start) keeps tracking', () => {
    const shift = run(
      started(),
      { type: 'SERVER_STATUS', status: 'ACTIVE', endsAtMs: ENDS, nowMs: T0 },
      { type: 'START_RESULT', status: 'REJECTED', errorCode: 'SHIFT_INVALID_TRANSITION', atMs: T0 },
    );
    expect(shift.phase).toBe('ACTIVE');
    expect(shift.tracking).toBe(true);
  });

  it('INV-08 tracking stops the moment End is tapped, before the server confirms', () => {
    const active = run(
      started(),
      { type: 'START_RESULT', status: 'ACCEPTED', errorCode: null, atMs: T0 },
      {
        type: 'SERVER_STATUS',
        status: 'ACTIVE',
        endsAtMs: ENDS,
        nowMs: T0,
      },
    );
    const ended = run(active, { type: 'END_QUEUED', eventId: 'end-1', atMs: T0 + 3_600_000 });
    expect(ended.phase).toBe('ENDED');
    expect(shouldTrack(ended, T0 + 3_600_000)).toBe(false);
    expect(ended.endResult).toBe('PENDING');
    // The server still says ACTIVE (the end is not processed yet): the phone does not resume.
    const still = run(ended, {
      type: 'SERVER_STATUS',
      status: 'ACTIVE',
      endsAtMs: ENDS,
      nowMs: T0 + 3_600_000,
    });
    expect(still.phase).toBe('ENDED');
    expect(still.tracking).toBe(false);
  });

  it('ADV-SH05 with no server contact at all, tracking stops by itself at endsAt + autoEndAfterMinutes', () => {
    const shift = started();
    const deadline = failsafeDeadlineMs(shift);
    expect(deadline).toBe(ENDS + 60 * MIN);
    expect(run(shift, { type: 'CLOCK', nowMs: deadline - 1 }).tracking).toBe(true);
    const stopped = run(shift, { type: 'CLOCK', nowMs: deadline });
    expect(stopped.phase).toBe('AUTO_STOPPED');
    expect(stopped.stopReason).toBe('DEADLINE');
    expect(shouldTrack(stopped, deadline)).toBe(false);
    // shouldTrack itself refuses past the deadline even before a CLOCK event is applied.
    expect(shouldTrack(shift, deadline)).toBe(false);
  });

  it('an extension made while the phone was offline: “Shift extended — tap to resume”, and the gap is recorded', () => {
    const deadline = failsafeDeadlineMs(started());
    let shift = run(started(), { type: 'CLOCK', nowMs: deadline });
    expect(canResume(shift, deadline + MIN)).toBe(false);
    const extendedEnd = ENDS + 4 * 3_600_000;
    shift = run(shift, {
      type: 'SERVER_STATUS',
      status: 'ACTIVE',
      endsAtMs: extendedEnd,
      nowMs: deadline + 10 * MIN,
    });
    expect(shift.extensionAvailable).toBe(true);
    expect(canResume(shift, deadline + 10 * MIN)).toBe(true);
    shift = run(shift, { type: 'RESUME', atMs: deadline + 12 * MIN, autoEndAfterMinutes: 60 });
    expect(shift.phase).toBe('ACTIVE');
    expect(shift.tracking).toBe(true);
    expect(shift.interruptions).toEqual([{ fromMs: deadline, toMs: deadline + 12 * MIN }]);
    expect(failsafeDeadlineMs(shift)).toBe(extendedEnd + 60 * MIN);
  });

  it('server state wins: COMPLETED or CANCELLED on the server stops tracking', () => {
    for (const status of ['COMPLETED', 'CANCELLED'] as const) {
      const shift = run(started(), { type: 'SERVER_STATUS', status, endsAtMs: ENDS, nowMs: T0 + MIN });
      expect(shift.phase).toBe('SERVER_CLOSED');
      expect(shift.tracking).toBe(false);
    }
  });

  it('a supervisor-started shift can be tracked from this phone without a second start', () => {
    let shift = run(fresh(), { type: 'SERVER_STATUS', status: 'ACTIVE', endsAtMs: ENDS, nowMs: T0 });
    expect(shift.phase).toBe('NOT_STARTED');
    expect(canResume(shift, T0)).toBe(true);
    shift = run(shift, { type: 'RESUME', atMs: T0, autoEndAfterMinutes: 60 });
    expect(shift.phase).toBe('ACTIVE');
    expect(shift.startEventId).toBeNull();
  });

  it('signing out halts tracking; signing back in lets the guard resume the same shift', () => {
    let shift = run(started(), { type: 'TRACKING_HALTED', reason: 'SIGNED_OUT', atMs: T0 + MIN });
    expect(shouldTrack(shift, T0 + MIN)).toBe(false);
    expect(canResume(shift, T0 + 2 * MIN)).toBe(true);
    shift = run(shift, { type: 'RESUME', atMs: T0 + 5 * MIN, autoEndAfterMinutes: 60 });
    expect(shift.phase).toBe('START_PENDING');
    expect(shift.tracking).toBe(true);
  });

  it('ignores a second start while one is pending, and allows a new one after a rejection', () => {
    const again = run(started(), {
      type: 'START_QUEUED',
      eventId: 'start-2',
      atMs: T0,
      endsAtMs: ENDS,
      autoEndAfterMinutes: 60,
    });
    expect(again.startEventId).toBe('start-1');
    const rejected = run(started(), {
      type: 'START_RESULT',
      status: 'REJECTED',
      errorCode: 'TRACKING_PERMISSION_REQUIRED',
      atMs: T0,
    });
    const retried = run(rejected, {
      type: 'START_QUEUED',
      eventId: 'start-2',
      atMs: T0 + MIN,
      endsAtMs: ENDS,
      autoEndAfterMinutes: 60,
    });
    expect(retried.phase).toBe('START_PENDING');
    expect(retried.startEventId).toBe('start-2');
  });
});
