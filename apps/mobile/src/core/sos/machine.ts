// The SOS client state machine (PROD §11.3, INV-10/16, ADV-S01/S02). The phone never shows a later SOS
// state than the server has confirmed:
//
//   QUEUED   saved on the phone, not on the server yet    "SOS ACTIVE — waiting for network…"
//   SENDING  a request is in flight                       "Sending SOS…"
//   RECEIVED the server stored it and said so             "SOS received — alerting supervisors…"
//   FAILED   the server refused it permanently            "SOS not accepted — call your supervisor"
//
// RECEIVED comes only from a parsed POST /sos response whose status is RECEIVED. After that the
// server's own answers (GET /sos/:id/status, every 5 s while open) carry ALERT_SENT, NOTIFIED,
// ACKNOWLEDGED and RESOLVED, each with the fact behind it; the phone shows the latest answer and
// nothing it inferred. A later answer can be an earlier state: a second press after an
// acknowledgement makes the SOS unacknowledged again (owner decision 2026-11-02).
import type { SosStatusResponse } from '@sentryops/contracts';

export type SosPhase = 'QUEUED' | 'SENDING' | 'RECEIVED' | 'FAILED';

export type SosState = {
  readonly clientEventId: string;
  readonly phase: SosPhase;
  /** Phone wall clock when the guard triggered it. */
  readonly createdAtMs: number;
  readonly attempts: number;
  readonly sosEventId: string | null;
  readonly receivedAt: string | null;
  readonly errorCode: string | null;
  /** The server's latest answer about this SOS; null until one arrives after RECEIVED. */
  readonly server: SosStatusResponse | null;
  /** The guard pressed "I'm safe / false alarm" (queued or sent; the server's answer says when it arrived). */
  readonly cancelRequested: boolean;
  /** A drill (PROD §11.10), as the server answered. */
  readonly isDrill: boolean;
};

export type SosEvent =
  | { readonly type: 'SEND_STARTED' }
  /** Only from a POST /sos response that matched the contract (status RECEIVED). */
  | {
      readonly type: 'SERVER_CONFIRMED';
      readonly sosEventId: string;
      readonly serverTime: string;
      readonly isDrill?: boolean;
    }
  /** No response, 5xx or 429: still only on the phone. */
  | { readonly type: 'SEND_FAILED' }
  /** A permanent refusal (4xx), with the error code. */
  | { readonly type: 'SEND_REFUSED'; readonly errorCode: string }
  /** GET /sos/:id/status (or the cancel request's reply) for this SOS. */
  | { readonly type: 'SERVER_STATUS'; readonly status: SosStatusResponse }
  | { readonly type: 'CANCEL_REQUESTED' };

/** When the SOS is still only on the phone after this long, offer the call and SMS fallbacks (PROD §11.7). */
export const SOS_CALL_FALLBACK_AFTER_MS = 15_000;
/** PROD §11.3: while open, the phone asks the server every 5 seconds. */
export const SOS_POLL_INTERVAL_MS = 5_000;
/** PROD §11.2: SOS tracking stops after 4 hours without resolution unless the server says otherwise. */
export const SOS_TRACKING_DEFAULT_MS = 4 * 3_600_000;

export function newSos(clientEventId: string, createdAtMs: number): SosState {
  return {
    clientEventId,
    phase: 'QUEUED',
    createdAtMs,
    attempts: 0,
    sosEventId: null,
    receivedAt: null,
    errorCode: null,
    server: null,
    cancelRequested: false,
    isDrill: false,
  };
}

export function sosReducer(state: SosState, event: SosEvent): SosState {
  switch (event.type) {
    case 'SERVER_STATUS':
      // Only answers about this SOS, and only once the server has it (INV-10).
      if (state.phase !== 'RECEIVED' || event.status.sosEventId !== state.sosEventId) return state;
      return { ...state, server: event.status, isDrill: event.status.isDrill };
    case 'CANCEL_REQUESTED':
      return state.phase === 'FAILED' ? state : { ...state, cancelRequested: true };
    default:
      break;
  }
  // A confirmed SOS stays confirmed: no later local event can move it back.
  if (state.phase === 'RECEIVED') return state;
  switch (event.type) {
    case 'SEND_STARTED':
      return state.phase === 'FAILED' ? state : { ...state, phase: 'SENDING', attempts: state.attempts + 1 };
    case 'SERVER_CONFIRMED':
      return {
        ...state,
        phase: 'RECEIVED',
        sosEventId: event.sosEventId,
        receivedAt: event.serverTime,
        errorCode: null,
        isDrill: event.isDrill ?? false,
      };
    case 'SEND_FAILED':
      return state.phase === 'FAILED' ? state : { ...state, phase: 'QUEUED' };
    case 'SEND_REFUSED':
      return { ...state, phase: 'FAILED', errorCode: event.errorCode };
  }
}

/**
 * What the phone may show, in PROD §11.3's order: the transport phase until the server has the SOS,
 * then exactly the server's latest answer.
 */
export type SosDisplay = 'QUEUED' | 'SENDING' | 'FAILED' | SosStatusResponse['phase'];

export function sosDisplay(state: SosState): SosDisplay {
  if (state.phase !== 'RECEIVED') return state.phase;
  return state.server?.phase ?? 'RECEIVED';
}

/** True when the phone should offer "Call supervisor" because the SOS has not reached the server. */
export function showCallFallback(state: SosState, nowMs: number): boolean {
  return (
    (state.phase === 'QUEUED' || state.phase === 'SENDING') &&
    nowMs - state.createdAtMs >= SOS_CALL_FALLBACK_AFTER_MS
  );
}

/** Still open as far as the phone knows: not refused, not resolved by the server. */
export function sosOpen(state: SosState): boolean {
  return state.phase !== 'FAILED' && state.server?.phase !== 'RESOLVED';
}

/**
 * SOS tracking (PROD §11.2): one fix every `tracking.sosIntervalS`, whatever the shift, until the
 * server reports the SOS resolved or its tracking window (4 hours) ends. The window is the server's
 * once it has answered; until then it runs from the press.
 */
export function sosTrackingActive(state: SosState, nowMs: number): boolean {
  if (!sosOpen(state)) return false;
  const until = state.server
    ? Date.parse(state.server.trackingUntil)
    : state.createdAtMs + SOS_TRACKING_DEFAULT_MS;
  return nowMs < until;
}
