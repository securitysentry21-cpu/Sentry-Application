// The words the guard reads about tracking, sync, shifts, actions and SOS (PROD §1.3, §7.6). Pure
// functions of the engine's state, so the honesty rules are tested: the phone never claims a server
// outcome it has not received (INV-16), and a last fix is shown with its age, never as live (INV-09).
import type { Translate } from './i18n/index.ts';
import { errorMessageKey } from './i18n/index.ts';
import { formatAgo, formatDuration } from './i18n/format.ts';
import type { Receipt } from './outbox/outbox.ts';
import type { LocalShift } from './shift/local-shift.ts';
import type { SosState } from './sos/machine.ts';
import type { SyncDisplay } from './status.ts';
import type { TrackingView } from './app.ts';

export type Tone = 'default' | 'muted' | 'ok' | 'warning' | 'danger' | 'info';
export type Line = { readonly text: string; readonly tone: Tone };

/** Fixes worse than this are labelled "Low accuracy" (PROD §8.3). */
export const LOW_ACCURACY_M = 100;

export function trackingLine(tracking: TrackingView, isTracking: boolean, nowMs: number, t: Translate): Line {
  if (tracking.problem) return { text: t(`problem.${tracking.problem}`), tone: 'danger' };
  if (!isTracking) return { text: t('tracking.off'), tone: 'muted' };
  if (tracking.lastFixAtMs === null) return { text: t('tracking.waitingGps'), tone: 'warning' };
  const ago = formatAgo(nowMs - tracking.lastFixAtMs, t);
  const accuracy = tracking.lastFixAccuracyM;
  if (accuracy === null) return { text: t('tracking.activeNoAccuracy', { ago }), tone: 'warning' };
  if (accuracy > LOW_ACCURACY_M)
    return { text: t('tracking.lowAccuracy', { accuracy: Math.round(accuracy) }), tone: 'warning' };
  return { text: t('tracking.active', { ago, accuracy: Math.round(accuracy) }), tone: 'ok' };
}

export function syncLine(display: SyncDisplay, nowMs: number, t: Translate): Line {
  switch (display.kind) {
    case 'ALL_SENT':
      return { text: t('sync.allSent', { ago: formatAgo(nowMs - display.lastSuccessAtMs, t) }), tone: 'ok' };
    case 'NOTHING_YET':
      return { text: t('sync.nothingYet'), tone: 'muted' };
    case 'SENDING':
      return { text: t('sync.sending'), tone: 'info' };
    case 'WAITING':
      return display.oldestAtMs === null
        ? { text: t('sync.waitingShort', { count: display.pending }), tone: 'warning' }
        : {
            text: t('sync.waiting', {
              count: display.pending,
              age: formatDuration(nowMs - display.oldestAtMs, t),
            }),
            tone: 'warning',
          };
    case 'SIGNED_OUT':
      return { text: t('sync.signedOut', { count: display.pending }), tone: 'danger' };
    case 'UPDATE_REQUIRED':
      return { text: t('sync.updateRequired'), tone: 'danger' };
    case 'DISCARDED':
      return { text: t('sync.discarded', { count: display.count }), tone: 'danger' };
  }
}

export function discardedReasonLine(reason: string | null, t: Translate): string | null {
  switch (reason) {
    case 'EXPIRED':
    case 'THINNED':
    case 'START_REJECTED':
    case 'OTHER_GUARD':
      return t(`sync.discardedReason.${reason}`);
    default:
      return null;
  }
}

/** The shift's state on this phone, worded as PROD §6.5–§6.6 prescribe. */
export function shiftLine(shift: LocalShift | undefined, t: Translate): Line | null {
  if (!shift) return null;
  switch (shift.phase) {
    case 'NOT_STARTED':
      return shift.serverStatus === 'ACTIVE' ? { text: t('shift.startedBySupervisor'), tone: 'info' } : null;
    case 'START_PENDING':
      return shift.tracking
        ? { text: t('shift.pending'), tone: 'warning' }
        : { text: t('shift.signedOutStop'), tone: 'danger' };
    case 'ACTIVE':
      return shift.tracking
        ? { text: t('shift.active'), tone: 'ok' }
        : { text: t('shift.signedOutStop'), tone: 'danger' };
    case 'START_REJECTED':
      return { text: `${t('shift.rejected')} ${t(errorMessageKey(shift.startErrorCode))}`, tone: 'danger' };
    case 'ENDED':
      return shift.endResult === 'ACCEPTED' || shift.endResult === 'DUPLICATE'
        ? { text: t('shift.endReceived'), tone: 'ok' }
        : { text: t('shift.ended'), tone: 'info' };
    case 'AUTO_STOPPED':
      return shift.extensionAvailable
        ? { text: t('shift.extended'), tone: 'warning' }
        : { text: t('shift.autoStopped'), tone: 'warning' };
    case 'SERVER_CLOSED':
      return { text: t('shift.serverClosed'), tone: 'info' };
  }
}

/** "Saved on this phone — will send when online" → "Received by server" → … (PROD §7.6 "Actions"). */
export function receiptLine(receipt: Receipt | null, t: Translate): Line {
  if (!receipt) return { text: t('action.QUEUED'), tone: 'warning' };
  const tone: Tone =
    receipt.status === 'QUEUED'
      ? 'warning'
      : receipt.status === 'ACCEPTED' || receipt.status === 'DUPLICATE'
        ? 'ok'
        : receipt.status === 'QUARANTINED'
          ? 'info'
          : 'danger';
  const base = t(`action.${receipt.status}`);
  return receipt.status === 'REJECTED'
    ? { text: `${base}: ${t(errorMessageKey(receipt.errorCode))}`, tone }
    : { text: base, tone };
}

/** Only the server's answer moves the SOS beyond "waiting for network" (INV-10). */
export function sosLine(sos: SosState, t: Translate): Line {
  switch (sos.phase) {
    case 'QUEUED':
      return { text: t('sos.QUEUED'), tone: 'danger' };
    case 'SENDING':
      return { text: t('sos.SENDING'), tone: 'warning' };
    case 'RECEIVED':
      return { text: t('sos.RECEIVED'), tone: 'ok' };
    case 'FAILED':
      return { text: t('sos.FAILED'), tone: 'danger' };
  }
}
