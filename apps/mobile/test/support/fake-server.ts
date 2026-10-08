// A scripted stand-in for the API, speaking the same contract (packages/contracts). It checks what
// the phone sends with the shared zod schemas, so a test passes only if the phone's requests would
// pass the real server's validation; and it verifies device signatures with node:crypto.
import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';

import {
  type ErrorCode,
  type GuardShift,
  type MobileConfig,
  enrollmentRedeemRequestSchema,
  sessionRefreshRequestSchema,
  sosRequestSchema,
  syncBatchRequestSchema,
  syncItemSchema,
  trackingConsentRequestSchema,
  type SyncBatchRequest,
  type SyncItem,
  type SyncItemStatus,
} from '@sentryops/contracts';

import { NetworkError } from '../../src/core/api/errors.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/core/api/http.ts';
import { base64Decode } from '../../src/core/encoding.ts';

export const ORG_ID = '0190a0d2-7c5e-7000-8000-000000000001';
export const GUARD_A = '0190a0d2-7c5e-7000-8000-00000000000a';
export const GUARD_B = '0190a0d2-7c5e-7000-8000-00000000000b';
export const SHIFT_1 = '0190a0d2-7c5e-7000-8000-000000000101';
export const SHIFT_2 = '0190a0d2-7c5e-7000-8000-000000000102';
export const SITE_1 = '0190a0d2-7c5e-7000-8000-000000000201';

export type Mode =
  | { kind: 'online' }
  | { kind: 'offline' }
  | { kind: 'status'; status: number; code: ErrorCode; retryAfter?: string };

export type ItemDecision = { status: SyncItemStatus; code?: ErrorCode };

type Session = {
  guardId: string;
  deviceId: string;
  accessToken: string;
  accessExpiresAtMs: number;
  refreshToken: string;
  refreshExpiresAtMs: number;
};

type Enrollment = { code: string; phone: string; guardId: string; displayName: string };

const iso = (ms: number) => new Date(ms).toISOString();

export function testConfig(overrides: Partial<MobileConfig> = {}): MobileConfig {
  return {
    serverTime: '2026-10-08T15:00:00.000Z',
    minSupportedVersion: '0.1.0',
    recommendedVersion: '0.1.0',
    revokedVersions: [],
    disclosureVersion: '1',
    organization: { id: ORG_ID, name: 'Demo Security' },
    guard: { id: GUARD_A, displayName: 'Ahmed K.', preferredLocale: 'en' },
    tracking: {
      movingDistanceFilterM: 20,
      minIntervalS: 15,
      maxIntervalS: 60,
      stationaryFixIntervalS: 300,
      sosIntervalS: 10,
    },
    sync: { uploadIntervalS: 60, heartbeatIntervalS: 60, maxOfflineAgeHours: 168, maxBatchItems: 500 },
    shift: {
      earliestStartMinutes: 30,
      autoEndAfterMinutes: 60,
      startMaxFixAgeSeconds: 120,
      requireBackgroundPermission: 'BLOCK',
    },
    features: { sos: false, patrols: false, incidents: true },
    ...overrides,
  };
}

export function testShift(
  id: string,
  startsAtMs: number,
  hours = 8,
  status: GuardShift['status'] = 'SCHEDULED',
): GuardShift {
  return {
    id,
    status,
    startsAt: iso(startsAtMs),
    endsAt: iso(startsAtMs + hours * 3_600_000),
    startDeadlineAt: iso(startsAtMs + 2 * 3_600_000),
    actualStartedAt: null,
    actualEndedAt: null,
    site: {
      id: SITE_1,
      name: 'ABC Warehouse',
      timezone: 'Asia/Karachi',
      boundary: { kind: 'CIRCLE', center: { lat: 24.8607, lng: 67.0011 }, radiusM: 100 },
    },
    version: 1,
  };
}

