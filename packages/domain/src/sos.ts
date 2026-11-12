// SOS rules as pure functions (PROD §11, ARCH §13): the escalation ladder, what the guard's phone
// may be told, drills, and lock-screen-safe notification text. The API applies them.

export type EscalationRole = 'OWNER' | 'ADMIN' | 'SUPERVISOR' | 'DISPATCHER' | 'GUARD';

export type EscalationStep = {
  readonly atSeconds: number;
  readonly dashboardAlarm: boolean;
  readonly webPushTo: readonly EscalationRole[];
  readonly smsTo: readonly EscalationRole[];
  readonly smsEmergencyContacts: boolean;
};

/** `sos.escalation` (PROD §11.4, App. B). Steps are in time order; the first is at 0 s. */
export type EscalationLadder = {
  readonly steps: readonly EscalationStep[];
  readonly repeatEverySeconds: number;
};

/** Seconds after the ladder started at which `level` is due. Levels past the last step repeat. */
export function stepDueAtS(ladder: EscalationLadder, level: number): number {
  const { steps, repeatEverySeconds } = ladder;
  if (level < steps.length) return steps[level]?.atSeconds ?? 0;
  const last = steps[steps.length - 1]?.atSeconds ?? 0;
  return last + (level - steps.length + 1) * repeatEverySeconds;
}

/** When `level` is due, for a ladder that started at `startedAt` (steps never drift with job lag). */
export function stepDueAt(ladder: EscalationLadder, startedAt: Date, level: number): Date {
  return new Date(startedAt.getTime() + stepDueAtS(ladder, level) * 1000);
}

export type StepActions = {
  readonly dashboardAlarm: boolean;
  readonly webPushTo: readonly EscalationRole[];
  readonly smsTo: readonly EscalationRole[];
  readonly smsEmergencyContacts: boolean;
  readonly repeat: boolean;
};

/**
 * What `level` sends. A step sends its own actions. Each repeat after the last step ("every 120 s
 * after: repeat until acknowledged") sends again to everyone the ladder has reached so far: the
 * person who missed the first message is as likely to miss the next as anyone else.
 */
export function stepActions(ladder: EscalationLadder, level: number): StepActions {
  const step = ladder.steps[level];
  if (step) {
    return {
      dashboardAlarm: step.dashboardAlarm,
      webPushTo: step.webPushTo,
      smsTo: step.smsTo,
      smsEmergencyContacts: step.smsEmergencyContacts,
      repeat: false,
    };
  }
  const union = (pick: (s: EscalationStep) => readonly EscalationRole[]) => [
    ...new Set(ladder.steps.flatMap(pick)),
  ];
  return {
    dashboardAlarm: ladder.steps.some((s) => s.dashboardAlarm),
    webPushTo: union((s) => s.webPushTo),
    smsTo: union((s) => s.smsTo),
    smsEmergencyContacts: ladder.steps.some((s) => s.smsEmergencyContacts),
    repeat: true,
  };
}

/** True when a ladder is usable: steps in strictly increasing time, the first at 0 s. */
export function isValidLadder(ladder: EscalationLadder): boolean {
  if (ladder.steps.length === 0 || ladder.steps[0]?.atSeconds !== 0) return false;
  return ladder.steps.every((s, i) => i === 0 || s.atSeconds > (ladder.steps[i - 1]?.atSeconds ?? 0));
}

// ── What the guard's phone is told (PROD §11.3, INV-10) ───────────────────────────────────────

export type SosFacts = {
  readonly status: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
  /** People a provider accepted a push or text for. */
  readonly alertSentTo: number;
  /** Dashboards that reported the alarm on screen (display receipts). */
  readonly shownOnDashboards: number;
  /** People whose devices confirmed delivery (push service worker, SMS delivery report). */
  readonly reachedPhones: number;
};

export type GuardSosPhase = 'RECEIVED' | 'ALERT_SENT' | 'NOTIFIED' | 'ACKNOWLEDGED' | 'RESOLVED';

/**
 * The furthest state the server can prove. NOTIFIED needs a receipt from a screen or a person's
 * device; a provider accepting a message is only ALERT_SENT (INV-10, SEC §20 #33).
 */
