// The one network primitive the core uses. The phone implements it with fetch
// (src/platform/http.ts); tests implement it with a scripted fake server.

export type HttpMethod = 'GET' | 'POST';

export type HttpRequest = {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The exact body text sent on the wire (UTF-8). */
  readonly body?: string;
  readonly timeoutMs: number;
};

export type HttpResponse = {
  readonly status: number;
  header(name: string): string | null;
  readonly text: string;
};

/** Resolves with any HTTP response, including errors. Rejects with NetworkError when there is none. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;