export class FakeServer {
  readonly now: () => number;
  mode: Mode = { kind: 'online' };
  /** Per-path one-shot overrides: the next request to this path gets this mode. */
  readonly next = new Map<string, Mode>();
  /** Per-path lasting overrides (until deleted). */
  readonly pathModes = new Map<string, Mode>();
  config: MobileConfig = testConfig();
  shifts: GuardShift[] = [];
  readonly enrollments: Enrollment[] = [];
  readonly sessions: Session[] = [];
  readonly retiredRefreshTokens = new Set<string>();
  devicePublicKey: KeyObject | null = null;
  readonly devices = new Map<string, { guardId: string; status: 'ACTIVE' | 'REVOKED' }>();
  accessTtlMs = 15 * 60_000;
  refreshTtlMs = 14 * 24 * 3_600_000;
  /** Accepted (or quarantined) items by clientEventId: the server's idempotency table. */
  readonly stored = new Map<string, SyncItem>();
  /** Every batch request that reached the server, in order. */
  readonly batches: SyncBatchRequest[] = [];
  /** The guard whose session carried each entry of `batches`. */
  readonly batchGuards: string[] = [];
  readonly sos = new Map<string, { sosEventId: string; auth: 'bearer' | 'signature' }>();
  readonly requests: { method: string; path: string; headers: Record<string, string> }[] = [];
  readonly consents: { disclosureVersion: string; locale: string; guardId: string }[] = [];
  /** How each new item is answered. Default: SHIFT_START activates the shift, everything ACCEPTED. */
  decide: (item: SyncItem) => ItemDecision = () => ({ status: 'ACCEPTED' });
  #counter = 0;
  #inFlight = 0;
  maxConcurrentBatches = 0;
  /** Resolves batch responses later when set (to observe in-flight behaviour). */
  gate: Promise<void> | null = null;

  constructor(now: () => number) {
    this.now = now;
  }