export function guardSosPhase(f: SosFacts): GuardSosPhase {
  if (f.status === 'RESOLVED') return 'RESOLVED';
  if (f.status === 'ACKNOWLEDGED') return 'ACKNOWLEDGED';
  if (f.shownOnDashboards > 0 || f.reachedPhones > 0) return 'NOTIFIED';
  if (f.alertSentTo > 0) return 'ALERT_SENT';
  return 'RECEIVED';
}

/** PROD §11.2: SOS tracking stops after this long without resolution; the SOS stays open. */
export function sosTrackingUntil(activatedAt: Date, maxHours: number): Date {
  return new Date(activatedAt.getTime() + maxHours * 3_600_000);
}

// ── Drills (PROD §11.10, ADV-S10) ─────────────────────────────────────────────────────────────

export type OrganizationKind = 'CUSTOMER' | 'DEMO' | 'CANARY';

export type DrillWindow = {
  readonly id: string;
  readonly startedAt: Date;
  readonly endsAt: Date;
  readonly endedAt: Date | null;
  readonly guardIds: readonly string[];
};

export function drillOpenAt(drill: DrillWindow, at: Date): boolean {
  const end = drill.endedAt && drill.endedAt < drill.endsAt ? drill.endedAt : drill.endsAt;
  return drill.startedAt <= at && at < end;
}

/**
 * Whether an SOS is a drill, and which drill. Demo and canary organizations have no real people, so
 * every SOS there is one (PROD §17). In a customer organization only the guards a drill names are in
 * it; anyone else's SOS during the window is real.
 */
export function sosDrillFor(
  kind: OrganizationKind,
  drills: readonly DrillWindow[],
  guardId: string,
  at: Date,
): { isDrill: boolean; drillId: string | null } {
  const drill = drills.find((d) => drillOpenAt(d, at) && d.guardIds.includes(guardId));
  if (drill) return { isDrill: true, drillId: drill.id };
  return { isDrill: kind !== 'CUSTOMER', drillId: null };
}

// ── Notification text (PROD §13) ──────────────────────────────────────────────────────────────

/** "Ahmed Khan" → "Ahmed K.": enough for a lock screen, less for a stranger reading it. */
export function shortName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (parts.length < 2) return first.slice(0, 40);
  const last = parts[parts.length - 1] ?? '';
  return `${first.slice(0, 40)} ${last.charAt(0).toUpperCase()}.`;
}

/** C0 control characters, DEL and C1 control characters, line breaks among them. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Removes control characters and line breaks, so one name can never shape a message. */
export function plainLine(value: string, max: number): string {
  return value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export type SosText = { readonly title: string; readonly body: string };

/** "SOS — Ahmed K. — ABC Warehouse": no coordinates, no incident text (PROD §13). */
export function sosNotificationText(input: {
  readonly guardName: string;
  readonly siteName: string | null;
  readonly drill: boolean;
  readonly again?: boolean;
  /** Owner decision Q1: the guard's account is disabled; the control room confirms who is calling. */
  readonly guardDisabled?: boolean;
}): SosText {
  const prefix = input.drill ? '[DRILL] ' : '';
  const who = plainLine(shortName(input.guardName), 60);
  const where = input.siteName ? plainLine(input.siteName, 80) : 'off shift';
  const title = `${prefix}SOS — ${who} — ${where}`;
  const action = input.again ? 'Pressed again. Not acknowledged yet.' : 'Open the dashboard to acknowledge.';
  const body = input.guardDisabled ? `Guard account disabled: confirm who is calling. ${action}` : action;
  return { title: title.slice(0, 200), body };
}

/**
 * The SOS text message: the same line, a link that needs sign-in, and the position only when the
 * organization turned `sos.sms_include_coordinates` on (PROD §13).
 */
export function sosSmsText(input: {
  readonly text: SosText;
  readonly link: string;
  readonly position: { lat: number; lng: number } | null;
}): string {
  const at = input.position
    ? ` Location ${input.position.lat.toFixed(5)},${input.position.lng.toFixed(5)}.`
    : '';
  return `${input.text.title}.${at} ${input.link}`.slice(0, 480);
}
