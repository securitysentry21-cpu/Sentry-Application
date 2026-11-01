// Each API instance's one LISTEN connection (ARCH §14): the dispatcher's NOTIFY says which
// organization has new events; the hub then reads them. The connection is dedicated (LISTEN only
// works on a connection that stays open) and reconnects with backoff. After every (re)connect the
// hub catches up, so a notification missed while disconnected is never lost.
import pg from 'pg';

import { REALTIME_CHANNEL } from './realtime.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BACKOFF_MS = 30_000;

export type ListenerHandlers = {
  readonly onNotify: (organizationId: string) => void;
  readonly onConnected: () => void;
  readonly onError: (message: string) => void;
};

export class RealtimeListener {
  readonly #url: string;
  readonly #handlers: ListenerHandlers;
  #client: pg.Client | null = null;
  #timer: NodeJS.Timeout | null = null;
  #attempt = 0;
  #stopped = false;

  constructor(url: string, handlers: ListenerHandlers) {
    this.#url = url;
    this.#handlers = handlers;
  }

  start(): void {
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const client = this.#client;
    this.#client = null;
    await client?.end().catch(() => undefined);
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    const client = new pg.Client({
      connectionString: this.#url,
      keepAlive: true,
      application_name: 'sentryops-api-listen',
    });
    let failed = false;
    const fail = (message: string) => {
      if (failed) return;
      failed = true;
      if (this.#client === client) this.#client = null;
      void client.end().catch(() => undefined);
      if (!this.#stopped) this.#handlers.onError(message);
      this.#retry();
    };
    client.on('notification', (message) => {
      if (message.channel === REALTIME_CHANNEL && message.payload && UUID.test(message.payload)) {
        this.#handlers.onNotify(message.payload.toLowerCase());
      }
    });
    client.on('error', (error) => fail(error.message));
    client.on('end', () => fail('connection ended'));
    try {
      await client.connect();
      await client.query(`listen ${REALTIME_CHANNEL}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'connect failed');
      return;
    }
    if (this.#stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    this.#client = client;
    this.#attempt = 0;
    this.#handlers.onConnected();
  }

  #retry(): void {
    if (this.#stopped || this.#timer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.#attempt++);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#connect();
    }, delay);
    this.#timer.unref();
  }
}
