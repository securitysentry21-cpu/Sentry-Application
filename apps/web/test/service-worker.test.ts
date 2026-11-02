// The dashboard's service worker (public/sw.js), run as the browser runs it: a plain script with a
// `self`. It shows every push, then reports its delivery (the receipt that makes an SOS "notified",
// INV-10) with the session's CSRF header and the push's organization; a receipt that fails never
// stops the notification; a tap opens only a dashboard path.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import type { WebPushPayload } from '@sentryops/contracts';
import { describe, expect, it, vi } from 'vitest';

import { vapidKeyBytes } from '../lib/push';

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://ops.sentry.example';

type Listener = (event: unknown) => void;
type Shown = { title: string; options: Record<string, unknown> };
type FakeWindow = { url: string; focus: () => Promise<void>; navigate: (url: string) => Promise<unknown> };

function worker(
  options: { fetch?: (url: string, init: RequestInit) => Promise<unknown>; windows?: FakeWindow[] } = {},
) {
  const listeners = new Map<string, Listener>();
  const order: string[] = [];
  const shown: Shown[] = [];
  const opened: string[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    order.push('receipt');
    return options.fetch ? options.fetch(url, init) : Promise.resolve({ ok: true });
  });
  const self = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => Promise.resolve(),
    location: { origin: ORIGIN },
    registration: {
      showNotification: (title: string, opts: Record<string, unknown>) => {
        order.push('notification');
        shown.push({ title, options: opts });
        return Promise.resolve();
      },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(options.windows ?? []),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve(null);
      },
    },
  };
  runInNewContext(SOURCE, { self, fetch, URL, JSON, encodeURIComponent, Promise });

  async function dispatch(type: string, event: Record<string, unknown>) {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  }
  const push = (data: unknown) =>
    dispatch('push', {
      data:
        data === undefined
          ? null
          : {
              json: () => (typeof data === 'string' ? (JSON.parse(data) as unknown) : data),
            },
    });
  const click = (url: unknown) =>
    dispatch('notificationclick', { notification: { data: { url }, close: () => undefined } });
  return { fetch, shown, opened, order, push, click, listeners };
}

const payload = (overrides: Partial<WebPushPayload> = {}): WebPushPayload => ({
  v: 1,
  kind: 'SOS',
  title: 'SOS — Ahmed K. — ABC Warehouse',
  body: 'Open the dashboard to acknowledge.',
  url: '/sos/0190a0d2-7c5e-7000-8000-000000000030',
  organizationId: '0190a0d2-7c5e-7000-8000-000000000001',
  alertId: '0190a0d2-7c5e-7000-8000-000000000020',
  deliveryId: '0190a0d2-7c5e-7000-8000-000000000040',
  drill: false,
  ...overrides,
});

describe('the dashboard service worker (public/sw.js)', () => {
  it('INV-10 the service worker shows every push, then reports its delivery with the CSRF and organization headers', async () => {
    const sw = worker();
    await sw.push(payload());
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.title).toBe('SOS — Ahmed K. — ABC Warehouse');
    expect(sw.shown[0]?.options).toMatchObject({
      body: 'Open the dashboard to acknowledge.',
      tag: payload().alertId,
      requireInteraction: true,
      data: { url: payload().url },
    });
    expect(sw.order).toEqual(['notification', 'receipt']);
    expect(sw.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = sw.fetch.mock.calls[0]!;
    expect(url).toBe(`/api/v1/alerts/${payload().alertId}/delivered`);
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-sentry-csrf': '1',
        'x-organization-id': payload().organizationId,
      },
    });
    expect(JSON.parse(init.body as string) as unknown).toEqual({ deliveryId: payload().deliveryId });
  });

  it('INV-10 a failed delivery receipt never stops the notification from showing', async () => {
    for (const failure of [
      () => Promise.reject(new TypeError('offline')),
      () => Promise.resolve({ ok: false, status: 401 }),
    ]) {
      const sw = worker({ fetch: failure });
      await expect(sw.push(payload())).resolves.toBeUndefined();
      expect(sw.shown).toHaveLength(1);
      expect(sw.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('shows a push without an alert (the test alert) or with an unreadable body, and reports nothing for them', async () => {
    const test = worker();
    await test.push(
      payload({
        kind: 'TEST',
        alertId: null,
        title: 'TEST — SOS alert test',
        url: '/settings/notifications',
      }),
    );
    expect(test.shown[0]?.title).toBe('TEST — SOS alert test');
    expect(test.shown[0]?.options).toMatchObject({ tag: payload().deliveryId, requireInteraction: false });
    expect(test.fetch).not.toHaveBeenCalled();

    const unreadable = worker();
    await unreadable.push('not json');
    await unreadable.push(undefined);
    expect(unreadable.shown.map((s) => s.title)).toEqual(['SENTRY', 'SENTRY']);
    expect(unreadable.fetch).not.toHaveBeenCalled();
  });

  it('a tap brings an open dashboard forward on the alert, or opens one, and only ever a dashboard path', async () => {
    const focus = vi.fn(() => Promise.resolve());
    const navigate = vi.fn(() => Promise.resolve(null));
    const open = worker({ windows: [{ url: `${ORIGIN}/dashboard`, focus, navigate }] });
    await open.click('/sos/abc');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/sos/abc`);
    expect(open.opened).toEqual([]);

    const closed = worker();
    for (const url of [
      '//evil.example/x',
      'https://evil.example/',
      'javascript:alert(1)',
      '/\\evil.example',
      42,
    ]) {
      await closed.click(url);
    }
    await closed.click('/alerts?id=1');
    expect(closed.opened).toEqual([...Array<string>(5).fill(`${ORIGIN}/`), `${ORIGIN}/alerts?id=1`]);
  });
});

describe('subscribing (PROD §11.5)', () => {
  it("reads the server's VAPID public key (base64url, unpadded) into the 65 bytes of an uncompressed P-256 key", () => {
    const key = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    const bytes = vapidKeyBytes(key);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
    expect(Buffer.from(bytes).toString('base64url')).toBe(key);
  });
});
