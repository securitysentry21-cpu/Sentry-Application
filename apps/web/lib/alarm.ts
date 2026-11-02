// The dashboard alarm's rules (PROD §11.4, §11.6, §11.10), pure so they can be tested without a
// browser. Every open CRITICAL alert, an SOS or a critical incident, alarms every connected
// dashboard, except a drill: that alarms only the members taking part, and everyone else sees it in
// the alert lists marked DRILL, with no alarm (owner decision 2026-11-02, ADV-S10). A dashboard may
// report "the alarm is on screen" (the display receipt that makes an SOS NOTIFIED, INV-10) only
// while the alarm really is on a visible screen, once per alert.
import type { Alert, SosDrill } from '@sentryops/contracts';
import { plainLine, shortName, sosNotificationText } from '@sentryops/domain';

/** Open and CRITICAL: an SOS or a critical incident (PROD §12.1, §12.5). Acknowledging stops it. */
export function isAlarming(alert: Alert): boolean {
  return alert.status === 'OPEN' && alert.severity === 'CRITICAL';
}

/** What the alarm needs to know about a drill (GET /sos-drills/:id). */
export type DrillParticipants = Pick<
  SosDrill,
  'id' | 'startedAt' | 'endsAt' | 'endedAt' | 'guards' | 'members'
>;

/** The drill an alert names, if this dashboard has fetched it. */
export function drillOf(alert: Alert, drills: readonly DrillParticipants[]): DrillParticipants | null {
  return alert.drillId ? (drills.find((d) => d.id === alert.drillId) ?? null) : null;
}

export type AlarmDecision =
  /** Full screen, sound, flashing title. */
  | 'ALARM'
  /** A drill this member is not taking part in: listed, marked DRILL, no alarm. */
  | 'NOT_IN_DRILL'
  /** A drill whose participants this dashboard doesn't know: no alarm until it does. */
  | 'DRILL_UNKNOWN'
  | 'NONE';

export function alarmDecision(
  alert: Alert,
  memberId: string,
  drills: readonly DrillParticipants[],
): AlarmDecision {
  if (!isAlarming(alert)) return 'NONE';
  if (!alert.isDrill) return 'ALARM';
  // No drill window: a demo or canary organization, where every SOS is a drill for every member.
  if (alert.drillId === null) return 'ALARM';
  const drill = drillOf(alert, drills);
  if (!drill) return 'DRILL_UNKNOWN';
  return drill.members.some((m) => m.id === memberId) ? 'ALARM' : 'NOT_IN_DRILL';
}

/** The alerts that alarm this member: SOS first, then the oldest. */
export function alarmsFor(
  alerts: Iterable<Alert>,
  memberId: string,
  drills: readonly DrillParticipants[],
): Alert[] {
  const sos = (a: Alert) => Number(a.type === 'SOS_ACTIVATED');
  return [...alerts]
    .filter((a) => alarmDecision(a, memberId, drills) === 'ALARM')
    .sort((a, b) => sos(b) - sos(a) || a.openedAt.localeCompare(b.openedAt));
}

/** The drills alarming alerts name that the dashboard still has to ask about (once per drill). */
export function drillsToCheck(
  alerts: Iterable<Alert>,
  drills: readonly DrillParticipants[],
  asked: ReadonlySet<string>,
): string[] {
  const ids = [...alerts]
    .filter((a) => isAlarming(a) && a.isDrill && drillOf(a, drills) === null)
    .map((a) => a.drillId)
    .filter((id): id is string => id !== null && !asked.has(id));
  return [...new Set(ids)];
}

/** Where an alarm's details are: its SOS page, its incident, or the alert list. */
export function alarmPath(alert: Alert): string {
  if (alert.sosEventId) return `/sos/${alert.sosEventId}`;
  if (alert.incidentId) return `/incidents/${alert.incidentId}`;
  return `/alerts?id=${alert.id}`;
}

/** "SOS", "Critical incident", with "DRILL" in front of a drill's. */
export function alarmLabel(alert: Alert): string {
  return alert.type === 'SOS_ACTIVATED' ? 'SOS' : 'Critical incident';
}

/** The tab title flashes between these while an alarm is on (PROD §11.6); either one says so. */
export function alarmTitles(alarms: readonly Alert[]): readonly [string, string] {
  const what = alarms.some((a) => a.type === 'SOS_ACTIVATED') ? 'SOS' : 'CRITICAL ALERT';
  const drill = alarms.length > 0 && alarms.every((a) => a.isDrill) ? '[DRILL] ' : '';
  const count = alarms.length > 1 ? ` (${alarms.length})` : '';
  return [`🔴 ${drill}${what} ALARM${count}`, `${drill}${what} — not acknowledged${count}`];
}

/**
 * The browser notification shown while the tab is in the background (supplementary, PROD §11.6):
 * the same lock-screen-safe words as the server's own push, with no coordinates and no incident
 * text (PROD §13).
 */
export function alarmNotificationText(alert: Alert): { title: string; body: string } {
  if (alert.type === 'SOS_ACTIVATED') {
    return sosNotificationText({
      guardName: alert.guard?.displayName ?? 'Guard',
      siteName: alert.site?.name ?? null,
      drill: alert.isDrill,
      again: alert.triggerCount > 1,
    });
  }
  const prefix = alert.isDrill ? '[DRILL] ' : '';
  const who = alert.guard ? ` — ${plainLine(shortName(alert.guard.displayName), 60)}` : '';
  const where = alert.site ? ` — ${plainLine(alert.site.name, 80)}` : '';
  return {
    title: `${prefix}${alarmLabel(alert)}${who}${where}`.slice(0, 200),
    body: 'Open the dashboard to acknowledge.',
  };
}

// ── Display receipts (ARCH §13.1, INV-10) ───────────────────────────────────────────────────

/** A failed receipt is tried again after this long, while its alarm is still on a visible screen. */
export const SEEN_RETRY_MS = 5_000;

export type SeenReporter = {
  /** The alerts whose alarm is on screen now (overlay or bar mounted). */
  readonly show: (alertIds: readonly string[]) => void;
  /** The page's visibility changed. */
  readonly visibilityChanged: () => void;
  readonly dispose: () => void;
};

/**
 * Sends POST /alerts/:id/seen for each alarm on screen, once, and only while the page is visible:
 * a hidden tab never says it showed an alarm. `send` resolves when the server has the receipt (or
 * refused it for good) and rejects when it should be tried again.
 */
export function createSeenReporter(options: {
  readonly visible: () => boolean;
  readonly send: (alertId: string) => Promise<unknown>;
}): SeenReporter {
  let shown: ReadonlySet<string> = new Set();
  const done = new Set<string>();
  const sending = new Set<string>();
  let retry: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = (): void => {
    if (disposed || !options.visible()) return;
    for (const id of shown) {
      if (done.has(id) || sending.has(id)) continue;
      sending.add(id);
      void options
        .send(id)
        .then(
          () => {
            done.add(id);
          },
          () => {
            if (disposed || retry !== null) return;
            retry = setTimeout(() => {
              retry = null;
              flush();
            }, SEEN_RETRY_MS);
          },
        )
        .finally(() => sending.delete(id));
    }
  };

  return {
    show: (alertIds) => {
      shown = new Set(alertIds);
      flush();
    },
    visibilityChanged: flush,
    dispose: () => {
      disposed = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
    },
  };
}
