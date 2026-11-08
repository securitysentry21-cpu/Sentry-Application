// Asks the stack to stop itself: it ends the API, the worker, the dashboard and the database in order
// (Playwright would otherwise only kill its own process, which leaves a temporary database behind).
import { CONTROL_PORT } from './constants.ts';

export default async function teardown(): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${CONTROL_PORT}/stop`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    // Already gone.
  }
}
