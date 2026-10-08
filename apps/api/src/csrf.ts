// CSRF (SEC §10, ADV-W03). The session cookie is SameSite=Lax and the dashboard shares the API's
// origin, and on top of that every state-changing request that carries the session cookie must:
//   - carry `X-Sentry-CSRF: 1`, a custom header a cross-site form or image can't add, and that
//     cross-site fetch can't add without a CORS preflight, which this API never grants;
//   - not come from another origin (Origin header) or a cross-site context (Sec-Fetch-Site).
// Requests without the cookie carry no ambient credential to abuse: the guard app's Bearer
// requests, and its enrollment and refresh calls whose secret travels in the body.
import type { FastifyRequest } from 'fastify';

import type { Config } from './config.ts';
import { readSessionCookie } from './cookies.ts';
import { AppError } from './errors.ts';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function checkCsrf(request: FastifyRequest, config: Config): void {
  if (SAFE.has(request.method)) return;
  if (readSessionCookie(request, config) === null) return;

  const blocked = () => new AppError('FORBIDDEN', 'Cross-site request blocked.');
  if (request.headers['x-sentry-csrf'] !== '1') throw blocked();
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== new URL(config.PUBLIC_ORIGIN).origin) throw blocked();
  if (request.headers['sec-fetch-site'] === 'cross-site') throw blocked();
}
