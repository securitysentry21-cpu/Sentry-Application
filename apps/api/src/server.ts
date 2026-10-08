import { createKysely, createPool, verifyRuntimeRole, type Pool } from '@sentryops/db';
import { systemClock, type Clock } from '@sentryops/domain';
import type { FastifyInstance } from 'fastify';

import { buildApp, type BuildOptions } from './app.ts';
import { OidcClient } from './auth/oidc.ts';
import type { Config } from './config.ts';
import type { AppDeps } from './deps.ts';
import { RateLimiter } from './rate-limit.ts';

/** The dependencies the API runs with; tests build the same thing around a test database. */
export function createDeps(
  config: Config,
  pool: Pool,
  overrides: { clock?: Clock; oidc?: OidcClient | null } = {},
): AppDeps {
  const clock = overrides.clock ?? systemClock;
  const oidc =
    overrides.oidc !== undefined
      ? overrides.oidc
      : config.OIDC_ISSUER && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET
        ? new OidcClient({
            issuer: config.OIDC_ISSUER,
            clientId: config.OIDC_CLIENT_ID,
            clientSecret: config.OIDC_CLIENT_SECRET,
            redirectUri: `${new URL(config.PUBLIC_ORIGIN).origin}/api/v1/auth/callback`,
          })
        : null;
  return { pool, db: createKysely(pool), clock, config, rateLimiter: new RateLimiter(clock), oidc };
}

/**
 * Starts the API. Before serving anything it checks that it is connected as a runtime role that
 * cannot bypass RLS, and refuses to start otherwise (D-33, ADV-X07).
 */
export async function start(
  config: Config,
  overrides: { clock?: Clock } & BuildOptions = {},
): Promise<FastifyInstance> {
  const pool = createPool(config.DATABASE_URL, { applicationName: 'sentryops-api' });
  try {
    await verifyRuntimeRole(pool, ['app_runtime']);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const app = buildApp(createDeps(config, pool, overrides), overrides);
  app.addHook('onClose', async () => {
    await pool.end();
  });
  await app.listen({ host: config.HOST, port: config.PORT });
  return app;
}
