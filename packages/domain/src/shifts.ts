// The shift state machine (PROD §6.3, ARCH §7) as a pure function. The server owns shift state:
// every command goes through transition(), and anything not in the PROD §6.3 table is refused with
// SHIFT_INVALID_TRANSITION. Times are server times; phone time never decides (INV-07).

export type ShiftStatus = 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'MISSED' | 'CANCELLED';
export type ShiftActor = 'GUARD' | 'SUPERVISOR' | 'SYSTEM';

export type ShiftCommand =
  /** `capturedAt`: server receipt time online; the server-estimated capture time when synced. */
  | { readonly type: 'GUARD_START'; readonly capturedAt: Date; readonly offline: boolean }
  | { readonly type: 'MANUAL_START'; readonly reason: string }
  | { readonly type: 'CANCEL'; readonly reason: string }
  | { readonly type: 'MARK_MISSED' }
  | { readonly type: 'REOPEN'; readonly reason: string }
  | { readonly type: 'GUARD_END' }
  | { readonly type: 'FORCE_END'; readonly reason: string }
  | { readonly type: 'AUTO_END' }
  | { readonly type: 'EXTEND'; readonly endsAt: Date };

export type ShiftCommandType = ShiftCommand['type'];

export type ShiftFacts = {
  readonly status: ShiftStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly startDeadlineAt: Date;
};

export type ShiftSettings = {
  readonly earliestStartMinutes: number;
  readonly autoEndAfterMinutes: number;
};

export type ShiftEventType =
  | 'STARTED'
  | 'CANCELLED'
  | 'MARKED_MISSED'
  | 'REOPENED'
  | 'ENDED'
  | 'FORCE_ENDED'
  | 'AUTO_ENDED'
  | 'EXTENDED';

export type TransitionResult =
  | {
      readonly ok: true;
      readonly status: ShiftStatus;
      readonly event: ShiftEventType;
      /** Fields of the shift that change with this transition. */
      readonly changes: {
        readonly endsAt?: Date;
        readonly startDeadlineAt?: Date;
        readonly lateSync?: boolean;
      };
    }
  | {
      readonly ok: false;
      readonly code: 'SHIFT_INVALID_TRANSITION' | 'SHIFT_OUTSIDE_START_WINDOW' | 'VALIDATION_FAILED';
    };

const MAX_LENGTH_MS = 24 * 60 * 60 * 1000;
const refuse = { ok: false as const, code: 'SHIFT_INVALID_TRANSITION' as const };

/** Who may issue each command (PROD §6.3, the Actor column). */
export const COMMAND_ACTORS: Readonly<Record<ShiftCommandType, ShiftActor>> = {
  GUARD_START: 'GUARD',
  MANUAL_START: 'SUPERVISOR',
  CANCEL: 'SUPERVISOR',
  MARK_MISSED: 'SYSTEM',
  REOPEN: 'SUPERVISOR',
  GUARD_END: 'GUARD',
  FORCE_END: 'SUPERVISOR',
  AUTO_END: 'SYSTEM',
  EXTEND: 'SUPERVISOR',
};

export function startWindow(shift: ShiftFacts, settings: ShiftSettings): { opens: Date; closes: Date } {
  return {
    opens: new Date(shift.startsAt.getTime() - settings.earliestStartMinutes * 60_000),
    closes: shift.startDeadlineAt,
  };
}

/** The moment the server (and the phone's failsafe) ends an unended shift: end + auto_end_after. */
export function autoEndAt(shift: Pick<ShiftFacts, 'endsAt'>, settings: ShiftSettings): Date {
  return new Date(shift.endsAt.getTime() + settings.autoEndAfterMinutes * 60_000);
}

export function transition(
  shift: ShiftFacts,
  command: ShiftCommand,
  actor: ShiftActor,
  now: Date,
  settings: ShiftSettings,
): TransitionResult {
  if (COMMAND_ACTORS[command.type] !== actor) return refuse;
  const needsReason = 'reason' in command;
  if (needsReason && command.reason.trim().length === 0) return { ok: false, code: 'VALIDATION_FAILED' };

  switch (command.type) {
    case 'GUARD_START': {
      const window = startWindow(shift, settings);
      const inWindow = command.capturedAt >= window.opens && command.capturedAt <= window.closes;
      if (shift.status === 'SCHEDULED') {
        return inWindow
          ? { ok: true, status: 'ACTIVE', event: 'STARTED', changes: {} }
          : { ok: false, code: 'SHIFT_OUTSIDE_START_WINDOW' };
      }
      // Late sync (PROD §6.3, ADV-SH06): a start captured offline inside the window that arrives
      // after the shift was marked MISSED still counts.
      if (shift.status === 'MISSED' && command.offline) {
        return inWindow
          ? { ok: true, status: 'ACTIVE', event: 'STARTED', changes: { lateSync: true } }
          : { ok: false, code: 'SHIFT_OUTSIDE_START_WINDOW' };
      }
      return refuse;
    }
    case 'MANUAL_START':
      return shift.status === 'SCHEDULED'
        ? { ok: true, status: 'ACTIVE', event: 'STARTED', changes: {} }
        : refuse;
    case 'CANCEL':
      return shift.status === 'SCHEDULED'
        ? { ok: true, status: 'CANCELLED', event: 'CANCELLED', changes: {} }
        : refuse;
    case 'MARK_MISSED':
      return shift.status === 'SCHEDULED' && now >= shift.startDeadlineAt
        ? { ok: true, status: 'MISSED', event: 'MARKED_MISSED', changes: {} }
        : refuse;
    case 'REOPEN':
      return shift.status === 'MISSED' && now < shift.endsAt
        ? { ok: true, status: 'SCHEDULED', event: 'REOPENED', changes: { startDeadlineAt: shift.endsAt } }
        : refuse;
    case 'GUARD_END':
      return shift.status === 'ACTIVE'
        ? { ok: true, status: 'COMPLETED', event: 'ENDED', changes: {} }
        : refuse;
    case 'FORCE_END':
      return shift.status === 'ACTIVE'
        ? { ok: true, status: 'COMPLETED', event: 'FORCE_ENDED', changes: {} }
        : refuse;
    case 'AUTO_END':
      return shift.status === 'ACTIVE' && now >= autoEndAt(shift, settings)
        ? { ok: true, status: 'COMPLETED', event: 'AUTO_ENDED', changes: {} }
        : refuse;
    case 'EXTEND': {
      if (shift.status !== 'ACTIVE') return refuse;
      const valid =
        command.endsAt > now &&
        command.endsAt > shift.endsAt &&
        command.endsAt.getTime() - shift.startsAt.getTime() <= MAX_LENGTH_MS;
      return valid
        ? { ok: true, status: 'ACTIVE', event: 'EXTENDED', changes: { endsAt: command.endsAt } }
        : { ok: false, code: 'VALIDATION_FAILED' };
    }
  }
}
