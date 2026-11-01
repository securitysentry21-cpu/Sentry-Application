// The realtime stream client (ARCH §14, PROD §14.7). It uses fetch() rather than EventSource, so
// the organization travels in X-Organization-Id like every other request; EventSource can't set
// headers, and the organization never comes from a query string (ARCH §4.1). It reconnects with
// Last-Event-ID, so the server replays whatever was missed.
import type { Envelope } from './live-model';

export type StreamStatus = 'connecting' | 'open' | 'down';

export type StreamOptions = {
  readonly organizationId: string;
  /** Only for the monitoring coverage count (PROD §11.5). */
  readonly client: 'desktop' | 'phone';
  readonly lastEventId: () => number;
  readonly onEvent: (event: Envelope) => void;
  readonly onStatus: (status: StreamStatus) => void;
  /** The session ended, or access to this organization did: monitoring stops (PROD §14.7). */
  readonly onRefused: () => void;
};

/** A dropped stream retries at once (the server cycles streams every 30 min), then backs off. */
const BACKOFF_MS = [0, 1_000, 2_000, 5_000, 10_000];

/** Splits a text/event-stream body into frames and returns the JSON `data:` of each event. */
export function parseFrames(buffer: string): { events: Envelope[]; rest: string } {
  const events: Envelope[] = [];
  let rest = buffer.replaceAll('\r\n', '\n');
  let end: number;
  while ((end = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (data.length === 0) continue; // a comment (keep-alive) or a retry hint
    try {
      events.push(JSON.parse(data.join('\n')) as Envelope);
    } catch {
      // A frame we can't read is skipped; the next snapshot reload corrects the picture.
    }
  }
  return { events, rest };
}

export function connectStream(options: StreamOptions): () => void {
  const controller = new AbortController();
  let stopped = false;
  let attempt = 0;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      controller.signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        resolve();
      });
    });

  const run = async () => {
    options.onStatus('connecting');
    while (!stopped) {
      try {
        const response = await fetch(`/api/v1/stream?client=${options.client}`, {
          headers: {
            accept: 'text/event-stream',
            'x-sentry-csrf': '1',
            'x-organization-id': options.organizationId,
            'last-event-id': String(options.lastEventId()),
          },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          options.onRefused();
          return;
        }
        if (response.ok && response.body) {
          options.onStatus('open');
          attempt = 0;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseFrames(buffer);
            buffer = parsed.rest;
            for (const event of parsed.events) options.onEvent(event);
          }
        }
      } catch {
        // offline, or aborted on purpose
      }
      if (stopped) return;
      options.onStatus('down');
      await wait(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]!);
    }
  };
  void run();
  return () => {
    stopped = true;
    controller.abort();
  };
}
