// Turning a thrown value into a crash report (ARCH §18.6; SEC §11, §15). A report names the error's
// class and the places in OUR code it passed through, nothing the guard typed, saw or was near.
//   - the error's message is never read: messages carry data ("Cannot find guard Ahmed", a number);
//   - the error name and each stack frame are rebuilt from characters on an allow-list, every other
//     character becoming "_", so what comes out always fits the contract's patterns;
//   - a frame keeps the function name, the file's base name (never a directory or URL) and the position.
// The server checks the same patterns again and refuses the whole request on a mismatch.
import {
  APP_ERROR_PATTERNS,
  appErrorReportSchema,
  MAX_APP_ERROR_FRAMES,
  type AppErrorFrame,
  type AppErrorKind,
  type AppErrorReport,
} from '@sentryops/contracts';

import { isoFromMs } from '../time.ts';

/** Replaces every character outside `allowed` with "_" and cuts to `max`. */
function scrub(value: string, allowed: RegExp, max: number): string {
  let out = '';
  for (const char of value) {
    if (out.length >= max) break;
    out += allowed.test(char) ? char : '_';
  }
  return out;
}

const NAME_CHARS = /[A-Za-z0-9_$.]/;
const FUNCTION_CHARS = /[A-Za-z0-9_$.<>[\]]/;
const FILE_CHARS = /[A-Za-z0-9_.-]/;
const VERSION_CHARS = /[0-9A-Za-z.+-]/;
const OS_CHARS = /[0-9A-Za-z.+_ -]/;

/** The class name of whatever was thrown. Never `message`, never `String(error)`. */
export function errorName(error: unknown): string {
  const raw =
    error instanceof Error ? error.name : typeof error === 'object' ? 'ThrownObject' : 'ThrownValue';
  const name = scrub(raw, NAME_CHARS, 60);
  return /^[A-Za-z]/.test(name) ? name : `E${name}`.slice(0, 60);
}

function lastSegment(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '';
  return withoutQuery.split(/[\\/]/).pop() ?? '';
}

/**
 * Frames from the common stack formats (Hermes and V8 "at fn (file:line:col)", JavaScriptCore
 * "fn@file:line:col"). A line that is not a frame is skipped; the text of `stack` is never kept.
 */
export function parseStack(stack: unknown): AppErrorFrame[] {
  if (typeof stack !== 'string') return [];
  const frames: AppErrorFrame[] = [];
  for (const line of stack.split('\n', 200)) {
    if (frames.length >= MAX_APP_ERROR_FRAMES) break;
    const tail = /:(\d{1,9}):(\d{1,9})\)?\s*$/.exec(line);
    if (!tail) continue;
    const head = line.slice(0, tail.index);
    const paren = head.lastIndexOf('(');
    const at = head.indexOf('@');
    let fn = '';
    let location = head;
    if (paren !== -1) {
      fn = head.slice(0, paren);
      location = head.slice(paren + 1);
    } else if (at !== -1) {
      fn = head.slice(0, at);
      location = head.slice(at + 1);
    }
    fn = fn
      .trim()
      .replace(/^at\s+/, '')
      .replace(/^(async|new)\s+/, '');
    location = location
      .trim()
      .replace(/^at\s+/, '')
      .replace(/^address at\s+/, '');
    frames.push({
      fn: scrub(fn, FUNCTION_CHARS, 80) || 'anonymous',
      file: scrub(lastSegment(location), FILE_CHARS, 80) || 'unknown',
      line: Number(tail[1]),
      column: Number(tail[2]),
    });
  }
  return frames;
}

export type CrashReportInput = {
  readonly kind: AppErrorKind;
  readonly fatal: boolean;
  /** Undefined for an UNEXPECTED_CLOSE: nothing was thrown, the run just ended. */
  readonly error?: unknown;
  readonly occurredAtMs: number;
  readonly appVersion: string;
  readonly platform: 'ANDROID' | 'IOS';
  readonly osVersion: string;
};

/** A report that satisfies the contract, or null (nothing invalid is ever queued or sent). */
export function buildAppErrorReport(input: CrashReportInput): AppErrorReport | null {
  if (!Number.isFinite(input.occurredAtMs)) return null;
  const closed = input.kind === 'UNEXPECTED_CLOSE';
  const candidate = {
    kind: input.kind,
    fatal: input.fatal,
    occurredAt: isoFromMs(input.occurredAtMs),
    errorName: closed ? 'UnexpectedClose' : errorName(input.error),
    frames: closed || !(input.error instanceof Error) ? [] : parseStack(input.error.stack),
    appVersion: scrub(input.appVersion, VERSION_CHARS, 40) || 'unknown',
    platform: input.platform,
    osVersion: scrub(input.osVersion, OS_CHARS, 40) || 'unknown',
  };
  const parsed = appErrorReportSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** For the tests: the patterns the contract enforces, so a test can state the rule it proves. */
export const REPORT_PATTERNS = APP_ERROR_PATTERNS;
