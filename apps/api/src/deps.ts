import type { Database, Pool } from '@sentryops/db';
import type { Clock } from '@sentryops/domain';

import type { OidcClient } from './auth/oidc.ts';
import type { Config } from './config.ts';
import type { RateLimiter } from './rate-limit.ts';

/** Everything a handler may use. Handlers get time from `clock`, never the wall clock (ARCH §3). */
export type AppDeps = {
  readonly pool: Pool;
  /** Kysely over the same pool; repositories use it inside tenant transactions (D-10). */
  readonly db: Database;
  readonly clock: Clock;
  readonly config: Config;
  readonly rateLimiter: RateLimiter;
  /** Null when no identity provider is configured (development and tests use DEV_AUTH). */
  readonly oidc: OidcClient | null;
};