  #id(): string {
    this.#counter++;
    return `0190a0d2-7c5e-7000-8000-${String(this.#counter).padStart(12, '0')}`;
  }

  addEnrollment(code: string, phone: string, guardId = GUARD_A, displayName = 'Ahmed K.'): void {
    this.enrollments.push({ code, phone, guardId, displayName });
  }

  /** Revokes every session (as when an admin disables the guard). */
  revokeAll(): void {
    for (const s of this.sessions) s.refreshExpiresAtMs = 0;
    for (const s of this.sessions) s.accessExpiresAtMs = 0;
  }

  /** Paths whose next response is lost after the server processed the request (a dropped connection). */
  readonly loseResponse = new Set<string>();

  readonly transport: HttpTransport = async (request) => {
    const path = new URL(request.url).pathname;
    const response = await this.#handle(request, path);
    if (this.loseResponse.delete(path)) throw new NetworkError('NETWORK');
    return response;
  };

  async #handle(request: HttpRequest, path: string): Promise<HttpResponse> {
    this.requests.push({ method: request.method, path, headers: { ...request.headers } });
    const mode = this.next.get(path) ?? this.pathModes.get(path) ?? this.mode;
    this.next.delete(path);
    if (mode.kind === 'offline') throw new NetworkError('NETWORK');
    if (
      !request.headers['X-App-Version'] ||
      !request.headers['X-Platform'] ||
      !request.headers['X-Request-Id']
    ) {
      return this.#error(400, 'VALIDATION_FAILED');
    }
    if (mode.kind === 'status') {
      return this.#error(mode.status, mode.code, mode.retryAfter ? { 'Retry-After': mode.retryAfter } : {});
    }
    switch (`${request.method} ${path}`) {
      case 'POST /api/v1/enrollments/redeem':
        return this.#redeem(request);
      case 'POST /api/v1/sessions/refresh':
        return this.#refresh(request);
      case 'GET /api/v1/mobile/config':
        return this.#authed(request, () => this.#json(200, { ...this.config, serverTime: iso(this.now()) }));
      case 'POST /api/v1/tracking-consents':
        return this.#authed(request, (session) => {
          const body = trackingConsentRequestSchema.safeParse(JSON.parse(request.body ?? '{}'));
          if (!body.success) return this.#error(400, 'VALIDATION_FAILED');
          this.consents.push({ ...body.data, guardId: session.guardId });
          return this.#json(201, { recorded: true });
        });
      case 'GET /api/v1/me/shifts':
        return this.#authed(request, () =>
          this.#json(200, { serverTime: iso(this.now()), shifts: this.shifts }),
        );
      case 'POST /api/v1/sync/batch':
        return this.#authed(request, (session) => this.#batch(request, session));
      case 'POST /api/v1/sos':
        return this.#sos(request);
      default:
        return this.#error(404, 'NOT_FOUND');
    }
  }

  #response(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
    const all: Record<string, string> = { 'x-server-time': iso(this.now()), ...lower(headers) };
    return { status, header: (name) => all[name.toLowerCase()] ?? null, text: JSON.stringify(body) };
  }

  #json(status: number, body: unknown): HttpResponse {
    return this.#response(status, body);
  }

  #error(status: number, code: ErrorCode, headers: Record<string, string> = {}): HttpResponse {
    return this.#response(status, { error: { code, message: code, requestId: 'test' } }, headers);
  }

  #session(guardId: string, deviceId: string): Session {
    const session: Session = {
      guardId,
      deviceId,
      accessToken: `access-${this.#id()}`,
      accessExpiresAtMs: this.now() + this.accessTtlMs,
      refreshToken: `refresh-${this.#id()}-0123456789abcdef`,
      refreshExpiresAtMs: this.now() + this.refreshTtlMs,
    };
    this.sessions.push(session);
    return session;
  }

  #tokens(s: Session) {
    return {
      accessToken: s.accessToken,
      accessTokenExpiresAt: iso(s.accessExpiresAtMs),
      refreshToken: s.refreshToken,
      refreshTokenExpiresAt: iso(s.refreshExpiresAtMs),
    };
  }

  #redeem(request: HttpRequest): HttpResponse {
    const body = enrollmentRedeemRequestSchema.safeParse(JSON.parse(request.body ?? '{}'));
    if (!body.success) return this.#error(400, 'VALIDATION_FAILED');
    const enrollment = this.enrollments.find((e) => e.code === body.data.code && e.phone === body.data.phone);
    if (!enrollment) return this.#error(422, 'ENROLLMENT_CODE_INVALID');
    this.enrollments.splice(this.enrollments.indexOf(enrollment), 1); // single use
    this.devicePublicKey = createPublicKey({
      key: Buffer.from(base64Decode(body.data.publicKey)),
      format: 'der',
      type: 'spki',
    });
    const deviceId = this.#id();
    this.devices.set(deviceId, { guardId: enrollment.guardId, status: 'ACTIVE' });
    const session = this.#session(enrollment.guardId, deviceId);
    return this.#json(201, {
      deviceId,
      guard: { id: enrollment.guardId, displayName: enrollment.displayName, preferredLocale: 'en' },
      organization: { id: ORG_ID, name: 'Demo Security' },
      session: this.#tokens(session),
    });
  }

  #refresh(request: HttpRequest): HttpResponse {
    const body = sessionRefreshRequestSchema.safeParse(JSON.parse(request.body ?? '{}'));
    if (!body.success) return this.#error(400, 'VALIDATION_FAILED');
    if (this.retiredRefreshTokens.has(body.data.refreshToken)) {
      // Reuse of a rotated token revokes the whole session (ARCH §5.3).
      for (const s of this.sessions) s.refreshExpiresAtMs = 0;
      return this.#error(401, 'UNAUTHENTICATED');
    }
    const session = this.sessions.find((s) => s.refreshToken === body.data.refreshToken);
    if (!session || session.refreshExpiresAtMs <= this.now()) return this.#error(401, 'UNAUTHENTICATED');
    this.retiredRefreshTokens.add(session.refreshToken);
    session.accessToken = `access-${this.#id()}`;
    session.accessExpiresAtMs = this.now() + this.accessTtlMs;
    session.refreshToken = `refresh-${this.#id()}-0123456789abcdef`;
    return this.#json(200, { session: this.#tokens(session) });
  }

  #findSession(request: HttpRequest): Session | null {
    const auth = request.headers.Authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return null;
    const session = this.sessions.find((s) => s.accessToken === token);
    if (!session || session.accessExpiresAtMs <= this.now()) return null;
    return session;
  }

  #authed(request: HttpRequest, handler: (session: Session) => HttpResponse | Promise<HttpResponse>) {
    const session = this.#findSession(request);
    if (!session) return this.#error(401, 'UNAUTHENTICATED');
    const deviceId = request.headers['X-Device-Id'];
    if (!deviceId || deviceId !== session.deviceId) return this.#error(403, 'DEVICE_NOT_REGISTERED');
    if (this.devices.get(deviceId)?.status === 'REVOKED') return this.#error(403, 'DEVICE_REVOKED');
    return handler(session);
  }

  async #batch(request: HttpRequest, session: Session): Promise<HttpResponse> {
    const parsed = syncBatchRequestSchema.safeParse(JSON.parse(request.body ?? '{}'));
    if (!parsed.success) return this.#error(400, 'VALIDATION_FAILED');
    this.batches.push(parsed.data);
    this.batchGuards.push(session.guardId);
    this.#inFlight++;
    this.maxConcurrentBatches = Math.max(this.maxConcurrentBatches, this.#inFlight);
    try {
      if (this.gate) await this.gate;
      const results: { clientEventId: string; status: SyncItemStatus; code?: ErrorCode }[] = [];
      const touched = new Set<string>();
      for (const raw of parsed.data.items) {
        const item = syncItemSchema.safeParse(raw);
        const clientEventId = (raw as { clientEventId?: string }).clientEventId ?? 'unknown';
        if (!item.success) {
          results.push({ clientEventId, status: 'REJECTED', code: 'VALIDATION_FAILED' });
          continue;
        }
        if (this.stored.has(item.data.clientEventId)) {
          results.push({ clientEventId, status: 'DUPLICATE' });
          continue;
        }
        const decision = this.decide(item.data);
        if (decision.status === 'ACCEPTED' || decision.status === 'QUARANTINED') {
          this.stored.set(item.data.clientEventId, item.data);
        }
        if (decision.status === 'ACCEPTED') this.#applyToShift(item.data, session);
        if (item.data.shiftId) touched.add(item.data.shiftId);
        results.push({
          clientEventId,
          status: decision.status,
          ...(decision.code ? { code: decision.code } : {}),
        });
      }
      const shifts = this.shifts
        .filter((s) => touched.has(s.id))
        .map((s) => ({ shiftId: s.id, status: s.status, endsAt: s.endsAt }));
      return this.#json(200, { serverTime: iso(this.now()), results, shifts });
    } finally {
      this.#inFlight--;
    }
  }

  #applyToShift(item: SyncItem, _session: Session): void {
    const shift = this.shifts.find((s) => s.id === item.shiftId);
    if (!shift) return;
    if (item.type === 'SHIFT_START' && (shift.status === 'SCHEDULED' || shift.status === 'MISSED')) {
      this.setShiftStatus(shift.id, 'ACTIVE');
    }
    if (item.type === 'SHIFT_END' && shift.status === 'ACTIVE') this.setShiftStatus(shift.id, 'COMPLETED');
  }

  setShiftStatus(shiftId: string, status: GuardShift['status'], endsAtMs?: number): void {
    this.shifts = this.shifts.map((s) =>
      s.id === shiftId ? { ...s, status, ...(endsAtMs === undefined ? {} : { endsAt: iso(endsAtMs) }) } : s,
    );
  }

  #sos(request: HttpRequest): HttpResponse {
    const bodyText = request.body ?? '';
    const parsed = sosRequestSchema.safeParse(JSON.parse(bodyText || '{}'));
    if (!parsed.success) return this.#error(400, 'VALIDATION_FAILED');
    let auth: 'bearer' | 'signature';
    if (this.#findSession(request)) {
      auth = 'bearer';
    } else if (request.headers['X-Device-Signature'] && this.#signatureValid(request, bodyText)) {
      auth = 'signature';
    } else {
      return this.#error(401, 'UNAUTHENTICATED');
    }
    const existing = this.sos.get(parsed.data.clientEventId);
    const sosEventId = existing?.sosEventId ?? this.#id();
    this.sos.set(parsed.data.clientEventId, { sosEventId, auth });
    return this.#json(200, { sosEventId, status: 'RECEIVED', serverTime: iso(this.now()) });
  }

  /** The verification the real server must do for X-Device-Signature (v1). */
  #signatureValid(request: HttpRequest, bodyText: string): boolean {
    const key = this.devicePublicKey;
    const deviceId = request.headers['X-Device-Id'];
    if (!key || !deviceId || this.devices.get(deviceId)?.status !== 'ACTIVE') return false;
    const [version, timestamp, signature] = (request.headers['X-Device-Signature'] ?? '').split('.');
    if (version !== 'v1' || !timestamp || !signature) return false;
    if (Math.abs(Number(timestamp) - this.now()) > 5 * 60_000) return false;
    const bodyHash = createHash('sha256').update(bodyText, 'utf8').digest('base64url');
    const data = `v1\n${request.method}\n${new URL(request.url).pathname}\n${timestamp}\n${bodyHash}`;
    return verify(
      'sha256',
      Buffer.from(data, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
  }
}

function lower(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
