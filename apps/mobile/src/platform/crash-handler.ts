// Catches JavaScript errors nobody handled and reports them (ARCH §18.6). React Native's global
// handler is given the error first; a fatal one would end the app at once, so the report is queued
// (and a send tried) for up to a second before the original handler runs. Native crashes (the
// system's own) are not seen here: Google Play shows those once the app is on Play.
import { getGuardApp } from './runtime.ts';

const FATAL_WAIT_MS = 1_000;

type Handler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = { getGlobalHandler(): Handler; setGlobalHandler(handler: Handler): void };

let installed = false;

export function installCrashHandler(): void {
  if (installed) return;
  const utils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!utils) return;
  installed = true;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    let report: Promise<void>;
    try {
      report = getGuardApp().reportError('UNHANDLED_ERROR', error, isFatal === true);
    } catch {
      report = Promise.resolve();
    }
    const done = () => previous(error, isFatal);
    if (isFatal === true) {
      // The report first, but never keep a broken app alive longer than a second.
      void Promise.race([report, new Promise<void>((resolve) => setTimeout(resolve, FATAL_WAIT_MS))]).then(
        done,
        done,
      );
    } else {
      done();
      void report;
    }
  });
}
