// SOS in words (PROD §11): its status, the honest progress the server can prove (PROD §11.3,
// INV-10), resolutions, deliveries, and the rules the SOS settings and SOS text numbers follow. The
// limits are the contracts' (packages/contracts/src/sos.ts, settings.ts, api.ts): the server
// enforces them; the forms only say so early, and zod stays out of the browser bundle.
import type { Role, SosDetail, SosResolution } from '@sentryops/contracts';

export const SOS_STATUS_LABEL: Record<SosDetail['status'], string> = {
  ACTIVE: 'Active — not acknowledged',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
};

export const SOS_STATUS_BADGE: Record<SosDetail['status'], string> = {
  ACTIVE: 'danger',
  ACKNOWLEDGED: 'warn',
  RESOLVED: 'ok',
};

export const RESOLUTIONS: readonly SosResolution[] = [
  'GENUINE',
  'FALSE_ALARM',
  'ACCIDENTAL',
  'DRILL',
  'OTHER',
];

export const RESOLUTION_LABEL: Record<SosResolution, string> = {
  GENUINE: 'Genuine emergency',
  FALSE_ALARM: 'False alarm',
  ACCIDENTAL: 'Pressed by accident',
  DRILL: 'Drill',
  OTHER: 'Other',
};

export const RESOLUTION_NOTE_MAX = 1000;

type Delivery = SosDetail['deliveries'][number];

export const CHANNEL_LABEL: Record<Delivery['channel'], string> = {
  WEB_PUSH: 'Dashboard push',
  PUSH: 'App push',
  SMS: 'Text message',
};

/** "Sent" never means "seen" (PROD §13): only DELIVERED is a confirmation from the device. */
export const DELIVERY_STATUS_LABEL: Record<Delivery['status'], string> = {
  QUEUED: 'Queued',
  SENT: 'Sent, not confirmed',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  SUPPRESSED: 'Not sent (throttled)',
};

export const DELIVERY_STATUS_BADGE: Record<Delivery['status'], string> = {
  QUEUED: 'plain',
  SENT: 'info',
  DELIVERED: 'ok',
  FAILED: 'danger',
  SUPPRESSED: 'plain',
};

