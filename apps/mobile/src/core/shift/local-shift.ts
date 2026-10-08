// The phone's own view of one shift (PROD §6.3–§6.6, ARCH §8.8). The server owns shift state; this
// record holds what the phone did and what the server last confirmed, so the screens can be honest
// (INV-16) and tracking runs only while it should (INV-08):
//
//   NOT_STARTED     nothing done on this phone
//   START_PENDING   Start tapped: SHIFT_START queued, tracking on, "Waiting for confirmation"
//                   until the server has ACCEPTED the start AND reports the shift ACTIVE (ADV-O02)
//   ACTIVE          the server confirmed the shift is active; tracking on
//   START_REJECTED  the server refused the start: tracking off, the shift's queued points dropped,
//                   the reason shown (ADV-O03)
//   ENDED           End tapped: tracking stops at once, not when the server confirms (PROD §6.6)
//   AUTO_STOPPED    the local failsafe stopped tracking at endsAt + autoEndAfterMinutes, with no
//                   server contact needed (ADV-SH05): "Shift time over — tap End Shift"
//   SERVER_CLOSED   the server reports the shift is not active (auto-ended, force-ended, cancelled):
//                   server state wins, tracking off
//
// The transitions are a pure function, tested without a phone.
import type { ShiftStatus, SyncItemStatus } from '@sentryops/contracts';

import { MINUTE } from '../time.ts';

export type LocalShiftPhase =
  'NOT_STARTED' | 'START_PENDING' | 'ACTIVE' | 'START_REJECTED' | 'ENDED' | 'AUTO_STOPPED' | 'SERVER_CLOSED';

export type ItemResult = SyncItemStatus | 'PENDING';

export type StopReason =
  'END_TAPPED' | 'DEADLINE' | 'SERVER_NOT_ACTIVE' | 'START_REJECTED' | 'SIGNED_OUT' | 'UPDATE_REQUIRED';

export type Interruption = { readonly fromMs: number; readonly toMs: number };

export type LocalShift = {
  readonly shiftId: string;
  readonly phase: LocalShiftPhase;
  readonly startEventId: string | null;
  readonly startResult: ItemResult | null;
  readonly startErrorCode: string | null;
  readonly endEventId: string | null;
  readonly endResult: ItemResult | null;
  readonly endErrorCode: string | null;
  /** Server-time ms of the scheduled end the failsafe uses (the latest the phone knows). */
  readonly endsAtMs: number;
  readonly autoEndAfterMinutes: number;
  readonly serverStatus: ShiftStatus | null;
  /** When the guard tapped Start / End on this phone (phone clock, for display only). */
  readonly startedAtMs: number | null;
  readonly endedAtMs: number | null;
  /** True while the phone is collecting location for this shift. */
  readonly tracking: boolean;
  readonly stopReason: StopReason | null;
  readonly trackingStoppedAtMs: number | null;
  /** The server extended the shift after the failsafe stopped tracking (PROD §6.6). */
  readonly extensionAvailable: boolean;
  /** Gaps in tracking the phone noticed, newest last (PROD §7.6 "Tracking was interrupted"). */
  readonly interruptions: readonly Interruption[];
};

export type ShiftEvent =
  | {
      readonly type: 'START_QUEUED';
      readonly eventId: string;
      readonly atMs: number;
      readonly endsAtMs: number;
      readonly autoEndAfterMinutes: number;
    }
  | {
      readonly type: 'START_RESULT';
      readonly status: SyncItemStatus;
      readonly errorCode: string | null;
      readonly atMs: number;
    }
  | { readonly type: 'END_QUEUED'; readonly eventId: string; readonly atMs: number }
  | { readonly type: 'END_RESULT'; readonly status: SyncItemStatus; readonly errorCode: string | null }
  | {
      readonly type: 'SERVER_STATUS';
      readonly status: ShiftStatus;
      readonly endsAtMs: number;
      readonly nowMs: number;
    }
  /** Checked on every location callback, heartbeat and screen tick (no exact alarms, EXT-36). */
  | { readonly type: 'CLOCK'; readonly nowMs: number }
  /** The guard taps "Resume tracking" (shift extended, started by a supervisor, or signed back in). */
  | { readonly type: 'RESUME'; readonly atMs: number; readonly autoEndAfterMinutes: number }
  | {
      readonly type: 'TRACKING_HALTED';
      readonly reason: 'SIGNED_OUT' | 'UPDATE_REQUIRED';
      readonly atMs: number;
    }
  | { readonly type: 'INTERRUPTION'; readonly fromMs: number; readonly toMs: number };

