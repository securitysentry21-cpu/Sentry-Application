'use client';

// The dashboard alarm (PROD §11.4, §11.6; ADV-S09). Every open CRITICAL alert, an SOS or a critical
// incident, covers the screen with a repeating sound until someone acknowledges it; on its own page
// (the SOS page, the incident) it shrinks to a bar so the page stays usable. A drill alarms only the
// members taking part (ADV-S10). Browsers keep a page silent until someone clicks (EXT-40), so the
// shell offers "Enable alarm sound" and shows a warning while sound is off; the alarm itself shows
// either way. The tab title flashes, and a browser notification appears while the tab is in the
// background (supplementary, when allowed). While the alarm is on a visible screen the dashboard
// says so once (POST /alerts/:id/seen), the display receipt that makes an SOS NOTIFIED (INV-10).
// Names render as text only (ADV-W01).
import type { Alert, SosDrill } from '@sentryops/contracts';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  alarmLabel,
  alarmNotificationText,
  alarmPath,
  alarmsFor,
  alarmTitles,
  createSeenReporter,
  drillsToCheck,
  guardDisabled,
  type DrillParticipants,
  type SeenReporter,
} from '../lib/alarm';
import {
  enableSound as unlockSound,
  onSoundChange,
  prepareSound,
  soundState,
  startSiren,
  stopSiren,
  type SoundState,
} from '../lib/alarm-sound';
import { api, ApiError, errorText } from '../lib/api';
import { formatRelative } from '../lib/format';
import { clientKind, useLive } from '../lib/live';
import { serviceWorker } from '../lib/push';
import { useSession } from '../lib/session';

/** A failed drill lookup is tried again after this long. */
const DRILL_RETRY_MS = 5_000;

type Alarms = {
  /** Whether this member is alarmed at all: live data and alerts. */
  readonly watching: boolean;
  /** Open critical alerts that alarm this member: SOS first, then the oldest. */
  readonly alarms: readonly Alert[];
  readonly sound: SoundState;
  /** From a click or key press: browsers allow sound only in answer to one. */
  readonly enableSound: () => void;
  /** Acknowledges through POST /alerts/:id/acknowledge (an SOS's alert acknowledges the SOS). */
  readonly acknowledge: (alert: Alert) => Promise<void>;
};

const AlarmContext = createContext<Alarms | null>(null);

export function AlarmProvider({ children }: { children: ReactNode }) {
  const { can, membership } = useSession();
  const { model, mergeAlert } = useLive();
  const watching = can('live.read') && can('alerts.read');
  const canDrills = can('sos.read');
  const [sound, setSound] = useState<SoundState>('off');
  const [drills, setDrills] = useState<readonly DrillParticipants[]>([]);
  const [retry, setRetry] = useState(0);
  const asked = useRef(new Set<string>());
  const asking = useRef(false);
  const organization = useRef(membership.organizationId);

  useEffect(() => {
    if (!watching) return;
    prepareSound();
    setSound(soundState());
    return onSoundChange(() => setSound(soundState()));
  }, [watching]);

  // Another organization has its own drills.
  useEffect(() => {
    organization.current = membership.organizationId;
    asked.current = new Set();
    setDrills([]);
  }, [membership.organizationId]);

  // A drill alarms only its participants: the alert names its drill, and the dashboard asks once per
  // drill who takes part. Until the answer, a drill doesn't alarm (owner decision 2026-11-02).
  const alerts = model?.alerts;
  useEffect(() => {
    if (!alerts || !canDrills || asking.current) return;
    const unknown = drillsToCheck(alerts.values(), drills, asked.current);
    if (unknown.length === 0) return;
    const org = membership.organizationId;
    asking.current = true;
    void Promise.all(unknown.map((id) => api<{ drill: SosDrill }>(`/sos-drills/${id}`)))
      .then((answers) => {
        if (organization.current !== org) return;
        for (const id of unknown) asked.current.add(id);
        const fetched = answers.map((a) => a.drill);
        setDrills((known) => [...known.filter((d) => !fetched.some((f) => f.id === d.id)), ...fetched]);
      })
      .catch(() => window.setTimeout(() => setRetry((n) => n + 1), DRILL_RETRY_MS))
      .finally(() => {
        asking.current = false;
      });
  }, [alerts, drills, canDrills, membership.organizationId, retry]);

  const alarms = useMemo(
    () => (watching && alerts ? alarmsFor(alerts.values(), membership.memberId, drills) : []),
    [watching, alerts, membership.memberId, drills],
  );

  const acknowledge = useCallback(
    async (alert: Alert) => {
      const result = await api<{ alert: Alert }>(`/alerts/${alert.id}/acknowledge`, { method: 'POST' });
      // The server's answer stops the alarm now; the stream confirms it a moment later.
      mergeAlert(result.alert);
    },
    [mergeAlert],
  );

  const value = useMemo<Alarms>(
    () => ({ watching, alarms, sound, enableSound: () => void unlockSound(), acknowledge }),
    [watching, alarms, sound, acknowledge],
  );
  return <AlarmContext.Provider value={value}>{children}</AlarmContext.Provider>;
}

