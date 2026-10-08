// The dashboard's only way to the API: same origin (review A-07), the HttpOnly session cookie, the
// CSRF header (SEC §10) and the selected organization. The server decides every permission; the
// dashboard only hides what would be refused anyway (INV-12).
import type { ErrorCode } from '@sentryops/contracts';

export class ApiError extends Error {
  readonly code: ErrorCode | 'NETWORK';
  readonly status: number;
  readonly details: { path: string; issue: string }[];
  readonly current: unknown;

  constructor(
    code: ApiError['code'],
    message: string,
    status: number,
    details: ApiError['details'] = [],
    current?: unknown,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.current = current;
  }
}

let organizationId: string | null = null;
const signedOutListeners = new Set<() => void>();

export function setApiOrganization(id: string | null): void {
  organizationId = id;
}

/** Called when the server says the session has ended (PROD §14.7: a blocking signed-out screen). */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

type Options = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; organization?: string | null };

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-sentry-csrf': '1', accept: 'application/json' };
  const org = options.organization === undefined ? organizationId : options.organization;
  if (org) headers['x-organization-id'] = org;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the server. Check the connection.', 0);
  }
  const data: unknown = await response.json().catch(() => null);
  if (response.status === 401) {
    for (const listener of signedOutListeners) listener();
  }
  if (!response.ok) {
    const envelope = (data ?? {}) as {
      error?: { code?: ErrorCode; message?: string; details?: { path: string; issue: string }[] };
      current?: unknown;
    };
    throw new ApiError(
      envelope.error?.code ?? 'INTERNAL_ERROR',
      envelope.error?.message ?? 'Something went wrong.',
      response.status,
      envelope.error?.details ?? [],
      envelope.current,
    );
  }
  return data as T;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details.map((d) => `${d.path}: ${d.issue}`).join('; ');
    return details ? `${error.message} (${details})` : error.message;
  }
  return 'Something went wrong.';
}