const MAX_INTERRUPTIONS = 5;

export function newLocalShift(shiftId: string, endsAtMs: number, autoEndAfterMinutes: number): LocalShift {
  return {
    shiftId,
    phase: 'NOT_STARTED',
    startEventId: null,
    startResult: null,
    startErrorCode: null,
    endEventId: null,
    endResult: null,
    endErrorCode: null,
    endsAtMs,
    autoEndAfterMinutes,
    serverStatus: null,
    startedAtMs: null,
    endedAtMs: null,
    tracking: false,
    stopReason: null,
    trackingStoppedAtMs: null,
    extensionAvailable: false,
    interruptions: [],
  };
}

/** endsAt + shift.autoEndAfterMinutes (PROD §6.6): the moment the phone stops tracking by itself. */
export const failsafeDeadlineMs = (shift: Pick<LocalShift, 'endsAtMs' | 'autoEndAfterMinutes'>): number =>
  shift.endsAtMs + shift.autoEndAfterMinutes * MINUTE;

function stopped(shift: LocalShift, phase: LocalShiftPhase, reason: StopReason, atMs: number): LocalShift {
  return {
    ...shift,
    phase,
    tracking: false,
    stopReason: reason,
    trackingStoppedAtMs: shift.tracking ? atMs : shift.trackingStoppedAtMs,
  };
}

const accepted = (result: ItemResult | null): boolean => result === 'ACCEPTED' || result === 'DUPLICATE';

function addInterruption(list: readonly Interruption[], gap: Interruption): readonly Interruption[] {
  return [...list, gap].slice(-MAX_INTERRUPTIONS);
}

