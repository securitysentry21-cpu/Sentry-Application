// Runs before every page is rendered (Next.js 16 Proxy, Node.js runtime). It sets the dashboard's
// Content-Security-Policy with a fresh nonce (lib/csp.ts, SEC §10). Next reads the nonce from the
// request's policy while rendering and puts it on its own scripts, so every page renders per request
// (app/layout.tsx waits for the request). /api/* never reaches here in AWS (the load balancer sends
// it to the API, which sets its own `default-src 'none'`), and is proxied as-is in development.
import { type NextRequest, NextResponse } from 'next/server';

import { contentSecurityPolicy, newNonce } from './lib/csp';

export function proxy(request: NextRequest): NextResponse {
  const policy = contentSecurityPolicy({
    nonce: newNonce(),
    development: process.env.NODE_ENV === 'development',
    photoOrigin: process.env.PHOTO_ORIGIN,
  });
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  // Pages, the service worker and the map worker (a worker's own response sets its policy); not
  // Next's hashed static files or the API.
  matcher: ['/((?!api/|_next/static/|_next/image|favicon.ico).*)'],
};
