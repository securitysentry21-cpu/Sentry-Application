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

export function loggerOptions(level: string): LoggerOptions {
  return { level, redact: { paths: REDACT_PATHS, censor: '[Redacted]' } };
}
