// CSRF (SEC §10, ADV-W03). The session cookie is SameSite=Lax and the dashboard shares the API's
// origin, and on top of that every state-changing request authenticated by cookie must:
//   - carry `X-Sentry-CSRF: 1`, a custom header a cross-site form or image can't add, and that
//     cross-site fetch can't add without a CORS preflight, which this API never grants;
//   - not come from another origin (Origin header) or a cross-site context (Sec-Fetch-Site).
// Requests with a Bearer token (the guard app) carry no ambient credentials and are exempt.
import type { FastifyRequest } from 'fastify';

import type { Config } from './config.ts';
import { AppError } from './errors.ts';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function checkCsrf(request: FastifyRequest, config: Config): void {
  if (SAFE.has(request.method)) return;
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) return;

  const blocked = () => new AppError('FORBIDDEN', 'Cross-site request blocked.');
  if (request.headers['x-sentry-csrf'] !== '1') throw blocked();
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== new URL(config.PUBLIC_ORIGIN).origin) throw blocked();
  if (request.headers['sec-fetch-site'] === 'cross-site') throw blocked();
}
