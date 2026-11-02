// The notification providers (ARCH §13.4) behind small interfaces, so the sender, the tests and a
// provider outage (ADV-S08) all look the same to the engine.
import type { Config } from '../config.ts';
import { createFcmSender, type FcmSender } from './fcm.ts';
import {
  createWebPushSender,
  vapidKeysFromPem,
  vapidPublicKeyFromPem,
  type WebPushSender,
} from './webpush.ts';

export type SendResult =
  | { readonly ok: true; readonly providerMessageId: string | null }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly code: string;
      /** The address is gone for good (an expired subscription, an unregistered token). */
      readonly invalidRecipient?: boolean;
    };

export interface SmsSender {
  readonly name: string;
  send(to: string, text: string): Promise<SendResult>;
}

/** No SMS provider yet (EXT-10): every text fails, visibly, and the operator alarm says so. */
export const noSms: SmsSender = {
  name: 'none',
  send: () => Promise.resolve({ ok: false, retryable: false, code: 'SMS_NOT_CONFIGURED' }),
};

/** Tests only (config.ts refuses it in production): keeps every text in memory. */
export class MemorySms implements SmsSender {
  readonly name = 'memory';
  readonly sent: { to: string; text: string }[] = [];
  failWith: string | null = null;

  send(to: string, text: string): Promise<SendResult> {
    if (this.failWith) return Promise.resolve({ ok: false, retryable: true, code: this.failWith });
    this.sent.push({ to, text });
    return Promise.resolve({ ok: true, providerMessageId: `memory-${this.sent.length}` });
  }
}

export type Providers = {
  /** The key browsers subscribe with; null until the environment has VAPID keys (nobody can subscribe). */
  readonly vapidPublicKey: string | null;
  /** Null without the private key: in the API, which never sends, and until the keys exist. */
  readonly webPush: WebPushSender | null;
  /** Null until the environment has a Firebase service account (D-26). */
  readonly fcm: FcmSender | null;
  readonly sms: SmsSender;
};

export function createProviders(config: Config, nowS: () => number): Providers {
  const vapid = config.WEB_PUSH_VAPID_PRIVATE_KEY_PEM
    ? vapidKeysFromPem(config.WEB_PUSH_VAPID_PRIVATE_KEY_PEM)
    : config.WEB_PUSH_VAPID_PUBLIC_KEY && config.WEB_PUSH_VAPID_PRIVATE_KEY
      ? { publicKey: config.WEB_PUSH_VAPID_PUBLIC_KEY, privateKey: config.WEB_PUSH_VAPID_PRIVATE_KEY }
      : null;
  const webPush = vapid
    ? createWebPushSender({
        keys: vapid,
        // RFC 8292: a contact for the push service; the dashboard's own address.
        subject: new URL(config.PUBLIC_ORIGIN).origin,
        nowS,
      })
    : null;
  const fcm = config.FCM_SERVICE_ACCOUNT
    ? createFcmSender({ serviceAccountJson: config.FCM_SERVICE_ACCOUNT, nowS })
    : null;
  const sms = config.SMS_PROVIDER === 'memory' ? new MemorySms() : noSms;
  const vapidPublicKey =
    vapid?.publicKey ??
    (config.WEB_PUSH_VAPID_PUBLIC_KEY_PEM
      ? vapidPublicKeyFromPem(config.WEB_PUSH_VAPID_PUBLIC_KEY_PEM)
      : (config.WEB_PUSH_VAPID_PUBLIC_KEY ?? null));
  return { vapidPublicKey, webPush, fcm, sms };
}