export function shiftReducer(shift: LocalShift, event: ShiftEvent): LocalShift {
  switch (event.type) {
    case 'START_QUEUED': {
      // A start is allowed before any start, or after a refused one (the guard fixed the cause).
      if (shift.phase !== 'NOT_STARTED' && shift.phase !== 'START_REJECTED') return shift;
      return {
        ...shift,
        phase: 'START_PENDING',
        startEventId: event.eventId,
        startResult: 'PENDING',
        startErrorCode: null,
        startedAtMs: event.atMs,
        endsAtMs: Math.max(shift.endsAtMs, event.endsAtMs),
        autoEndAfterMinutes: event.autoEndAfterMinutes,
        tracking: true,
        stopReason: null,
        trackingStoppedAtMs: null,
      };
    }

    case 'START_RESULT': {
      if (shift.startEventId === null) return shift;
      const next: LocalShift = { ...shift, startResult: event.status, startErrorCode: event.errorCode };
      if (event.status === 'REJECTED') {
        // Server state wins: if the server says the shift is active anyway (a supervisor started
        // it), the phone keeps tracking.
        if (shift.serverStatus === 'ACTIVE') {
          return shift.phase === 'START_PENDING' ? { ...next, phase: 'ACTIVE' } : next;
        }
        return shift.phase === 'START_PENDING'
          ? stopped(next, 'START_REJECTED', 'START_REJECTED', event.atMs)
          : next;
      }
      if (shift.phase === 'START_PENDING' && accepted(event.status) && shift.serverStatus === 'ACTIVE') {
        return { ...next, phase: 'ACTIVE' };
      }
      return next; // QUARANTINED, or ACCEPTED before the server reports ACTIVE: still waiting
    }

    case 'END_QUEUED': {
      const endable =
        shift.phase === 'START_PENDING' ||
        shift.phase === 'ACTIVE' ||
        shift.phase === 'AUTO_STOPPED' ||
        shift.phase === 'SERVER_CLOSED';
      if (!endable || shift.endEventId !== null) return shift;
      return {
        ...stopped(shift, 'ENDED', 'END_TAPPED', event.atMs),
        endEventId: event.eventId,
        endResult: 'PENDING',
        endedAtMs: event.atMs,
        extensionAvailable: false,
      };
    }

    case 'END_RESULT':
      return shift.endEventId === null
        ? shift
        : { ...shift, endResult: event.status, endErrorCode: event.errorCode };

    case 'SERVER_STATUS': {
      const base: LocalShift = { ...shift, serverStatus: event.status };
      if (event.status === 'ACTIVE') {
        const later = event.endsAtMs > shift.endsAtMs;
        const withEnd: LocalShift = later ? { ...base, endsAtMs: event.endsAtMs } : base;
        if (shift.phase === 'START_PENDING' && accepted(shift.startResult))
          return { ...withEnd, phase: 'ACTIVE' };
        if (shift.phase === 'AUTO_STOPPED' && later && event.nowMs < failsafeDeadlineMs(withEnd)) {
          return { ...withEnd, extensionAvailable: true };
        }
        return withEnd;
      }
      // Not active on the server. A pending start on a SCHEDULED or MISSED shift is expected: the
      // server has not processed it yet, or a late offline start will still move MISSED → ACTIVE.
      if (shift.phase === 'START_PENDING' && (event.status === 'SCHEDULED' || event.status === 'MISSED')) {
        return base;
      }
      if (shift.phase === 'START_PENDING' || shift.phase === 'ACTIVE') {
        return stopped(base, 'SERVER_CLOSED', 'SERVER_NOT_ACTIVE', event.nowMs);
      }
      if (shift.phase === 'AUTO_STOPPED') return { ...base, extensionAvailable: false };
      return base;
    }

    case 'CLOCK':
      return shift.tracking && event.nowMs >= failsafeDeadlineMs(shift)
        ? stopped(shift, 'AUTO_STOPPED', 'DEADLINE', event.nowMs)
        : shift;

    case 'RESUME': {
      const deadline = failsafeDeadlineMs({
        endsAtMs: shift.endsAtMs,
        autoEndAfterMinutes: event.autoEndAfterMinutes,
      });
      if (event.atMs >= deadline) return shift;
      const startedBySupervisor = shift.phase === 'NOT_STARTED' && shift.serverStatus === 'ACTIVE';
      const extended = shift.phase === 'AUTO_STOPPED' && shift.extensionAvailable;
      const halted = (shift.phase === 'ACTIVE' || shift.phase === 'START_PENDING') && !shift.tracking;
      if (!startedBySupervisor && !extended && !halted) return shift;
      return {
        ...shift,
        phase: halted ? shift.phase : 'ACTIVE',
        tracking: true,
        stopReason: null,
        autoEndAfterMinutes: event.autoEndAfterMinutes,
        extensionAvailable: false,
        startedAtMs: shift.startedAtMs ?? event.atMs,
        interruptions:
          shift.trackingStoppedAtMs === null
            ? shift.interruptions
            : addInterruption(shift.interruptions, { fromMs: shift.trackingStoppedAtMs, toMs: event.atMs }),
        trackingStoppedAtMs: null,
      };
    }

    case 'TRACKING_HALTED':
      return shift.tracking
        ? { ...shift, tracking: false, stopReason: event.reason, trackingStoppedAtMs: event.atMs }
        : shift;

    case 'INTERRUPTION':
      return {
        ...shift,
        interruptions: addInterruption(shift.interruptions, { fromMs: event.fromMs, toMs: event.toMs }),
      };
  }
}

/** Whether the phone should be collecting location for this shift right now (INV-08). */
export function shouldTrack(shift: LocalShift, nowMs: number): boolean {
  return (
    shift.tracking &&
    (shift.phase === 'START_PENDING' || shift.phase === 'ACTIVE') &&
    nowMs < failsafeDeadlineMs(shift)
  );
}

/** "Waiting for confirmation" is shown until both server confirmations are in (INV-16, ADV-O02). */
export const awaitingServerConfirmation = (shift: LocalShift): boolean => shift.phase === 'START_PENDING';

/** The guard can tap "Resume tracking" now. */
export function canResume(shift: LocalShift, nowMs: number): boolean {
  if (nowMs >= failsafeDeadlineMs(shift)) return false;
  if (shift.phase === 'NOT_STARTED') return shift.serverStatus === 'ACTIVE';
  if (shift.phase === 'AUTO_STOPPED') return shift.extensionAvailable;
  return (shift.phase === 'ACTIVE' || shift.phase === 'START_PENDING') && !shift.tracking;
}
