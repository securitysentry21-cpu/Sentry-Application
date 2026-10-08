// ARCH §15.1 error envelope. Responses carry a code, a plain message and the request ID — never a
// stack trace or internal detail.
import { ERROR_CODES, type ErrorCode, type ErrorEnvelope } from '@sentryops/contracts';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export type ErrorDetail = { path: string; issue: string };

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.code = code;
    this.status = ERROR_CODES[code].http;
    this.details = details;
  }
}

export function envelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ErrorDetail[],
): ErrorEnvelope {
  return { error: { code, message, requestId, ...(details ? { details } : {}) } };
}

export function errorHandler(error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AppError) {
    return reply.code(error.status).send(envelope(error.code, error.message, request.id, error.details));
  }
  if (error.statusCode === 400 || error.validation) {
    return reply.code(400).send(envelope('VALIDATION_FAILED', 'The request is invalid.', request.id));
  }
  request.log.error({ err: error }, 'unhandled error');
  return reply.code(500).send(envelope('INTERNAL_ERROR', 'Something went wrong.', request.id));
}
