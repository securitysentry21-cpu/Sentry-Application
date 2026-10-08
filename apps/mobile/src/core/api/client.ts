// The API client (ARCH §15). Every request carries X-App-Version, X-Platform, X-Request-Id and, once
// enrolled, X-Device-Id; authenticated ones carry `Authorization: Bearer` (or, for an SOS whose
// session has expired, X-Device-Signature). Every response body is parsed with the shared contract
// schemas, so a response the phone does not understand is never mistaken for a success.
import {
  enrollmentRedeemResponseSchema,
  errorEnvelopeSchema,
  meShiftsResponseSchema,
  mobileConfigSchema,
  sessionRefreshResponseSchema,
  sosResponseSchema,
  syncBatchResponseSchema,
  type EnrollmentRedeemRequest,
  type EnrollmentRedeemResponse,
  type ErrorCode,
  type MobileConfig,
  type SessionTokens,
  type SyncBatchRequest,
  type SyncBatchResponse,
} from '@sentryops/contracts';
import type { z } from 'zod';

import type { IdFactory } from '../ids.ts';
import type { Logger } from '../log.ts';
import type { ServerTime } from '../server-time.ts';
import { parseRetryAfterMs } from '../sync/backoff.ts';
import type { WallClock } from '../time.ts';
import { ApiError, NetworkError, ProtocolError } from './errors.ts';
import type { HttpMethod, HttpTransport } from './http.ts';

export const API_PREFIX = '/api/v1';

export type Platform = 'ANDROID' | 'IOS';
export type AppInfo = { readonly version: string; readonly platform: Platform };

export type Auth =
  | { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'device-signature'; readonly signature: string };

export type MeShifts = z.infer<typeof meShiftsResponseSchema>;
export type SosResponse = z.infer<typeof sosResponseSchema>;

export type ApiClientDeps = {
  /** Origin only, e.g. https://api.example.com or http://10.0.2.2:4000 (validated in config.ts). */
  readonly baseUrl: string;
  readonly transport: HttpTransport;
  readonly app: AppInfo;
  readonly ids: IdFactory;
  readonly wall: WallClock;
  readonly serverTime: ServerTime;
  readonly logger: Logger;
  readonly deviceId: () => string | null;
  /** Called after each response that carried X-Server-Time (so the offset can be persisted). */
  readonly onServerTime?: (offsetMs: number) => void;
};

const TIMEOUT = { default: 20_000, sync: 30_000, sos: 15_000 } as const;

export class ApiClient {
  readonly #deps: ApiClientDeps;

  constructor(deps: ApiClientDeps) {
    this.#deps = deps;
  }

  /** Sends one request and returns the parsed body, or throws NetworkError / ApiError / ProtocolError. */
  async request<T>(
    method: HttpMethod,
    path: string,
    options: {
      auth: Auth;
      /** Pre-serialized JSON body: what is sent is exactly what was signed. */
      bodyText?: string;
      schema: z.ZodType<T> | null;
      timeoutMs?: number;
    },
  ): Promise<T> {
    const { transport, app, ids, wall, serverTime, logger } = this.#deps;
    const requestId = ids.uuidv7();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-App-Version': app.version,
      'X-Platform': app.platform,
      'X-Request-Id': requestId,
    };
    const deviceId = this.#deps.deviceId();
    if (deviceId) headers['X-Device-Id'] = deviceId;
    if (options.bodyText !== undefined) headers['Content-Type'] = 'application/json';
    if (options.auth.kind === 'bearer') headers.Authorization = `Bearer ${options.auth.token}`;
    if (options.auth.kind === 'device-signature') headers['X-Device-Signature'] = options.auth.signature;

