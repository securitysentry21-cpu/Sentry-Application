// Web Push on this device (PROD §11.5, D-04, D-26): the dashboard's service worker (public/sw.js)
// shows SOS and alert notifications and reports each one that arrives (the delivery receipt,
// INV-10). On iPhone and iPad, web push reaches only a dashboard installed to the home screen and
// opened from there. Browser only; nothing runs on import.

export const SERVICE_WORKER_URL = '/sw.js';

export type PushSupport =
  | 'supported'
  /** iPhone or iPad in the browser: install to the home screen first. */
  | 'needs-install'
  | 'unsupported';

/** iPhone and iPad, including iPads that say they are a Mac. */
export function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Opened from the home screen, as an installed app. */
export function isInstalled(): boolean {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    // no matchMedia: not installed
  }
  return (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  if (isAppleMobile() && !isInstalled()) return 'needs-install';
  const capable =
    'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  return capable ? 'supported' : 'unsupported';
}

/** The server's VAPID public key (base64url, as GET /push/config sends it) as the bytes subscribe() takes. */
export function vapidKeyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((value, i) => value === b[i]);
}

export class PushSetupError extends Error {}

/** What POST /push-subscriptions takes, apart from the client kind. */
export type BrowserSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/**
 * Asks for permission, registers the service worker and subscribes this browser with the server's
 * key. Call it from a click: browsers ask for permission only in answer to one. A subscription made
 * earlier with another key is replaced.
 */
export async function subscribeThisBrowser(vapidPublicKey: string): Promise<BrowserSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushSetupError(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.'
        : 'Notifications were not allowed. Try again and choose Allow.',
    );
  }
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
    scope: '/',
    updateViaCache: 'none',
  });
  await navigator.serviceWorker.ready;
  const key = vapidKeyBytes(vapidPublicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameBytes(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth)
    throw new PushSetupError('This browser returned an incomplete subscription.');
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** The service worker, when this browser has one registered. */
export async function serviceWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker?.getRegistration('/')) ?? null;
  } catch {
    return null;
  }
}

/** Whether this browser holds a push subscription now. */
export async function browserSubscribed(): Promise<boolean> {
  const registration = await serviceWorker();
  try {
    return (await registration?.pushManager.getSubscription()) != null;
  } catch {
    return false;
  }
}

/** This browser's subscription ID in an organization, to mark it in the list (a convenience only). */
const storageKey = (organizationId: string) => `sentry.push.${organizationId}`;

export function rememberSubscription(organizationId: string, id: string | null): void {
  try {
    if (id) window.localStorage.setItem(storageKey(organizationId), id);
    else window.localStorage.removeItem(storageKey(organizationId));
  } catch {
    // private mode: the list just won't mark this browser
  }
}

export function rememberedSubscription(organizationId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(organizationId));
  } catch {
    return null;
  }
}
