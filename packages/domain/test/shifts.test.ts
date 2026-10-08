import { describe, expect, it } from 'vitest';

import {
  autoEndAt,
  COMMAND_ACTORS,
  transition,
  type ShiftActor,
  type ShiftCommand,
  type ShiftFacts,
  type ShiftStatus,
} from '../src/shifts.ts';
import { addDays, localDate, localToUtc, weekday, zoneOffsetMinutes } from '../src/time.ts';

const SETTINGS = { earliestStartMinutes: 30, autoEndAfterMinutes: 60 };
const H = 3_600_000;
const START = new Date('2026-10-20T15:00:00Z'); // 20:00 in Karachi
const shift = (status: ShiftStatus): ShiftFacts => ({
  status,
  startsAt: START,
  endsAt: new Date(START.getTime() + 12 * H),
  startDeadlineAt: new Date(START.getTime() + 2 * H),
});

const COMMANDS: ShiftCommand[] = [
  { type: 'GUARD_START', capturedAt: new Date(START.getTime() + 10 * 60_000), offline: false },
  { type: 'GUARD_START', capturedAt: new Date(START.getTime() + 10 * 60_000), offline: true },
  { type: 'MANUAL_START', reason: 'phone broken' },
  { type: 'CANCEL', reason: 'client closed the site' },
  { type: 'MARK_MISSED' },
  { type: 'REOPEN', reason: 'guard arrived' },
  { type: 'GUARD_END' },
  { type: 'FORCE_END', reason: 'relief arrived' },
  { type: 'AUTO_END' },
  { type: 'EXTEND', endsAt: new Date(START.getTime() + 14 * H) },
];

/** The PROD §6.3 table, as (from, command, actor) → to. Everything else must be refused. */
const ALLOWED: Record<string, ShiftStatus> = {
  'SCHEDULED GUARD_START GUARD online': 'ACTIVE',
  'SCHEDULED GUARD_START GUARD offline': 'ACTIVE',
  'MISSED GUARD_START GUARD offline': 'ACTIVE',
  'SCHEDULED MANUAL_START SUPERVISOR': 'ACTIVE',
  'SCHEDULED CANCEL SUPERVISOR': 'CANCELLED',
  'SCHEDULED MARK_MISSED SYSTEM': 'MISSED',
  'MISSED REOPEN SUPERVISOR': 'SCHEDULED',
  'ACTIVE GUARD_END GUARD': 'COMPLETED',
  'ACTIVE FORCE_END SUPERVISOR': 'COMPLETED',
  'ACTIVE AUTO_END SYSTEM': 'COMPLETED',
  'ACTIVE EXTEND SUPERVISOR': 'ACTIVE',
};

/** A "now" at which each time-dependent command is due, so the table is about states and actors. */
function nowFor(command: ShiftCommand): Date {
  if (command.type === 'MARK_MISSED') return new Date(START.getTime() + 3 * H);
  if (command.type === 'AUTO_END') return new Date(START.getTime() + 14 * H);
  return new Date(START.getTime() + 1 * H);
}

