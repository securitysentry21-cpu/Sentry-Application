import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OidcClient, OidcError, pkceChallenge } from '../src/auth/oidc.ts';
import { loadConfig } from '../src/config.ts';
import { safeReturnTo } from '../src/routes/auth.ts';
import { asOwner, call, errorCode, seedOrganization, signIn, startTestApp, type TestApp } from './support.ts';

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp();
});

afterAll(async () => {
  await t?.close();
});

describe('dashboard sessions (ARCH §5.2)', () => {
  it('the development sign-in issues an HttpOnly, SameSite session cookie', async () => {
    const res = await call(t.app, {
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      body: { email: 'a@example.test' },
    });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^sentry_session=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; SameSite=Lax/);
  });

  it('GET /me answers for a session and 401 without one', async () => {
    const cookie = await signIn(t.app, 'me@example.test');
    const me = await call(t.app, { method: 'GET', url: '/api/v1/me', cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: 'me@example.test' }, memberships: [] });
    const anonymous = await call(t.app, { method: 'GET', url: '/api/v1/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(errorCode(anonymous)).toBe('UNAUTHENTICATED');
  });

  it('signing out revokes the session on the server, not just the cookie', async () => {
    const cookie = await signIn(t.app, 'leaver@example.test');
    expect((await call(t.app, { method: 'POST', url: '/api/v1/auth/logout', cookie })).statusCode).toBe(200);
    expect((await call(t.app, { method: 'GET', url: '/api/v1/me', cookie })).statusCode).toBe(401);
  });

  it('ADV-A07 a disabled user is refused on the very next request', async () => {
    const org = await seedOrganization(t.db, 'Disabled Co', [
      { email: 'owner@disabled.test', role: 'OWNER' },
    ]);
    const cookie = await signIn(t.app, 'owner@disabled.test');
    expect(
      (await call(t.app, { method: 'GET', url: '/api/v1/members', cookie, org: org.id })).statusCode,
    ).toBe(200);
    await asOwner(t.db, (c) =>
      c.query(`update users set status = 'DISABLED' where email = 'owner@disabled.test'`),
    );
    const after = await call(t.app, { method: 'GET', url: '/api/v1/members', cookie, org: org.id });
    expect(after.statusCode).toBe(401);
    // The session itself is revoked, so re-enabling the user doesn't revive it.
    await asOwner(t.db, (c) =>
      c.query(`update users set status = 'ACTIVE' where email = 'owner@disabled.test'`),
    );
    expect((await call(t.app, { method: 'GET', url: '/api/v1/me', cookie })).statusCode).toBe(401);
  });

  it('ADV-A07 a session past its idle lifetime is refused', async () => {
    const cookie = await signIn(t.app, 'idle@example.test');
    t.clock.advance(13 * 60 * 60 * 1000);
    expect((await call(t.app, { method: 'GET', url: '/api/v1/me', cookie })).statusCode).toBe(401);
  });
});