export function useAlarms(): Alarms {
  const alarms = useContext(AlarmContext);
  if (!alarms) throw new Error('useAlarms outside AlarmProvider');
  return alarms;
}

/** The alarm on screen, in the app shell. */
export function AlarmLayer() {
  const { watching, alarms, sound, enableSound, acknowledge } = useAlarms();
  const { can, membership } = useSession();
  const { now } = useLive();
  const pathname = usePathname();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // On its own page an alarm is a bar, so the page stays usable; any other alarm covers the screen.
  const onItsPage = (a: Alert) => pathname === alarmPath(a);
  const full = alarms.filter((a) => !onItsPage(a));
  const bar = alarms.filter(onItsPage);

  useSiren(alarms.length > 0);
  useTitleFlash(alarms);
  useBackgroundNotification(alarms);
  useDisplayReceipts(alarms, membership.organizationId);

  if (!watching) return null;

  const onAcknowledge = (alert: Alert) => {
    setBusy(alert.id);
    setError(null);
    void acknowledge(alert)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(null));
  };
  const actions = { now, canAcknowledge: can('alerts.acknowledge'), onAcknowledge, busy, error };

  return (
    <>
      <SoundWarning state={sound} onEnable={enableSound} />
      {bar.length > 0 ? <AlarmBar alarms={bar} {...actions} /> : null}
      {full.length > 0 ? (
        <AlarmView alarms={full} sound={sound} onEnableSound={enableSound} {...actions} />
      ) : null}
    </>
  );
}

// ── What is shown (plain components, so tests can render them) ──────────────────────────────

/** ADV-S09: while sound is off the dashboard says so, and offers to turn it on. */
export function SoundWarning({ state, onEnable }: { state: SoundState; onEnable: () => void }) {
  if (state === 'on') return null;
  if (state === 'unavailable') {
    return (
      <div className="banner warn sound-warning" role="status">
        <span>
          <strong>This browser can’t play the alarm sound.</strong> SOS alarms still appear on screen, without
          sound. Use a current Chrome, Edge, Firefox or Safari for sound.
        </span>
      </div>
    );
  }
  return (
    <div className="banner warn sound-warning" role="status">
      <span>
        <strong>Alarm sound is off.</strong> Browsers keep a page silent until you click on it, so an SOS
        would appear here without sound.
      </span>
      <button type="button" className="btn primary small" onClick={onEnable}>
        Enable alarm sound
      </button>
    </div>
  );
}

type AlarmActions = {
  readonly now: Date;
  readonly canAcknowledge: boolean;
  readonly onAcknowledge: (alert: Alert) => void;
  /** The alert being acknowledged. */
  readonly busy: string | null;
  readonly error: string | null;
};

/** "Pressed again ×2 · last 10 s ago" for an SOS pressed more than once (PROD §11.9). */
function pressedAgain(alert: Alert, now: Date): string | null {
  if (alert.type !== 'SOS_ACTIVATED' || alert.triggerCount < 2) return null;
  return `Pressed again ×${alert.triggerCount - 1} · last ${formatRelative(alert.lastTriggeredAt, now)}`;
}

