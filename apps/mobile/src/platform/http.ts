// The network primitive on the phone: fetch (Expo's WinterCG fetch) with a hard timeout. Any failure
// without an HTTP response becomes NetworkError, so nothing is ever treated as sent without a server
// answer (ARCH §8.5).
import { NetworkError } from '../core/api/errors.ts';
import type { HttpTransport } from '../core/api/http.ts';

export const fetchTransport: HttpTransport = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, header: (name: string) => response.headers.get(name), text };
  } catch {
    throw new NetworkError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
};
