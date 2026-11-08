// Crash reports from the guard app (ARCH §18.6, owner decision 2026-11-02: our own server only).
//
// A report says WHAT broke and WHERE in our own code, never what the guard was doing or looking at
// (SEC §11, §15). Every string is held to a strict identifier-like pattern, so no message text, name,
// phone number, coordinate or incident text can be carried in a field: a report that does not fit is
// refused whole. The phone scrubs before it sends; this schema is the server's own check, because the
// server does not trust the phone. The API writes accepted reports to its service log only (kept 30
// days, then deleted); nothing is stored in the product database (SEC §16.2).
import { z } from 'zod';

import { PLATFORMS } from './mobile.ts';

export const APP_ERROR_KINDS = [
  /** The JavaScript global error handler (fatal or not). */
  'UNHANDLED_ERROR',
  /** A screen failed to draw; the error boundary caught it. */
  'RENDER_ERROR',
  /** The previous run ended while the app was in the front and did not close itself. */
  'UNEXPECTED_CLOSE',
] as const;
export type AppErrorKind = (typeof APP_ERROR_KINDS)[number];

export const MAX_APP_ERROR_FRAMES = 12;
export const MAX_APP_ERROR_REPORTS = 10;

/** Patterns for the only characters a report field may hold. */
export const APP_ERROR_PATTERNS = {
  errorName: /^[A-Za-z][A-Za-z0-9_$.]{0,59}$/,
  functionName: /^[A-Za-z0-9_$.<>[\]]{1,80}$/,
  fileName: /^[A-Za-z0-9_.-]{1,80}$/,
  appVersion: /^[0-9A-Za-z.+-]{1,40}$/,
  osVersion: /^[0-9A-Za-z.+_ -]{1,40}$/,
} as const;

export const appErrorFrameSchema = z.strictObject({
  /** The function's name in our bundle; "anonymous" when the engine has none. */
  fn: z.string().regex(APP_ERROR_PATTERNS.functionName),
  /** The bundle or source file's base name; never a directory. */
  file: z.string().regex(APP_ERROR_PATTERNS.fileName),
  line: z.int().min(0).max(100_000_000),
  column: z.int().min(0).max(100_000_000),
});
export type AppErrorFrame = z.infer<typeof appErrorFrameSchema>;

export const appErrorReportSchema = z.strictObject({
  kind: z.enum(APP_ERROR_KINDS),
  fatal: z.boolean(),
  /** Phone wall clock: evidence, never authority (INV-07). */
  occurredAt: z.iso.datetime({ offset: true }),
  /** The error's class name (e.g. TypeError), never its message. */
  errorName: z.string().regex(APP_ERROR_PATTERNS.errorName),
  frames: z.array(appErrorFrameSchema).max(MAX_APP_ERROR_FRAMES),
  appVersion: z.string().regex(APP_ERROR_PATTERNS.appVersion),
  platform: z.enum(PLATFORMS),
  osVersion: z.string().regex(APP_ERROR_PATTERNS.osVersion),
});
export type AppErrorReport = z.infer<typeof appErrorReportSchema>;

export const appErrorsRequestSchema = z.strictObject({
  reports: z.array(appErrorReportSchema).min(1).max(MAX_APP_ERROR_REPORTS),
});
export type AppErrorsRequest = z.infer<typeof appErrorsRequestSchema>;
