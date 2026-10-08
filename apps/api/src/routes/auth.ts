// Dashboard sign-in (D-01). The browser goes to the identity provider and back; the API verifies
// the result and issues its own server-side session (ARCH §5.2). The application never sees or
// stores a password (SEC §5). DEV_AUTH adds a development sign-in, refused in production (config).
import { devLoginRequestSchema, errorEnvelopeSchema, type RoutePolicy } from '@sentryops/contracts';
import { z } from 'zod';

import { OidcError } from '../auth/oidc.ts';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from '../cookies.ts';
import { userOf } from '../context.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, notFound } from '../errors.ts';
import { randomToken, uuidv7 } from '../ids.ts';
import { createUser, findUserByEmail, findUserBySubject, linkSubject } from '../repositories/users.ts';
import {
  consumeAuthState,
  createSession,
  resolveSession,
  revokeSession,
  saveAuthState,
} from '../repositories/sessions.ts';
import { defineRoute } from './registry.ts';

const SIGN_IN: RoutePolicy = {
  access: { kind: 'public' },
  ownership: 'none',
  rateLimit: 'signin',
  audit: null,
};

/** Only local paths are accepted as a destination after sign-in: never an open redirect. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!/^\/([^/\\].*)?$/.test(value) || value.length > 512) return '/';
  return value;
}

async function startSession(
  deps: AppDeps,
  userId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<string> {
  const token = randomToken(32);
  await createSession(deps.db, {
    id: uuidv7(deps.clock),
    token,
    userId,
    now: deps.clock.now(),
    ip,
    userAgent,
  });
  return token;
}

export const authRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/login',
    summary: 'Starts sign-in at the identity provider (authorization code with PKCE).',
    policy: SIGN_IN,
    query: z.object({ returnTo: z.string().max(512).optional() }),
    responses: { 302: z.null(), 503: errorEnvelopeSchema },
    handler: async ({ request, reply, deps, query }) => {
      deps.rateLimiter.hit('signin', 'ip', request.ip);
      const returnTo = safeReturnTo(query.returnTo);
      if (!deps.oidc) {
        if (deps.config.DEV_AUTH) {
          return reply.redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`, 302);
        }
        throw new AppError('NOT_READY', 'Sign-in is not configured.');
      }
      const state = randomToken(32);
      const nonce = randomToken(24);
      const codeVerifier = randomToken(48);
      await saveAuthState(deps.db, {
        id: uuidv7(deps.clock),
        state,
        nonce,
        codeVerifier,
        returnTo,
        now: deps.clock.now(),
      });
      return reply.redirect(await deps.oidc.authorizationUrl({ state, nonce, codeVerifier }), 302);
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/callback',
    summary: 'Completes sign-in: verifies the provider response and issues a session.',
    policy: SIGN_IN,
    query: z.object({
      code: z.string().max(2048).optional(),
      state: z.string().max(256).optional(),
      error: z.string().max(256).optional(),
    }),
    responses: { 302: z.null() },
    handler: async ({ request, reply, deps, ctx, query }) => {
      deps.rateLimiter.hit('signin', 'ip', request.ip);
      const fail = (reason: string) => reply.redirect(`/sign-in?error=${reason}`, 302);
      if (!deps.oidc || !query.code || !query.state || query.error) return fail('cancelled');
      const now = deps.clock.now();
      const saved = await consumeAuthState(deps.db, query.state, now);
      if (!saved) return fail('expired');
      let identity;
      try {
        identity = await deps.oidc.signIn({
          code: query.code,
          codeVerifier: saved.codeVerifier,
          nonce: saved.nonce,
        });
      } catch (error) {
        request.log.warn(
          { reason: error instanceof OidcError ? error.message : 'unexpected' },
          'sign-in failed',
        );
        return fail('failed');
      }
      let user = await findUserBySubject(deps.db, identity.subject);
      if (!user && identity.email) {
        const byEmail = await findUserByEmail(deps.db, identity.email);
        if (byEmail && !byEmail.authProviderUserId) {
          await linkSubject(deps.db, byEmail.id, identity.subject, now);
          user = byEmail;
        }
      }
      if (!user) {
        // Without a verified email there is no way to match invitations later.
        if (!identity.email) return fail('no-email');
        user = await createUser(deps.db, {
          id: uuidv7(deps.clock),
          email: identity.email,
          name: identity.name ?? identity.email,
          subject: identity.subject,
          now,
        });
      }
      if (user.status !== 'ACTIVE') return fail('disabled');
      deps.rateLimiter.hit('signin', 'account', user.id);
      setSessionCookie(reply, deps.config, await startSession(deps, user.id, ctx.ip, ctx.userAgent));
      return reply.redirect(saved.returnTo, 302);
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    summary: 'Development sign-in by email, without an identity provider. Disabled in production.',
    policy: SIGN_IN,
    body: devLoginRequestSchema,
    responses: { 200: z.object({ ok: z.literal(true) }), 404: errorEnvelopeSchema },
    handler: async ({ request, reply, deps, ctx, body }) => {
      // Config refuses DEV_AUTH in production; this second check keeps the route dark regardless.
      if (!deps.config.DEV_AUTH || deps.config.NODE_ENV === 'production') throw notFound();
      deps.rateLimiter.hit('signin', 'ip', request.ip);
      deps.rateLimiter.hit('signin', 'account', body.email.toLowerCase());
      const now = deps.clock.now();
      let user = await findUserByEmail(deps.db, body.email);
      user ??= await createUser(deps.db, {
        id: uuidv7(deps.clock),
        email: body.email,
        name: body.name ?? body.email.split('@')[0] ?? body.email,
        subject: null,
        now,
      });
      if (user.status !== 'ACTIVE') throw new AppError('UNAUTHENTICATED', 'This account is disabled.');
      setSessionCookie(reply, deps.config, await startSession(deps, user.id, ctx.ip, ctx.userAgent));
      return { ok: true as const };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/auth/logout',
    summary: 'Signs out: revokes the session and clears the cookie.',
    policy: { access: { kind: 'authenticated' }, ownership: 'none', rateLimit: 'default', audit: null },
    responses: { 200: z.object({ ok: z.literal(true) }) },
    handler: async ({ reply, deps, ctx }) => {
      await revokeSession(deps.db, userOf(ctx).sessionId, 'SIGNED_OUT', deps.clock.now());
      clearSessionCookie(reply, deps.config);
      return { ok: true as const };
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/auth/session',
    summary: 'Whether the browser has a live session (no error when it does not).',
    policy: { access: { kind: 'public' }, ownership: 'none', rateLimit: 'none', audit: null },
    responses: { 200: z.object({ signedIn: z.boolean(), devAuth: z.boolean() }) },
    handler: async ({ request, deps }) => {
      const token = readSessionCookie(request, deps.config);
      const session = token ? await resolveSession(deps.db, token, deps.clock.now()) : null;
      return { signedIn: session !== null, devAuth: deps.config.DEV_AUTH && !deps.oidc };
    },
  }),
];