/** Full screen, until acknowledged (PROD §11.4). */
export function AlarmView(
  props: AlarmActions & {
    readonly alarms: readonly Alert[];
    readonly sound: SoundState;
    readonly onEnableSound: () => void;
  },
) {
  const { alarms, sound, onEnableSound, now, canAcknowledge, onAcknowledge, busy, error } = props;
  const first = alarms[0];
  if (!first) return null;
  const drill = alarms.every((a) => a.isDrill);
  const heading = alarms.length > 1 ? `${alarms.length} alarms` : `${alarmLabel(first)} alarm`;
  return (
    <div
      className="overlay alarm-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="alarm-title"
      aria-describedby="alarm-help"
    >
      <div className="dialog alarm-dialog">
        <h2 id="alarm-title" className="alarm-title">
          {drill ? 'DRILL — ' : ''}
          {heading}
        </h2>
        <p id="alarm-help" className="muted">
          Acknowledge to stop the alarm and the escalation. The guard and your team are told that someone is
          on it.
        </p>
        <SoundWarning state={sound} onEnable={onEnableSound} />
        {error ? <div className="banner error">{error}</div> : null}
        <ul className="alarm-list">
          {alarms.map((a, i) => {
            const again = pressedAgain(a, now);
            return (
              <li className="alarm-item" key={a.id}>
                <div className="row">
                  <span className="badge danger">{alarmLabel(a)}</span>
                  {a.isDrill ? <span className="badge drill">DRILL</span> : null}
                  <span className="faint" title={a.openedAt}>
                    {formatRelative(a.openedAt, now)}
                  </span>
                </div>
                <div className="alarm-who">{a.guard?.displayName ?? a.summary}</div>
                <div className="muted">
                  {a.site?.name ?? (a.type === 'SOS_ACTIVATED' ? 'Off shift: no site' : '')}
                </div>
                {guardDisabled(a) ? (
                  <div>
                    <strong>Guard account disabled:</strong> confirm who is calling before you act.
                  </div>
                ) : null}
                {a.type !== 'SOS_ACTIVATED' ? <div>{a.summary}</div> : null}
                {again ? (
                  <div>
                    <strong>{again}</strong>
                  </div>
                ) : null}
                <div className="row">
                  {canAcknowledge ? (
                    <button
                      type="button"
                      className="btn primary alarm-ack"
                      autoFocus={i === 0}
                      disabled={busy === a.id}
                      onClick={() => onAcknowledge(a)}
                    >
                      {busy === a.id ? 'Acknowledging…' : 'Acknowledge'}
                    </button>
                  ) : (
                    <span className="faint">Your role can’t acknowledge alarms.</span>
                  )}
                  <Link className="btn" href={alarmPath(a)}>
                    {a.sosEventId ? 'Open SOS page' : a.incidentId ? 'Open incident' : 'Open alerts'}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** On the alarm's own page: a bar at the top, still sounding until acknowledged. */
export function AlarmBar(props: AlarmActions & { readonly alarms: readonly Alert[] }) {
  const { alarms, now, canAcknowledge, onAcknowledge, busy, error } = props;
  return (
    <section className="alarm-bar" aria-label="Alarm">
      {alarms.map((a) => (
        <div className="alarm-bar-item" key={a.id}>
          <span>
            <strong>
              {a.isDrill ? 'DRILL · ' : ''}
              {alarmLabel(a)} alarm
            </strong>{' '}
            — {a.guard?.displayName ?? a.summary}
            {guardDisabled(a) ? ' (guard account disabled)' : ''} · not acknowledged ·{' '}
            {formatRelative(a.openedAt, now)}
          </span>
          {canAcknowledge ? (
            <button
              type="button"
              className="btn primary small"
              disabled={busy === a.id}
              onClick={() => onAcknowledge(a)}
            >
              {busy === a.id ? 'Acknowledging…' : 'Acknowledge'}
            </button>
          ) : null}
        </div>
      ))}
      {error ? <div>{error}</div> : null}
    </section>
  );
}

// ── Effects ──────────────────────────────────────────────────────────────────────────────────

function useSiren(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    startSiren();
    return () => stopSiren();
  }, [on]);
}

/** The tab title flashes between two alarm titles; either one says there is an alarm. */
function useTitleFlash(alarms: readonly Alert[]): void {
  const [a, b] = alarms.length > 0 ? alarmTitles(alarms) : [null, null];
  useEffect(() => {
    if (!a || !b) return;
    const original = document.title;
    let flip = false;
    document.title = a;
    const timer = window.setInterval(() => {
      flip = !flip;
      document.title = flip ? b : a;
    }, 1000);
    return () => {
      window.clearInterval(timer);
      document.title = original;
    };
  }, [a, b]);
}

function notificationsAllowed(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

/**
 * While the tab is in the background, each alarm also shows as a browser notification (PROD §11.6,
 * supplementary): through the service worker when there is one (Android needs it), otherwise from
 * the page. Its tag is the alert, so the server's own push for it replaces it rather than adding
 * one; pressed again, it shows again. When the alarm stops, its notifications go.
 */
function useBackgroundNotification(alarms: readonly Alert[]): void {
  const router = useRouter();
  const notified = useRef(new Map<string, number>());
  const fromPage = useRef(new Map<string, Notification>());
  const previous = useRef(new Set<string>());
  const latest = useRef(alarms);
  latest.current = alarms;

  useEffect(() => {
    const notify = () => {
      if (document.visibilityState !== 'hidden' || !notificationsAllowed()) return;
      for (const alert of latest.current) {
        if (notified.current.get(alert.id) === alert.triggerCount) continue;
        notified.current.set(alert.id, alert.triggerCount);
        void showNotification(alert, fromPage.current, (path) => router.push(path));
      }
    };
    notify();
    document.addEventListener('visibilitychange', notify);
    return () => document.removeEventListener('visibilitychange', notify);
  }, [alarms, router]);

  useEffect(() => {
    const now = new Set(alarms.map((a) => a.id));
    for (const id of previous.current) {
      if (now.has(id)) continue;
      notified.current.delete(id);
      fromPage.current.get(id)?.close();
      fromPage.current.delete(id);
      void closeNotifications(id);
    }
    previous.current = now;
  }, [alarms]);
}

async function showNotification(
  alert: Alert,
  fromPage: Map<string, Notification>,
  open: (path: string) => void,
): Promise<void> {
  const { title, body } = alarmNotificationText(alert);
  const path = alarmPath(alert);
  const options = {
    body,
    tag: alert.id,
    renotify: true,
    requireInteraction: true,
    data: { url: path },
  } as NotificationOptions;
  const registration = await serviceWorker();
  if (registration) {
    try {
      await registration.showNotification(title, options);
      return;
    } catch {
      // the page shows it instead
    }
  }
  try {
    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      open(path);
      notification.close();
    };
    fromPage.set(alert.id, notification);
  } catch {
    // no Notification constructor here (Android without the service worker): the alarm still shows
  }
}

async function closeNotifications(alertId: string): Promise<void> {
  const registration = await serviceWorker();
  try {
    for (const n of (await registration?.getNotifications({ tag: alertId })) ?? []) n.close();
  } catch {
    // nothing to close
  }
}

/** Display receipts: once per alarm, only while it is on a visible screen (INV-10). */
function useDisplayReceipts(alarms: readonly Alert[], organizationId: string): void {
  const reporter = useRef<SeenReporter | null>(null);
  const key = alarms.map((a) => a.id).join(' ');

  useEffect(() => {
    const client = clientKind() === 'phone' ? 'PHONE' : 'DESKTOP';
    const current = createSeenReporter({
      visible: () => document.visibilityState === 'visible',
      send: (id) =>
        api(`/alerts/${id}/seen`, { method: 'POST', body: { client } }).catch((e: unknown) => {
          // Refused for good (gone, or not allowed): asking again won't change that.
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) return;
          throw e;
        }),
    });
    reporter.current = current;
    const onVisibility = () => current.visibilityChanged();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      current.dispose();
      reporter.current = null;
    };
  }, [organizationId]);

  // Runs after the alarm is on the page: the overlay or bar is mounted by now.
  useEffect(() => {
    reporter.current?.show(key ? key.split(' ') : []);
  }, [key, organizationId]);
}