describe('shift state machine (PROD §6.3)', () => {
  it('ADV-SH01 every state × command × actor: only the PROD §6.3 transitions succeed', () => {
    const states: ShiftStatus[] = ['SCHEDULED', 'ACTIVE', 'COMPLETED', 'MISSED', 'CANCELLED'];
    const actors: ShiftActor[] = ['GUARD', 'SUPERVISOR', 'SYSTEM'];
    let checked = 0;
    for (const state of states) {
      for (const command of COMMANDS) {
        for (const actor of actors) {
          const suffix = command.type === 'GUARD_START' ? ` ${command.offline ? 'offline' : 'online'}` : '';
          const key = `${state} ${command.type} ${actor}${suffix}`;
          const result = transition(shift(state), command, actor, nowFor(command), SETTINGS);
          const expected = ALLOWED[key];
          if (expected) expect(result, key).toMatchObject({ ok: true, status: expected });
          else expect(result.ok, key).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBe(5 * COMMANDS.length * 3);
    // Every command has exactly one actor.
    expect(Object.keys(COMMAND_ACTORS)).toHaveLength(9);
  });

  it('a guard start outside the start window is refused, with the window in server time', () => {
    const early = {
      type: 'GUARD_START' as const,
      capturedAt: new Date(START.getTime() - 31 * 60_000),
      offline: false,
    };
    expect(transition(shift('SCHEDULED'), early, 'GUARD', early.capturedAt, SETTINGS)).toEqual({
      ok: false,
      code: 'SHIFT_OUTSIDE_START_WINDOW',
    });
    const late = {
      type: 'GUARD_START' as const,
      capturedAt: new Date(START.getTime() + 2 * H + 1000),
      offline: false,
    };
    expect(transition(shift('SCHEDULED'), late, 'GUARD', late.capturedAt, SETTINGS)).toEqual({
      ok: false,
      code: 'SHIFT_OUTSIDE_START_WINDOW',
    });
  });

  it('ADV-SH06 an offline start captured in the window that arrives after MISSED makes the shift ACTIVE (late sync)', () => {
    const synced = {
      type: 'GUARD_START' as const,
      capturedAt: new Date(START.getTime() + 90 * 60_000),
      offline: true,
    };
    const result = transition(shift('MISSED'), synced, 'GUARD', new Date(START.getTime() + 4 * H), SETTINGS);
    expect(result).toEqual({ ok: true, status: 'ACTIVE', event: 'STARTED', changes: { lateSync: true } });
    // An online start can't revive a MISSED shift; neither can an offline one captured too late.
    expect(
      transition(shift('MISSED'), { ...synced, offline: false }, 'GUARD', synced.capturedAt, SETTINGS).ok,
    ).toBe(false);
    const tooLate = { ...synced, capturedAt: new Date(START.getTime() + 3 * H) };
    expect(transition(shift('MISSED'), tooLate, 'GUARD', tooLate.capturedAt, SETTINGS)).toEqual({
      ok: false,
      code: 'SHIFT_OUTSIDE_START_WINDOW',
    });
  });

  it('ADV-SH04 the system ends an unended shift exactly at end + auto_end_after, not before', () => {
    const at = autoEndAt(shift('ACTIVE'), SETTINGS);
    expect(at.toISOString()).toBe('2026-10-21T04:00:00.000Z');
    expect(
      transition(shift('ACTIVE'), { type: 'AUTO_END' }, 'SYSTEM', new Date(at.getTime() - 1), SETTINGS).ok,
    ).toBe(false);
    expect(transition(shift('ACTIVE'), { type: 'AUTO_END' }, 'SYSTEM', at, SETTINGS)).toMatchObject({
      ok: true,
      event: 'AUTO_ENDED',
    });
  });

  it('extend: later than now and the current end, at most 24 hours in total; reopen resets the deadline', () => {
    const now = new Date(START.getTime() + 11 * H);
    expect(
      transition(
        shift('ACTIVE'),
        { type: 'EXTEND', endsAt: new Date(START.getTime() + 25 * H) },
        'SUPERVISOR',
        now,
        SETTINGS,
      ).ok,
    ).toBe(false);
    expect(
      transition(
        shift('ACTIVE'),
        { type: 'EXTEND', endsAt: new Date(START.getTime() + 10 * H) },
        'SUPERVISOR',
        now,
        SETTINGS,
      ).ok,
    ).toBe(false);
    const reopened = transition(
      shift('MISSED'),
      { type: 'REOPEN', reason: 'arrived late' },
      'SUPERVISOR',
      new Date(START.getTime() + 3 * H),
      SETTINGS,
    );
    expect(reopened).toMatchObject({ ok: true, changes: { startDeadlineAt: shift('MISSED').endsAt } });
    expect(
      transition(
        shift('MISSED'),
        { type: 'REOPEN', reason: 'x' },
        'SUPERVISOR',
        new Date(START.getTime() + 13 * H),
        SETTINGS,
      ).ok,
    ).toBe(false);
    expect(
      transition(shift('SCHEDULED'), { type: 'CANCEL', reason: '  ' }, 'SUPERVISOR', now, SETTINGS),
    ).toEqual({ ok: false, code: 'VALIDATION_FAILED' });
  });
});

describe('site time (PROD §6.1)', () => {
  it('ADV-TM01 an overnight shift in Karachi and a DST-observing zone resolves to the right instants', () => {
    // Karachi has no DST: 20:00 → 15:00Z; the 08:00 end falls on the next local day.
    expect(localToUtc('2026-10-20', '20:00', 'Asia/Karachi').toISOString()).toBe('2026-10-20T15:00:00.000Z');
    expect(localToUtc(addDays('2026-10-20', 1), '08:00', 'Asia/Karachi').toISOString()).toBe(
      '2026-10-21T03:00:00.000Z',
    );
    // London leaves summer time on 25 Oct 2026 at 02:00 BST: an overnight shift spans the change.
    const start = localToUtc('2026-10-24', '22:00', 'Europe/London'); // BST, UTC+1
    const end = localToUtc('2026-10-25', '06:00', 'Europe/London'); // GMT, UTC+0
    expect(start.toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-25T06:00:00.000Z');
    expect((end.getTime() - start.getTime()) / H).toBe(9); // the extra hour is real working time
    // A time skipped by the spring change resolves forward, never to an invalid instant.
    const skipped = localToUtc('2026-03-29', '01:30', 'Europe/London');
    expect(zoneOffsetMinutes(skipped, 'Europe/London')).toBe(60);
  });

  it('local dates and weekdays follow the zone, not UTC', () => {
    // 23:30Z on the 20th is already the 21st in Karachi.
    expect(localDate(new Date('2026-10-20T23:30:00Z'), 'Asia/Karachi')).toBe('2026-10-21');
    expect(weekday('2026-10-20')).toBe(2); // Tuesday
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