describe('development sign-in stays out of production (SEC §5)', () => {
  it('the configuration refuses DEV_AUTH in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://x',
        CELL_REGION: 'eu-central-1',
        DEV_AUTH: 'true',
        PUBLIC_ORIGIN: 'https://ops.example.pk',
        OIDC_ISSUER: 'https://issuer.example',
        OIDC_CLIENT_ID: 'c',
        OIDC_CLIENT_SECRET: 's',
      }),
    ).toThrow(/DEV_AUTH/);
  });

  it('production needs an identity provider and an https origin', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', CELL_REGION: 'eu-central-1' }),
    ).toThrow(/OIDC_ISSUER.*PUBLIC_ORIGIN|PUBLIC_ORIGIN.*OIDC_ISSUER/);
  });

  it('the route answers 404 when DEV_AUTH is off', async () => {
    const strict = await startTestApp({ config: { DEV_AUTH: false } });
    try {
      const res = await call(strict.app, {
        method: 'POST',
        url: '/api/v1/auth/dev-login',
        body: { email: 'x@example.test' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await strict.close();
    }
  });
});

describe('OpenID Connect sign-in (D-01)', () => {
  const issuer = 'https://idp.example.test';
  const clientId = 'sentry-dashboard';

  async function provider() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const sign = (claims: Record<string, unknown>, overrides: { audience?: string; issuer?: string } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(overrides.issuer ?? issuer)
        .setAudience(overrides.audience ?? clientId)
        .setSubject(typeof claims.sub === 'string' ? claims.sub : 'subject-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    return { keys, sign };
  }

  const client = (keys: ReturnType<typeof createLocalJWKSet>, fetchImpl?: typeof fetch) =>
    new OidcClient(
      { issuer, clientId, clientSecret: 'secret', redirectUri: 'http://127.0.0.1:3000/api/v1/auth/callback' },
      { keys, ...(fetchImpl ? { fetchImpl } : {}) },
    );

  it('accepts a valid ID token and returns the verified email only', async () => {
    const p = await provider();
    const verified = await client(p.keys).verifyIdToken(
      await p.sign({ sub: 's-1', nonce: 'n-1', email: 'Owner@Example.test', email_verified: true }),
      'n-1',
    );
    expect(verified).toEqual({ subject: 's-1', email: 'owner@example.test', name: null });
    const unverified = await client(p.keys).verifyIdToken(
      await p.sign({ sub: 's-2', nonce: 'n-2', email: 'x@example.test', email_verified: false }),
      'n-2',
    );
    expect(unverified.email).toBeNull();
  });

  it('rejects a wrong nonce, audience or issuer', async () => {
    const p = await provider();
    const c = client(p.keys);
    await expect(c.verifyIdToken(await p.sign({ sub: 's', nonce: 'other' }), 'n')).rejects.toThrow(OidcError);
    await expect(
      c.verifyIdToken(await p.sign({ sub: 's', nonce: 'n' }, { audience: 'someone-else' }), 'n'),
    ).rejects.toThrow(OidcError);
    await expect(
      c.verifyIdToken(await p.sign({ sub: 's', nonce: 'n' }, { issuer: 'https://evil.test' }), 'n'),
    ).rejects.toThrow(OidcError);
  });

  it('login → provider → callback issues a session and returns to a local page only', async () => {
    const p = await provider();
    let sentVerifier = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }
      if (url === `${issuer}/token`) {
        const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
        sentVerifier = form.get('code_verifier') ?? '';
        return Response.json({
          id_token: await p.sign({
            sub: 'sub-42',
            nonce: nonceSeen,
            email: 'oidc@example.test',
            email_verified: true,
          }),
        });
      }
      return new Response('not found', { status: 404 });
    };
    let nonceSeen = '';
    const app = await startTestApp();
    try {
      // Swap in an OIDC client that talks to the fake provider above.
      (app.deps as { oidc: OidcClient | null }).oidc = client(p.keys, fetchImpl);
      const login = await call(app.app, {
        method: 'GET',
        url: '/api/v1/auth/login?returnTo=//evil.example/x',
      });
      expect(login.statusCode).toBe(302);
      const authorize = new URL(String(login.headers.location));
      expect(authorize.origin).toBe(issuer);
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      nonceSeen = authorize.searchParams.get('nonce') ?? '';
      const state = authorize.searchParams.get('state') ?? '';

      const callback = await call(app.app, {
        method: 'GET',
        url: `/api/v1/auth/callback?code=abc&state=${state}`,
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('/'); // the //evil.example destination was dropped
      expect(pkceChallenge(sentVerifier)).toBe(authorize.searchParams.get('code_challenge'));
      const cookie = String(callback.headers['set-cookie']).split(';')[0] ?? '';
      const me = await call(app.app, { method: 'GET', url: '/api/v1/me', cookie });
      expect(me.json()).toMatchObject({ user: { email: 'oidc@example.test' } });

      // The state is single use.
      const replay = await call(app.app, {
        method: 'GET',
        url: `/api/v1/auth/callback?code=abc&state=${state}`,
      });
      expect(replay.headers.location).toBe('/sign-in?error=expired');
    } finally {
      await app.close();
    }
  });

  it('only local paths survive as a destination after sign-in', () => {
    expect(safeReturnTo('/members')).toBe('/members');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('/\\evil.example')).toBe('/');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
  });
});