    const sentAt = wall.nowMs();
    let response;
    try {
      response = await transport({
        method,
        url: `${this.#deps.baseUrl}${API_PREFIX}${path}`,
        headers,
        ...(options.bodyText === undefined ? {} : { body: options.bodyText }),
        timeoutMs: options.timeoutMs ?? TIMEOUT.default,
      });
    } catch (error) {
      const failure = error instanceof NetworkError ? error : new NetworkError('NETWORK');
      logger.info('api.no-response', { requestId, errorKind: failure.kind });
      throw failure;
    }
    const receivedAt = wall.nowMs();
    serverTime.observe(response.header('X-Server-Time'), sentAt, receivedAt);
    if (serverTime.offsetMs !== null) this.#deps.onServerTime?.(serverTime.offsetMs);
    const durationMs = Math.max(0, receivedAt - sentAt);

    if (response.status < 200 || response.status >= 300) {
      const code = parseErrorCode(response.text);
      const retryAfterMs = parseRetryAfterMs(response.header('Retry-After'), receivedAt);
      logger.info('api.error', {
        requestId,
        httpStatus: response.status,
        errorCode: code ?? 'NONE',
        durationMs,
      });
      throw new ApiError(response.status, code, response.header('X-Request-Id') ?? requestId, retryAfterMs);
    }
    logger.debug('api.ok', { requestId, httpStatus: response.status, durationMs });
    if (options.schema === null) return undefined as T;
    let json: unknown;
    try {
      json = JSON.parse(response.text);
    } catch {
      throw new ProtocolError(response.status);
    }
    const parsed = options.schema.safeParse(json);
    if (!parsed.success) {
      logger.warn('api.contract-mismatch', { requestId, httpStatus: response.status });
      throw new ProtocolError(response.status);
    }
    return parsed.data;
  }

  // ── Endpoints (base path /api/v1) ──────────────────────────────────────────────────────────

  redeemEnrollment(body: EnrollmentRedeemRequest): Promise<EnrollmentRedeemResponse> {
    return this.request('POST', '/enrollments/redeem', {
      auth: { kind: 'none' },
      bodyText: JSON.stringify(body),
      schema: enrollmentRedeemResponseSchema,
    });
  }

  async refreshSession(refreshToken: string): Promise<SessionTokens> {
    const response = await this.request('POST', '/sessions/refresh', {
      auth: { kind: 'none' },
      bodyText: JSON.stringify({ refreshToken }),
      schema: sessionRefreshResponseSchema,
    });
    return response.session;
  }

  getMobileConfig(token: string): Promise<MobileConfig> {
    return this.request('GET', '/mobile/config', {
      auth: { kind: 'bearer', token },
      schema: mobileConfigSchema,
    });
  }

  postTrackingConsent(
    token: string,
    body: { disclosureVersion: string; locale: 'en' | 'ur' },
  ): Promise<void> {
    return this.request('POST', '/tracking-consents', {
      auth: { kind: 'bearer', token },
      bodyText: JSON.stringify(body),
      schema: null,
    });
  }

  getMyShifts(token: string): Promise<MeShifts> {
    return this.request('GET', '/me/shifts', {
      auth: { kind: 'bearer', token },
      schema: meShiftsResponseSchema,
    });
  }

  syncBatch(token: string, body: SyncBatchRequest): Promise<SyncBatchResponse> {
    return this.request('POST', '/sync/batch', {
      auth: { kind: 'bearer', token },
      bodyText: JSON.stringify(body),
      schema: syncBatchResponseSchema,
      timeoutMs: TIMEOUT.sync,
    });
  }

  /** `bodyText` is sent byte for byte; with device-signature auth it is what was signed. */
  postSos(auth: Auth, bodyText: string): Promise<SosResponse> {
    return this.request('POST', '/sos', {
      auth,
      bodyText,
      schema: sosResponseSchema,
      timeoutMs: TIMEOUT.sos,
    });
  }
}

function parseErrorCode(text: string): ErrorCode | null {
  try {
    const parsed = errorEnvelopeSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error.code : null;
  } catch {
    return null;
  }
}
