// What can go wrong talking to the API, as types the sync engine and screens can act on.
// Messages never include response bodies, tokens or request data (SEC §15).
import type { ErrorCode } from '@sentryops/contracts';

/** No HTTP response at all: offline, DNS, TLS, timeout, connection reset. Nothing was confirmed. */
export class NetworkError extends Error {
  override name = 'NetworkError';
  readonly kind: 'TIMEOUT' | 'NETWORK';
  constructor(kind: 'TIMEOUT' | 'NETWORK') {
    super(kind === 'TIMEOUT' ? 'request timed out' : 'network request failed');
    this.kind = kind;
  }
}

/** The server answered with an error status. `code` comes from the ARCH §15.1 envelope when present. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: ErrorCode | null;
  readonly requestId: string | null;
  /** From Retry-After on 429 and 503, in ms. */
  readonly retryAfterMs: number | null;
  constructor(status: number, code: ErrorCode | null, requestId: string | null, retryAfterMs: number | null) {
    super(`HTTP ${status}${code ? ` ${code}` : ''}`);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
  }

  get transient(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** A 2xx response whose body does not match the contract. Treated like no response: nothing is deleted. */
export class ProtocolError extends Error {
  override name = 'ProtocolError';
  readonly status: number;
  constructor(status: number) {
    super(`response ${status} does not match the contract`);
    this.status = status;
  }
}

export type SignedOutReason = 'REVOKED' | 'DEVICE_REVOKED' | 'EXPIRED' | 'NO_SESSION';

/** The session cannot be used or renewed. The queue is kept (ARCH §5.3). */
export class SignedOutError extends Error {
  override name = 'SignedOutError';
  readonly reason: SignedOutReason;
  constructor(reason: SignedOutReason) {
    super(`signed out: ${reason}`);
    this.reason = reason;
  }
}

export const isAuthRejection = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.status === 401 ||
    (error.status === 403 && (error.code === 'DEVICE_REVOKED' || error.code === 'DEVICE_NOT_REGISTERED')));
