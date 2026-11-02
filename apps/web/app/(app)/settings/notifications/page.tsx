'use client';

// Notifications on this device (PROD §11.5, D-04, D-26), at the address the test alert links to.
// Every member sets up their own browsers, whatever their role: the alarm sound on this screen, Web
// Push for when the dashboard isn't open (the service worker at /sw.js shows it and reports that it
// arrived, INV-10), the list of their registered browsers, and "Send me a test SOS alert". On iPhone
// and iPad, web push reaches only a dashboard installed to the home screen. Silent mode and Do Not
// Disturb can still hold back pushes and texts; the control room's dashboard, which is staffed, is
// the main receiver, and SOS also texts duty officers.
import { useCallback, useEffect, useState } from 'react';

import { useAlarms } from '../../../../components/alarm';
import { PageHead } from '../../../../components/shell';
import { previewSiren } from '../../../../lib/alarm-sound';
import { api, ApiError, errorText } from '../../../../lib/api';
import { formatDateTime } from '../../../../lib/format';
import { clientKind } from '../../../../lib/live';
import {
  browserSubscribed,
  PushSetupError,
  pushSupport,
  rememberedSubscription,
  rememberSubscription,
  subscribeThisBrowser,
  type PushSupport,
} from '../../../../lib/push';
import { useSession } from '../../../../lib/session';

type Subscription = {
  id: string;
  client: 'DESKTOP' | 'PHONE';
  status: 'ACTIVE' | 'INVALID';
  createdAt: string;
  lastSuccessAt: string | null;
};

type Message = { kind: 'error' | 'success' | 'warn'; text: string };
type Permission = NotificationPermission | 'unsupported';

const messageOf = (e: unknown) =>
  e instanceof ApiError || !(e instanceof Error) ? errorText(e) : e.message || 'Something went wrong.';

function currentPermission(): Permission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

const PERMISSION_TEXT: Record<Permission, string> = {
  granted: 'allowed',
  denied: 'blocked in this browser’s site settings',
  default: 'not asked yet',
  unsupported: 'not available in this browser',
};

