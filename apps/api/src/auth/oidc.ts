// OpenID Connect for dashboard users (D-01; Amazon Cognito in production, but nothing here is
// Cognito-specific). Authorization code flow with PKCE (S256), state and nonce. The ID token is
// verified with the provider's published keys: issuer, audience, expiry, nonce and algorithm.
import { createHash } from 'node:crypto';

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type OidcConfig = {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
};

type Metadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

export type OidcIdentity = {
  readonly subject: string;
  /** Only a verified email is returned; an unverified one is treated as absent. */
  readonly email: string | null;
  readonly name: string | null;
};

export class OidcError extends Error {}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export class OidcClient {
  readonly #config: OidcConfig;
  readonly #fetch: typeof fetch;
  #metadata: Promise<Metadata> | undefined;
  #keys: JWTVerifyGetKey | undefined;

  /** `keys` and `fetchImpl` are test seams; production discovers both from the issuer. */
  constructor(config: OidcConfig, options: { fetchImpl?: typeof fetch; keys?: JWTVerifyGetKey } = {}) {
    this.#config = config;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#keys = options.keys;
  }

  async #discover(): Promise<Metadata> {
    this.#metadata ??= (async () => {
      const url = `${this.#config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const response = await this.#fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new OidcError(`discovery failed (${response.status})`);
      const metadata = (await response.json()) as Partial<Metadata>;
      if (metadata.issuer !== this.#config.issuer) throw new OidcError('issuer mismatch in discovery');
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
        if (!metadata[key]?.startsWith('https://')) throw new OidcError(`discovery: bad ${key}`);
      }
      return metadata as Metadata;
    })();
    try {
      return await this.#metadata;
    } catch (error) {
      this.#metadata = undefined; // retry discovery on the next sign-in
      throw error;
    }
  }

  async authorizationUrl(input: { state: string; nonce: string; codeVerifier: string }): Promise<string> {
    const metadata = await this.#discover();
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.#config.clientId,
      redirect_uri: this.#config.redirectUri,
      scope: 'openid email profile',
      state: input.state,
      nonce: input.nonce,
      code_challenge: pkceChallenge(input.codeVerifier),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /** Exchanges the code and returns the verified identity. Throws OidcError on any failure. */
  async signIn(input: { code: string; codeVerifier: string; nonce: string }): Promise<OidcIdentity> {
    const metadata = await this.#discover();
    const basic = Buffer.from(
      `${encodeURIComponent(this.#config.clientId)}:${encodeURIComponent(this.#config.clientSecret)}`,
    ).toString('base64');
    const response = await this.#fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: this.#config.redirectUri,
        code_verifier: input.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new OidcError(`token exchange failed (${response.status})`);
    const tokens = (await response.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== 'string') throw new OidcError('no id_token in the token response');
    return this.verifyIdToken(tokens.id_token, input.nonce, metadata.jwks_uri);
  }

  async verifyIdToken(idToken: string, nonce: string, jwksUri?: string): Promise<OidcIdentity> {
    const keys = this.#keys ?? createRemoteJWKSet(new URL(jwksUri ?? (await this.#discover()).jwks_uri));
    this.#keys ??= keys;
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        issuer: this.#config.issuer,
        audience: this.#config.clientId,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch {
      throw new OidcError('the ID token failed verification');
    }
    if (payload.nonce !== nonce) throw new OidcError('nonce mismatch');
    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0) throw new OidcError('no subject');
    const verified = payload.email_verified === true || payload.email_verified === 'true';
    const email = typeof payload.email === 'string' && verified ? payload.email.toLowerCase() : null;
    const name = typeof payload.name === 'string' ? payload.name.slice(0, 120) : null;
    return { subject, email, name };
  }
}
