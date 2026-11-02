// Web Push for the dashboard (D-26): message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292),
// on node:crypto, checked against RFC 8291's worked example (test/notify.test.ts). The browser's
// push service only ever sees ciphertext; the payload is lock-screen safe anyway (PROD §13).
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
} from 'node:crypto';

import type { SendResult } from './providers.ts';

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
const b64u = (b: Buffer) => b.toString('base64url');

/** RFC 8291 §3.4: one record, the whole payload, with the last-record delimiter. */
export function encryptPayload(input: {
  plaintext: Buffer;
  /** The subscription's `p256dh`: the browser's P-256 public key, uncompressed (65 bytes). */
  uaPublic: Buffer;
  /** The subscription's `auth` secret (16 bytes). */
  authSecret: Buffer;
  /** Test seams: RFC 8291's example fixes these; otherwise they are fresh for every message. */
  asPrivate?: Buffer;
  salt?: Buffer;
}): Buffer {
  if (input.uaPublic.length !== 65 || input.uaPublic[0] !== 0x04) throw new RangeError('bad p256dh key');
  if (input.authSecret.length !== 16) throw new RangeError('bad auth secret');
  const ecdh = createECDH('prime256v1');
  if (input.asPrivate) ecdh.setPrivateKey(input.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(input.uaPublic);
  const salt = input.salt ?? randomBytes(16);

  // PRK_key = HMAC(auth, ecdh); IKM = HMAC(PRK_key, "WebPush: info\0" ‖ ua ‖ as ‖ 0x01)
  const prkKey = hmac(input.authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'latin1'),
    input.uaPublic,
    asPublic,
    Buffer.from([1]),
  ]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([input.plaintext, Buffer.from([2])])),
    cipher.final(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext, cipher.getAuthTag()]);
}

export type VapidKeys = { readonly publicKey: string; readonly privateKey: string };

/** The raw public key (65 bytes, base64url) from a P-256 public key in PEM. */
export function vapidPublicKeyFromPem(pem: string): string {
  const jwk = createPublicKey(pem).export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y)
    throw new RangeError('VAPID keys are P-256');
  return b64u(
    Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]),
  );
}

/** The key pair from a P-256 private key in PEM, which is what Terraform's tls_private_key makes. */
export function vapidKeysFromPem(pem: string): VapidKeys {
  const jwk = createPrivateKey(pem).export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y)
    throw new RangeError('VAPID keys are P-256');
  const publicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return { publicKey: b64u(publicKey), privateKey: jwk.d };
}

/** RFC 8292: `Authorization: vapid t=<JWT>, k=<public key>`, the JWT signed ES256 for the push service's origin. */
export function vapidAuthorization(input: {
  endpoint: string;
  keys: VapidKeys;
  subject: string;
  nowS: number;
}): string {
  const pub = Buffer.from(input.keys.publicKey, 'base64url');
  const priv = Buffer.from(input.keys.privateKey, 'base64url');
  if (pub.length !== 65 || priv.length !== 32) throw new RangeError('bad VAPID keys');
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64u(priv),
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: new URL(input.endpoint).origin,
        exp: input.nowS + 12 * 3600,
        sub: input.subject,
      }),
    ),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${input.keys.publicKey}`;
}

/**
 * Push services the sender may call. A subscription names its own endpoint, so without this list a
 * signed-in user could make the server call any address (SSRF).
 */
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.port === '' && PUSH_SERVICE_HOSTS.some((h) => h.test(url.hostname));
}

export interface WebPushSender {
  readonly publicKey: string;
  send(input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    payload: string;
    urgency: 'high' | 'normal';
    ttlS: number;
  }): Promise<SendResult>;
}

type Fetch = typeof fetch;

export function createWebPushSender(options: {
  keys: VapidKeys;
  subject: string;
  nowS: () => number;
  fetcher?: Fetch;
}): WebPushSender {
  const fetcher = options.fetcher ?? fetch;
  return {
    publicKey: options.keys.publicKey,
    async send(input) {
      if (!isPushServiceEndpoint(input.endpoint)) {
        return { ok: false, retryable: false, code: 'ENDPOINT_NOT_ALLOWED', invalidRecipient: true };
      }
      let body: Buffer;
      try {
        body = encryptPayload({
          plaintext: Buffer.from(input.payload, 'utf8'),
          uaPublic: Buffer.from(input.p256dh, 'base64url'),
          authSecret: Buffer.from(input.auth, 'base64url'),
        });
      } catch {
        return { ok: false, retryable: false, code: 'BAD_SUBSCRIPTION_KEYS', invalidRecipient: true };
      }
      let response: Response;
      try {
        response = await fetcher(input.endpoint, {
          method: 'POST',
          headers: {
            authorization: vapidAuthorization({
              endpoint: input.endpoint,
              keys: options.keys,
              subject: options.subject,
              nowS: options.nowS(),
            }),
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(input.ttlS),
            urgency: input.urgency,
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return { ok: false, retryable: true, code: 'NETWORK' };
      }
      await response.body?.cancel().catch(() => {});
      if (response.status === 201 || response.status === 200 || response.status === 202) {
        return { ok: true, providerMessageId: response.headers.get('location')?.slice(0, 300) ?? null };
      }
      if (response.status === 404 || response.status === 410) {
        return { ok: false, retryable: false, code: `HTTP_${response.status}`, invalidRecipient: true };
      }
      return {
        ok: false,
        retryable: response.status === 429 || response.status >= 500,
        code: `HTTP_${response.status}`,
      };
    },
  };
}
