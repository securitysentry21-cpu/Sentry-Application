// Firebase Cloud Messaging, HTTP v1 (D-26: direct, no Expo push service in between). The service
// account signs a JWT for an OAuth access token, cached until shortly before it expires.
import { createPrivateKey, sign } from 'node:crypto';

import type { SendResult } from './providers.ts';

type Fetch = typeof fetch;

export interface FcmSender {
  send(input: {
    token: string;
    title: string;
    body: string;
    data: Readonly<Record<string, string>>;
    urgent: boolean;
  }): Promise<SendResult>;
}

type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri: string };

export function createFcmSender(options: {
  serviceAccountJson: string;
  nowS: () => number;
  fetcher?: Fetch;
}): FcmSender {
  const fetcher = options.fetcher ?? fetch;
  const account = JSON.parse(options.serviceAccountJson) as Partial<ServiceAccount>;
  if (!account.project_id || !account.client_email || !account.private_key) {
    throw new Error('FCM_SERVICE_ACCOUNT is not a service account key');
  }
  const key = createPrivateKey(account.private_key);
  const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
  let cached: { token: string; expiresAtS: number } | null = null;

  async function accessToken(): Promise<string> {
    const now = options.nowS();
    if (cached && cached.expiresAtS - now > 300) return cached.token;
    const b64u = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })}`;
    const assertion = `${unsigned}.${sign('sha256', Buffer.from(unsigned), key).toString('base64url')}`;
    const response = await fetcher(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`FCM token: HTTP ${response.status}`);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('FCM token: none returned');
    cached = { token: body.access_token, expiresAtS: now + (body.expires_in ?? 3600) };
    return body.access_token;
  }

  return {
    async send(input) {
      let token: string;
      try {
        token = await accessToken();
      } catch {
        return { ok: false, retryable: true, code: 'FCM_AUTH' };
      }
      let response: Response;
      try {
        response = await fetcher(
          `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              message: {
                token: input.token,
                notification: { title: input.title, body: input.body },
                data: input.data,
                android: { priority: input.urgent ? 'HIGH' : 'NORMAL' },
              },
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch {
        return { ok: false, retryable: true, code: 'NETWORK' };
      }
      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { name?: string };
        return { ok: true, providerMessageId: body.name?.slice(0, 300) ?? null };
      }
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) cached = null;
      // UNREGISTERED and INVALID_ARGUMENT tokens never come back (ARCH §13.4: deactivate them).
      if (response.status === 404 || response.status === 400) {
        return { ok: false, retryable: false, code: `HTTP_${response.status}`, invalidRecipient: true };
      }
      return {
        ok: false,
        retryable: response.status === 401 || response.status === 429 || response.status >= 500,
        code: `HTTP_${response.status}`,
      };
    },
  };
}
