// The SOS client state machine (PROD §11.3, INV-10, ADV-S01/S02). The phone never shows a later SOS
// state than the server has confirmed:
//
//   QUEUED   saved on the phone, not on the server yet    "SOS ACTIVE — waiting for network…"
//   SENDING  a request is in flight                       "Sending SOS…"
//   RECEIVED the server stored it and said so             "SOS received — alerting supervisors…"
//   FAILED   the server refused it permanently            "SOS not accepted — call your supervisor"
//
// RECEIVED can only come from a parsed POST /sos response whose status is RECEIVED. The later states
// in PROD §11.3 (ALERT_SENT, NOTIFIED, ACKNOWLEDGED, RESOLVED) need GET /sos/:id, which is not in
// the guard-app contract yet, so this build never shows them.

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
};

export type SosEvent =
  | { readonly type: 'SEND_STARTED' }
  /** Only from a POST /sos response that matched the contract (status RECEIVED). */
  | { readonly type: 'SERVER_CONFIRMED'; readonly sosEventId: string; readonly serverTime: string }
  /** No response, 5xx or 429: still only on the phone. */
  | { readonly type: 'SEND_FAILED' }
  /** A permanent refusal (4xx), with the error code. */
  | { readonly type: 'SEND_REFUSED'; readonly errorCode: string };

/** When the SOS is still only on the phone after this long, offer the call fallback (PROD §11.7). */
export const SOS_CALL_FALLBACK_AFTER_MS = 15_000;

export function newSos(clientEventId: string, createdAtMs: number): SosState {
  return {
    clientEventId,
    phase: 'QUEUED',
    createdAtMs,
    attempts: 0,
    sosEventId: null,
    receivedAt: null,
    errorCode: null,
  };
}

export function sosReducer(state: SosState, event: SosEvent): SosState {
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
      };
    case 'SEND_FAILED':
      return state.phase === 'FAILED' ? state : { ...state, phase: 'QUEUED' };
    case 'SEND_REFUSED':
      return { ...state, phase: 'FAILED', errorCode: event.errorCode };
  }
}

/** True when the phone should offer "Call supervisor" because the SOS has not reached the server. */
export function showCallFallback(state: SosState, nowMs: number): boolean {
  return (
    (state.phase === 'QUEUED' || state.phase === 'SENDING') &&
    nowMs - state.createdAtMs >= SOS_CALL_FALLBACK_AFTER_MS
  );
}
