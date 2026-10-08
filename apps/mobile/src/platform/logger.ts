// The device log sink. Fields have already been through the core logger's allow-list (SEC §15), so
// no token, code, coordinate, phone number or incident text can reach logcat or the console. Release
// builds keep warnings and errors only.
import { createLogger, type Logger, type LogLevel } from '../core/log.ts';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minimum = __DEV__ ? LEVELS.debug : LEVELS.warn;

export const appLogger: Logger = createLogger((level, event, fields) => {
  if (LEVELS[level] < minimum) return;
  const line = `[sentry] ${event} ${JSON.stringify(fields)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
});
