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

export function errorHandler(error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) {
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
