// SEC §15: never log or send to error tracking: tokens, OTPs, passwords, invitation and enrollment
// codes, QR tokens, precise coordinates, incident text, photos, phone numbers. Use IDs instead.
// The redaction list is unit-tested (test/logger.test.ts).
import type { LoggerOptions } from 'pino';

const SENSITIVE_KEYS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'otp',
  'code',
  'enrollmentCode',
  'invitationToken',
  'qrToken',
  'lat',
  'lon',
  'latitude',
  'longitude',
  'fix',
  'title',
  'description',
  'body',
  'note',
  'phone',
];

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-device-signature"]',
  'res.headers["set-cookie"]',
  // Pino matches one level per wildcard, so cover top-level and one-level-nested fields.
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
];

// Error codes are identifiers: a PostgreSQL SQLSTATE (23514), a Node code (ECONNREFUSED), a
// Fastify code (FST_ERR_…). Anything else in `code` is not logged.
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
// Schema names a PostgreSQL error carries (constraint, table, column): identifiers, never values.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

// Review L-31: a PostgreSQL data exception (SQLSTATE class 22) quotes the input in its message:
// `invalid input syntax for type integer: "+923001234567"`. Its message is replaced by the
// condition's name. Class 23 (constraints) names only constraints, tables and columns; the values
// are in `detail`, which is never logged.
const DATA_EXCEPTION = /^22[0-9A-Z]{3}$/;
const DATA_EXCEPTION_NAMES: Readonly<Record<string, string>> = {
  '22001': 'string_data_right_truncation',
  '22003': 'numeric_value_out_of_range',
  '22004': 'null_value_not_allowed',
  '22007': 'invalid_datetime_format',
  '22008': 'datetime_field_overflow',
  '22012': 'division_by_zero',
  '22021': 'character_not_in_repertoire',
  '22023': 'invalid_parameter_value',
  '22P02': 'invalid_text_representation',
  '22P05': 'untranslatable_character',
};

/**
 * Review L-04: an error is logged by an allow-list of fields, never by copying it. A PostgreSQL
 * error's `detail` ("Failing row contains (…, 24.8607, 67.0011, +92…)"), `where`, `internalQuery`
 * and `hint` can hold row values, and pino's standard serializer would copy every one of them.
 * The SQLSTATE is kept as `errorCode`, since `code` is a redacted key.
 */
export function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: typeof error };
  const fields = error as unknown as Record<string, unknown>;
  const type = error.constructor.name || 'Error';
  const out: Record<string, unknown> = { type, message: error.message, stack: error.stack };
  if (typeof fields.code === 'string' && DATA_EXCEPTION.test(fields.code)) {
    const message = DATA_EXCEPTION_NAMES[fields.code] ?? 'data_exception';
    // The stack's first line repeats the message; only the frames are kept.
    const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
    out.message = message;
    out.stack = [`${type}: ${message}`, ...frames].join('\n');
  }
  if (typeof fields.code === 'string' && ERROR_CODE.test(fields.code)) out.errorCode = fields.code;
  if (typeof fields.statusCode === 'number') out.statusCode = fields.statusCode;
  for (const key of ['constraint', 'table', 'column'] as const) {
    const value = fields[key];
    if (typeof value === 'string' && IDENTIFIER.test(value)) out[key] = value;
  }
  if (error.cause !== undefined && depth < 2) out.cause = serializeError(error.cause, depth + 1);
  return out;
}

/**
 * A worker loop's failure line: `msg` is what the alarm filters match (infra/terraform/cell,
 * `worker_loop_failures`); the error goes through the same allow-list as the API's log (L-31).
 */
export function failureLine(msg: string, error: unknown): string {
  return JSON.stringify({ msg, error: serializeError(error) });
}

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    serializers: { err: serializeError, error: serializeError },
  };
}