/** The ladder's first step is level 0 (PROD §11.4). */
export function stepText(level: number): string {
  return `Step ${level + 1}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function receiptsText(r: SosDetail['receipts']): string {
  return `shown on ${plural(r.shownOnDashboards, 'dashboard')}, reached ${plural(r.reachedPhones, 'phone')}`;
}

export type ProgressStep = {
  readonly label: string;
  readonly at: string | null;
  readonly detail: string | null;
};

/**
 * What the server can prove about an SOS, in order (PROD §11.3): each step shows only once the
 * server has the fact that makes it true. "Alert sent" means a provider accepted a push or text;
 * "notified" needs a dashboard showing the alarm or a phone confirming the push (INV-10).
 */
export function sosProgress(s: SosDetail): ProgressStep[] {
  return [
    { label: 'Received by the server', at: s.receivedAt, detail: null },
    { label: 'Alert sent', at: s.alertSentAt, detail: 'a push or text was handed to a provider' },
    { label: 'Notified', at: s.notifiedAt, detail: receiptsText(s.receipts) },
    {
      label: 'Acknowledged',
      at: s.acknowledgedAt,
      detail: s.acknowledgedBy ? `by ${s.acknowledgedBy.name}` : null,
    },
    { label: 'Resolved', at: s.resolvedAt, detail: s.resolvedBy ? `by ${s.resolvedBy.name}` : null },
  ];
}

/** Gaps longer than this are drawn as breaks, never as lines that imply travel (PROD §14.5). */
export const TRAIL_GAP_S = 300;

type TrailPoint = { readonly lat: number; readonly lng: number; readonly capturedAt: string };

/** The SOS trail as map segments, oldest first, broken at every gap over 5 minutes. */
export function trailSegments(points: readonly TrailPoint[]): { lat: number; lng: number }[][] {
  const segments: { lat: number; lng: number }[][] = [];
  let previous: number | null = null;
  for (const p of points) {
    const at = Date.parse(p.capturedAt);
    if (previous === null || at - previous > TRAIL_GAP_S * 1000) segments.push([]);
    segments.at(-1)?.push({ lat: p.lat, lng: p.lng });
    previous = at;
  }
  return segments;
}

/** A tel: link for a phone number: digits and a leading + only, or null when it isn't one. */
export function telHref(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '');
  return /^\+?\d{4,15}$/.test(digits) ? `tel:${digits}` : null;
}

// ── Phone numbers (E.164) ────────────────────────────────────────────────────────────────────

/** The server's one rule for phone numbers (settings.ts phoneNumberSchema): 8–15 digits. */
export const SETTING_PHONE = /^\+[1-9]\d{7,14}$/;
/** A member's SOS text number: the same rule (api.ts memberAlertPhoneRequestSchema). */
export const MEMBER_PHONE = SETTING_PHONE;

/** What people type around a number is dropped: "+92 300 123-4567" → "+923001234567". */
export function normalizePhone(input: string): string {
  return input.trim().replace(/[\s\-().]/g, '');
}

// ── The SOS settings (PROD §11.4, Appendix B) ────────────────────────────────────────────────

export type LadderStep = {
  atSeconds: number;
  dashboardAlarm: boolean;
  webPushTo: Role[];
  smsTo: Role[];
  smsEmergencyContacts: boolean;
};
export type Ladder = { steps: LadderStep[]; repeatEverySeconds: number };

export const LADDER = { maxSteps: 10, maxAtSeconds: 3600, minRepeatS: 30, maxRepeatS: 3600 } as const;
export const MAX_EMERGENCY_CONTACTS = 10;
/** The people an SOS step can reach, by role. Guards are never in the ladder. */
export const LADDER_ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'SUPERVISOR', 'DISPATCHER'];

const whole = (n: number) => Number.isInteger(n);

/** Why the server would refuse this ladder (settings.ts), in words; empty when it is fine. */
export function ladderProblems(ladder: Ladder): string[] {
  const problems: string[] = [];
  const { steps, repeatEverySeconds } = ladder;
  if (steps.length < 1 || steps.length > LADDER.maxSteps)
    problems.push(`The ladder needs 1 to ${LADDER.maxSteps} steps.`);
  if (steps[0] && steps[0].atSeconds !== 0) problems.push('The first step happens at once (0 seconds).');
  steps.forEach((step, i) => {
    if (!whole(step.atSeconds) || step.atSeconds < 0 || step.atSeconds > LADDER.maxAtSeconds) {
      problems.push(
        `Step ${i + 1}: the time must be a whole number of seconds from 0 to ${LADDER.maxAtSeconds}.`,
      );
    } else if (i > 0 && step.atSeconds <= (steps[i - 1]?.atSeconds ?? 0)) {
      problems.push(`Step ${i + 1} must come later than step ${i}.`);
    }
  });
  if (
    !whole(repeatEverySeconds) ||
    repeatEverySeconds < LADDER.minRepeatS ||
    repeatEverySeconds > LADDER.maxRepeatS
  ) {
    problems.push(`Repeat every ${LADDER.minRepeatS} to ${LADDER.maxRepeatS} seconds.`);
  }
  return problems;
}

/** Why the server would refuse these emergency contacts; empty when they are fine. */
export function contactsProblems(contacts: readonly string[]): string[] {
  const problems: string[] = [];
  if (contacts.length > MAX_EMERGENCY_CONTACTS)
    problems.push(`At most ${MAX_EMERGENCY_CONTACTS} emergency contacts.`);
  contacts.forEach((c, i) => {
    if (!SETTING_PHONE.test(c))
      problems.push(`Emergency contact ${i + 1} is not a full international number (like +923001234567).`);
  });
  return problems;
}

/** "at once", "after 1 min", "after 2 min 30 s". */
export function afterText(seconds: number): string {
  if (seconds === 0) return 'at once';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `after ${m > 0 ? `${m} min` : ''}${m > 0 && s > 0 ? ' ' : ''}${s > 0 ? `${s} s` : ''}`;
}
