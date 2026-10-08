import { createPool, verifyRuntimeRole } from '@sentryops/db';
import { systemClock, type Clock } from '@sentryops/domain';
import type { FastifyInstance } from 'fastify';

import { buildApp, type BuildOptions } from './app.ts';
import type { Config } from './config.ts';

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
  const app = buildApp({ pool, clock: overrides.clock ?? systemClock, config }, overrides);
  app.addHook('onClose', async () => {
    await pool.end();
  });
  await app.listen({ host: config.HOST, port: config.PORT });
  return app;
}
