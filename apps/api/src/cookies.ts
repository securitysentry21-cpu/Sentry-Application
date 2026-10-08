// The session cookie (ARCH §5.2): HttpOnly, SameSite=Lax, Secure with a __Host- name on HTTPS.
import type { FastifyReply, FastifyRequest } from 'fastify';

import { sessionCookieName, type Config } from './config.ts';
import { SESSION_ABSOLUTE_MS } from './repositories/sessions.ts';

export function readSessionCookie(request: FastifyRequest, config: Config): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  const name = sessionCookieName(config);
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : null;
    }
  }
  return null;
}

function attributes(config: Config, maxAgeS: number): string {
  const secure = config.PUBLIC_ORIGIN.startsWith('https://') ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`;
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string): void {
  void reply.header(
    'set-cookie',
    `${sessionCookieName(config)}=${token}; ${attributes(config, Math.floor(SESSION_ABSOLUTE_MS / 1000))}`,
  );
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  void reply.header('set-cookie', `${sessionCookieName(config)}=; ${attributes(config, 0)}`);
}
