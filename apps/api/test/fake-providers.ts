// Notification providers for tests: they accept or fail on command and remember what they sent, so a
// test can follow an SOS from the press to the person's device (ADV-S01, S08).
import { createECDH, randomBytes, randomUUID } from 'node:crypto';

import type { FcmSender } from '../src/notify/fcm.ts';
import { MemorySms, type Providers, type SendResult } from '../src/notify/providers.ts';
import type { WebPushSender } from '../src/notify/webpush.ts';

export class FakeWebPush implements WebPushSender {
  readonly publicKey = createECDH('prime256v1').generateKeys().toString('base64url');
  readonly sent: { endpoint: string; payload: string; urgency: string }[] = [];
  /** When set, every send fails with this code (a provider outage, ADV-S08). */
  failWith: string | null = null;

  send(input: { endpoint: string; payload: string; urgency: 'high' | 'normal' }): Promise<SendResult> {
    if (this.failWith) return Promise.resolve({ ok: false, retryable: true, code: this.failWith });
    this.sent.push({ endpoint: input.endpoint, payload: input.payload, urgency: input.urgency });
    return Promise.resolve({ ok: true, providerMessageId: randomUUID() });
  }

  /** The payloads that went to one browser. */
  payloadsFor(
    endpoint: string,
  ): { alertId: string | null; deliveryId: string; title: string; drill: boolean }[] {
    return this.sent.filter((s) => s.endpoint === endpoint).map((s) => JSON.parse(s.payload) as never);
  }
}

export class FakeFcm implements FcmSender {
  readonly sent: { token: string; title: string; body: string; data: Readonly<Record<string, string>> }[] =
    [];

  send(input: {
    token: string;
    title: string;
    body: string;
    data: Readonly<Record<string, string>>;
  }): Promise<SendResult> {
    this.sent.push(input);
    return Promise.resolve({ ok: true, providerMessageId: randomUUID() });
  }
}

export function fakeProviders(): Providers & { webPush: FakeWebPush; fcm: FakeFcm; sms: MemorySms } {
  const webPush = new FakeWebPush();
  return { vapidPublicKey: webPush.publicKey, webPush, fcm: new FakeFcm(), sms: new MemorySms() };
}

/** A browser subscription as the dashboard registers it: a push-service endpoint and real keys. */
export function browserSubscription(client: 'DESKTOP' | 'PHONE' = 'PHONE') {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
    client,
  };
}
