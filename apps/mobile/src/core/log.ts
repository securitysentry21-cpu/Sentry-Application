// Logging hygiene (SEC §11, §15): device logs and crash reports never contain tokens, enrollment
// codes, coordinates, incident text or phone numbers. The logger takes an event name plus fields,
// and passes through only fields on an allow-list of IDs, counts, codes and states; every other
// field is replaced by "[redacted]". Free text is never logged.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;
export type LogSink = (level: LogLevel, event: string, fields: Record<string, unknown>) => void;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Field names that may reach a log line. IDs are opaque UUIDs; codes are API error codes. */
export const LOGGABLE_FIELDS: ReadonlySet<string> = new Set([
  'requestId',
  'batchId',
  'clientEventId',
  'shiftId',
  'deviceId',
  'sosEventId',
  'bootId',
  'taskName',
  'errorCode',
  'errorKind',
  'httpStatus',
  'status',
  'state',
  'phase',
  'reason',
  'type',
  'lane',
  'count',
  'items',
  'accepted',
  'rejected',
  'retry',
  'quarantined',
  'duplicate',
  'pending',
  'attempt',
  'failures',
  'delayMs',
  'durationMs',
  'ageMs',
  'offsetMs',
  'fromVersion',
  'toVersion',
  'appVersion',
  'platform',
  'permission',
  'precise',
  'servicesEnabled',
  'tracking',
  'variant',
]);

const MAX_STRING = 120;
const SAFE_STRING = /^[A-Za-z0-9_.:\-/ ]*$/;

function safeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    // Even allowed fields carry only identifier-like strings, never free text.
    if (!SAFE_STRING.test(value)) return '[redacted]';
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  return '[redacted]';
}

/** What actually reaches the sink for these fields. Exported for the logging-hygiene test. */
export function redactFields(fields: LogFields | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    out[key] = LOGGABLE_FIELDS.has(key) ? safeValue(value) : '[redacted]';
  }
  return out;
}

export function createLogger(sink: LogSink, base: LogFields = {}): Logger {
  const write = (level: LogLevel, event: string, fields?: LogFields) => {
    const name = SAFE_STRING.test(event) ? event : 'invalid-event-name';
    try {
      sink(level, name, { ...redactFields(base), ...redactFields(fields) });
    } catch {
      // Logging never breaks the app.
    }
  };
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

export const silentLogger: Logger = createLogger(() => undefined);

/** The kind of an unknown thrown value, safe to log (never its message, which may contain data). */
export function errorKind(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}
