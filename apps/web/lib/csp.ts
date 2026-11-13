// SEC §10, review L-01: the dashboard's Content-Security-Policy, set on every page by proxy.ts with
// a fresh nonce per response. A control room holds live guard positions, so the policy is the second
// line of defence behind "no HTML sink" (ADV-W01):
// - scripts run only with this response's nonce; 'strict-dynamic' lets those load Next's own chunks.
//   Nothing inline without the nonce, and no eval outside `next dev` (React needs it there);
// - the network reaches the dashboard's own origin (the API is same-origin, review A-07) and the
//   map's one tile host, nothing else;
// - images: the dashboard's own, the map's, and incident photos from the photo bucket's signed links;
// - no plugins, no <base>, no framing, forms post only to the dashboard.
// Inline styles stay allowed: React renders style attributes and MapLibre positions its canvas with
// them. SEC §10 asks for no inline scripts; styles cannot run code.
import { MAP_STYLE_URL } from './map-sources';

export const MAP_TILE_ORIGIN = new URL(MAP_STYLE_URL).origin;

/** An https origin, nothing more: a path, a wildcard or a quote would widen or break the policy. */
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

export type CspOptions = {
  nonce: string;
  /** `next dev`: React's debugging needs eval, and the page is plain http on 127.0.0.1. */
  development: boolean;
  /** The photo bucket's origin (PHOTO_ORIGIN), where incident photos' signed links point. */
  photoOrigin?: string | undefined;
};

export function contentSecurityPolicy({ nonce, development, photoOrigin }: CspOptions): string {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(nonce)) throw new Error('nonce must be base64');
  const photos = photoOrigin && HTTPS_ORIGIN.test(photoOrigin) ? [photoOrigin] : [];
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    [
      'script-src',
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(development ? ["'unsafe-eval'"] : []),
    ],
    ['style-src', "'self'", "'unsafe-inline'"],
    ['img-src', "'self'", 'data:', 'blob:', ...photos],
    ['font-src', "'self'"],
    ['connect-src', "'self'", MAP_TILE_ORIGIN],
    ['worker-src', "'self'"],
    ['manifest-src', "'self'"],
    ['frame-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
    ...(development ? [] : ([['upgrade-insecure-requests']] as [string][])),
  ];
  return directives.map((d) => d.join(' ')).join('; ');
}

/**
 * Fable pass 2, review L-30: proxy.ts skips some paths (its matcher). Those that can still answer with
 * an HTML page (Next's 404 for a missing /favicon.ico, the image optimizer's errors) get this policy
 * from next.config.ts: nothing may load or run. The other skipped paths never serve a page:
 * `/_next/static/` holds hashed scripts and styles (a missing one is a text/plain 404), and `/api/`
 * goes to the API, which sets its own `default-src 'none'` (proxied as-is only in development).
 */
export const NOTHING_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const NOTHING_POLICY_PATHS = ['/favicon.ico', '/_next/image'] as const;
export const NEVER_A_PAGE_PATHS = ['/_next/static/', '/api/'] as const;

/** 128 random bits, base64: unguessable, and new for every response. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