export default function NotificationsPage() {
  const { membership } = useSession();
  const { sound, enableSound } = useAlarms();
  const tz = membership.organizationTimezone;
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [permission, setPermission] = useState<Permission>('default');
  const [vapidKey, setVapidKey] = useState<string | null | undefined>(undefined);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  /** 'push', 'permission', 'test', or the ID of a browser being removed. */
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const loadList = useCallback(async () => {
    try {
      setSubscriptions((await api<{ subscriptions: Subscription[] }>('/push-subscriptions')).subscriptions);
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
    }
  }, []);

  useEffect(() => {
    setSupport(pushSupport());
    setPermission(currentPermission());
    setMine(rememberedSubscription(membership.organizationId));
    void browserSubscribed().then(setSubscribed);
    void api<{ vapidPublicKey: string | null }>('/push/config')
      .then((c) => setVapidKey(c.vapidPublicKey))
      .catch((e: unknown) => {
        setVapidKey(null);
        setMessage({ kind: 'error', text: errorText(e) });
      });
    void loadList();
  }, [membership.organizationId, loadList]);

  async function turnOnPush() {
    if (!vapidKey) return;
    setBusy('push');
    setMessage(null);
    try {
      const subscription = await subscribeThisBrowser(vapidKey);
      const client = clientKind() === 'phone' ? 'PHONE' : 'DESKTOP';
      const result = await api<{ subscription: Subscription }>('/push-subscriptions', {
        method: 'POST',
        body: { ...subscription, client },
      });
      rememberSubscription(membership.organizationId, result.subscription.id);
      setMine(result.subscription.id);
      setSubscribed(true);
      setMessage({
        kind: 'success',
        text: `This browser now receives ${membership.organizationName}'s alerts. Send yourself a test to check.`,
      });
      await loadList();
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof PushSetupError ? e.message : messageOf(e) });
    } finally {
      setPermission(currentPermission());
      setBusy(null);
    }
  }

  async function allowNotifications() {
    setBusy('permission');
    try {
      await Notification.requestPermission();
    } catch {
      // an old browser: the state below says what happened
    } finally {
      setPermission(currentPermission());
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setMessage(null);
    try {
      await api(`/push-subscriptions/${id}`, { method: 'DELETE' });
      if (id === mine) {
        rememberSubscription(membership.organizationId, null);
        setMine(null);
      }
      await loadList();
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy('test');
    setMessage(null);
    try {
      const queued = await api<{ webPush: number; sms: number }>('/notifications/test', { method: 'POST' });
      setMessage(
        queued.webPush + queued.sms === 0
          ? {
              kind: 'warn',
              text: 'Nothing was sent: no browser is registered for you here and you have no SOS text number. Turn on notifications above, or ask an Owner or Administrator to add your number on the Members page.',
            }
          : {
              kind: 'success',
              text: `Queued: ${queued.webPush} push notification${queued.webPush === 1 ? '' : 's'} to your registered browsers and ${queued.sms} text message${queued.sms === 1 ? '' : 's'} to your SOS number. They should arrive within a minute; if one doesn’t, check this device’s notification settings.`,
            },
      );
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  const active = subscriptions?.filter((s) => s.status === 'ACTIVE').length ?? 0;

  return (
    <>
      <PageHead
        title="Notifications"
        description={`How SOS alarms and alerts from ${membership.organizationName} reach you on this device.`}
      />
      {message ? <div className={`banner ${message.kind}`}>{message.text}</div> : null}

      <div className="card">
        <h2>Alarm on this screen</h2>
        <p className="muted">
          While the dashboard is open, an SOS covers the screen with a repeating alarm until someone
          acknowledges it. Browsers keep a page silent until you click on it.
        </p>
        <dl className="kv">
          <dt>Alarm sound</dt>
          <dd>
            {sound === 'on'
              ? 'on'
              : sound === 'off'
                ? 'off: click “Enable alarm sound”'
                : 'not available in this browser'}
          </dd>
          <dt>In the background</dt>
          <dd>Browser notifications are {PERMISSION_TEXT[permission]}.</dd>
        </dl>
        <div className="row">
          {sound === 'off' ? (
            <button type="button" className="btn primary" onClick={enableSound}>
              Enable alarm sound
            </button>
          ) : null}
          {sound === 'on' ? (
            <button type="button" className="btn" onClick={() => previewSiren()}>
              Test the alarm sound
            </button>
          ) : null}
          {permission === 'default' ? (
            <button
              type="button"
              className="btn"
              disabled={busy === 'permission'}
              onClick={() => void allowNotifications()}
            >
              Allow notifications while this tab is in the background
            </button>
          ) : null}
        </div>
      </div>

      <div className="card">
        <h2>Push notifications on this device</h2>
        <p className="muted">
          Push reaches you when the dashboard isn&apos;t open: a duty officer&apos;s phone, a laptop that is
          closed. On iPhone and iPad it works only when the dashboard is installed to the home screen and
          opened from there. Silent mode, Do Not Disturb and Focus can still hold pushes back, which is why an
          SOS also sends a text message to duty officers from the first second.
        </p>
        {support === 'needs-install' ? (
          <div className="banner warn" role="status">
            <strong>Install the dashboard first.</strong> In Safari, tap the Share button, then “Add to Home
            Screen”. Open SENTRY from the new icon, sign in, and come back to this page to turn push on.
          </div>
        ) : null}
        {support === 'unsupported' ? (
          <div className="banner warn" role="status">
            This browser can&apos;t receive push notifications. Use a current Chrome, Edge, Firefox or Safari.
          </div>
        ) : null}
        {vapidKey === null ? (
          <div className="banner warn" role="status">
            Push isn&apos;t set up on this server yet, so it can&apos;t be turned on. The alarm on an open
            dashboard and SOS texts still work.
          </div>
        ) : null}
        <dl className="kv">
          <dt>This browser</dt>
          <dd>
            {subscribed === null
              ? 'checking…'
              : subscribed
                ? `subscribed${mine ? '' : ' (perhaps for another organization: turn it on again to receive this one’s)'}`
                : 'not subscribed'}
          </dd>
          <dt>Notifications</dt>
          <dd>{PERMISSION_TEXT[permission]}</dd>
        </dl>
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={support !== 'supported' || !vapidKey || busy === 'push' || permission === 'denied'}
            onClick={() => void turnOnPush()}
          >
            {busy === 'push'
              ? 'Turning on…'
              : mine
                ? 'Turn on again for this browser'
                : 'Turn on push for this browser'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            Your registered browsers <span className="faint">({active} active)</span>
          </h2>
        </div>
        {subscriptions === null ? (
          <div className="loading">Loading…</div>
        ) : subscriptions.length === 0 ? (
          <div className="empty">No browser is registered for you in {membership.organizationName}.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Status</th>
                  <th>Added</th>
                  <th>Last delivered</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.client === 'PHONE' ? 'Phone' : 'Desktop'}
                      {s.id === mine ? <span className="faint"> (this browser)</span> : null}
                    </td>
                    <td>
                      <span className={`badge ${s.status === 'ACTIVE' ? 'ok' : 'warn'}`}>
                        {s.status === 'ACTIVE' ? 'active' : 'stopped working'}
                      </span>
                    </td>
                    <td className="muted">{formatDateTime(s.createdAt, tz)}</td>
                    <td className="muted">{s.lastSuccessAt ? formatDateTime(s.lastSuccessAt, tz) : '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn small danger"
                        disabled={busy === s.id}
                        onClick={() => void remove(s.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Test</h2>
        <p className="muted">
          Sends a test SOS alert to your registered browsers and to your SOS text number, marked as a test. It
          doesn&apos;t sound anyone else&apos;s alarm.
        </p>
        <div className="row">
          <button type="button" className="btn" disabled={busy === 'test'} onClick={() => void sendTest()}>
            {busy === 'test' ? 'Sending…' : 'Send me a test SOS alert'}
          </button>
        </div>
      </div>
    </>
  );
}
