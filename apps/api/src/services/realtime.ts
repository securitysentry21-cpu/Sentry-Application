// Publishing to the dashboards (ARCH §14, §16.1): a change writes an outbox row in its own
// transaction, so an event exists if and only if the change committed. The dispatcher assigns the
// sequence after commit; the stream adds the current state when it sends the event.
import type { RealtimeEventType } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';

import type { AppDeps } from '../deps.ts';
import { uuidv7 } from '../ids.ts';
import { enqueue } from '../repositories/realtime.ts';

/** A stream not seen for this long belongs to an API instance that stopped (PROD §11.5). */
export const STREAM_STALE_MS = 90_000;

export async function publish(
  trx: Database,
  deps: Pick<AppDeps, 'clock'>,
  organizationId: string,
  topic: RealtimeEventType,
  payload: Record<string, string>,
): Promise<void> {
  await enqueue(trx, { id: uuidv7(deps.clock), organizationId, topic, payload, at: deps.clock.now() });
}
