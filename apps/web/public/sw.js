// The dashboard's service worker (PROD §11.5, ARCH §13.1, D-26). It shows each Web Push message as a
// notification and, once it is shown, tells the server the push reached this device: the delivery
// receipt that makes an SOS "notified" (POST /api/v1/alerts/:id/delivered, INV-10). The notification
// comes first, so a receipt that fails never stops it from showing. Tapping a notification brings an
// open dashboard forward, or opens one. It caches nothing and handles no page requests. Plain
// JavaScript with no imports: the browser loads it as it is, from /sw.js, for the scope /.
/* global self */

/** A dashboard path from the message, or the home page: never another site. */
function safePath(value) {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\')
    ? value
    : '/';
}

/** The message as packages/contracts/src/notifications.ts (webPushPayloadSchema) defines it, or null. */
function readPayload(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (data && data.v === 1 && typeof data.title === 'string') return data;
  } catch {
    // not JSON: shown as a plain alert below
  }
  return null;
}

/** The delivery receipt. Signed out, offline or refused: the notification shows all the same. */
async function sendReceipt(payload) {
  if (!payload.alertId || !payload.deliveryId || !payload.organizationId) return;
  try {
    await fetch(`/api/v1/alerts/${encodeURIComponent(payload.alertId)}/delivered`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-sentry-csrf': '1',
        'x-organization-id': payload.organizationId,
      },
      body: JSON.stringify({ deliveryId: payload.deliveryId }),
    });
  } catch {
    // no receipt this time
  }
}

async function show(payload) {
  if (!payload) {
    await self.registration.showNotification('SENTRY', {
      body: 'Open the dashboard for details.',
      data: { url: '/' },
    });
    return;
  }
  // One notification per alert: a repeat replaces it and sounds again.
  const tag = payload.alertId || payload.deliveryId;
  await self.registration.showNotification(payload.title, {
    body: typeof payload.body === 'string' ? payload.body : '',
    ...(tag ? { tag, renotify: true } : {}),
    // An SOS stays on screen until someone deals with it.
    requireInteraction: payload.kind === 'SOS',
    data: { url: safePath(payload.url) },
  });
}

self.addEventListener('install', () => {
  // Nothing to cache: a new version takes over at once.
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const payload = readPayload(event);
  // The receipt says the alert is on this device's screen, so it goes once the notification shows.
  event.waitUntil(
    show(payload).then(
      () => (payload ? sendReceipt(payload) : undefined),
      () => undefined,
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    safePath(event.notification.data && event.notification.data.url),
    self.location.origin,
  );
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === target.origin);
      if (open) {
        await open.focus();
        try {
          await open.navigate(target.href);
        } catch {
          // a dashboard this worker doesn't control yet: focused, its own alarm shows the SOS
        }
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
