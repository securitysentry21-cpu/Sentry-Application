// ARCH §15.1 error envelope. Responses carry a code, a plain message and the request ID — never a
// stack trace or internal detail.
import { ERROR_CODES, type ErrorCode, type ErrorEnvelope } from '@sentryops/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

export type ErrorDetail = { path: string; issue: string };

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;
  /** For RATE_LIMITED: seconds until the next attempt may succeed (Retry-After). */
  readonly retryAfterS: number | undefined;
  /** For VERSION_CONFLICT: the current resource, returned with the error (ARCH §15.1). */
  readonly current: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    details?: ErrorDetail[],
    retryAfterS?: number,
    current?: unknown,
  ) {
    super(message);
    this.code = code;
    this.status = ERROR_CODES[code].http;
    this.details = details;
    this.retryAfterS = retryAfterS;
    this.current = current;
  }
}

export const notFound = () => new AppError('NOT_FOUND', 'Not found.');
export const forbidden = () => new AppError('FORBIDDEN', 'You do not have permission to do that.');

export function envelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ErrorDetail[],
): ErrorEnvelope {
  return { error: { code, message, requestId, ...(details ? { details } : {}) } };
}

/** zod issues → envelope details. Paths only, never the rejected values (they may be secrets). */
export function validationError(error: z.ZodError): AppError {
  const details = error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join('.') || '(root)',
    issue: issue.message,
  }));
  return new AppError('VALIDATION_FAILED', 'The request is invalid.', details);
}

// Fable pass 2, review L-27 (and docs/testing/load-baseline.md, note 4): a database the API cannot
// reach, a connection pool with none free, or a server refusing new connections is "dependency
// unavailable": 503 NOT_READY (ARCH §15.1, Appendix B), not 500. The phone retries both; 503 lets an
// alarm or a reader of the log tell "saturated" from "bug". pg gives its own timeouts no code.
const UNAVAILABLE_MESSAGES = new Set([
  'timeout exceeded when trying to connect', // pg-pool: no connection free within connectionTimeoutMillis
  'timeout expired', // pg: a new connection not established in time
  'Connection terminated unexpectedly', // pg: the server went away
]);
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (starting, failing over)
  '08000', // connection_exception
  '08001',
  '08003',
  '08004',
  '08006',
  '28P01', // invalid_password: the window of a password rotation (runbook 05)
]);
/** Seconds a phone's ordinary uploads wait before trying again; SOS gets no Retry-After. */
export const UNAVAILABLE_RETRY_AFTER_S = 5;

export function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return UNAVAILABLE_MESSAGES.has(error.message) || (typeof code === 'string' && UNAVAILABLE_CODES.has(code));
}

export function errorHandler(error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) {
  if (!(error instanceof AppError) && databaseUnavailable(error)) {
    request.log.warn({ err: error }, 'database unavailable');
    // The phone's SOS lane retries on its own short backoff (2 s, with jitter); a Retry-After would
    // only hold an SOS back (INV-15).
    if (!request.routeOptions.config.policy?.sos) {
      void reply.header('retry-after', String(UNAVAILABLE_RETRY_AFTER_S));
    }
    return reply
      .code(503)
      .send(envelope('NOT_READY', 'The service is busy. Try again in a moment.', request.id));
  }
  if (error instanceof AppError) {
    if (error.retryAfterS !== undefined) void reply.header('retry-after', String(error.retryAfterS));
    const body = envelope(error.code, error.message, request.id, error.details);
    return reply
      .code(error.status)
      .send(error.current === undefined ? body : { ...body, current: error.current });
  }
  if (error.statusCode === 400 || error.validation) {
    return reply.code(400).send(envelope('VALIDATION_FAILED', 'The request is invalid.', request.id));
  }
  if (error.statusCode === 413) {
    return reply.code(400).send(envelope('VALIDATION_FAILED', 'The request is too large.', request.id));
  }
  request.log.error({ err: error }, 'unhandled error');
  return reply.code(500).send(envelope('INTERNAL_ERROR', 'Something went wrong.', request.id));
}
