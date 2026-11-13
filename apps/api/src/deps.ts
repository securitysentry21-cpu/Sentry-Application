import type { Database, Pool } from '@sentryops/db';
import type { Clock } from '@sentryops/domain';

import type { OidcClient } from './auth/oidc.ts';
import type { Config } from './config.ts';
import type { Metrics } from './metrics.ts';
import type { Providers } from './notify/providers.ts';
import type { RateLimiter } from './rate-limit.ts';
import type { ObjectStore } from './storage/objects.ts';

/** Everything a handler may use. Handlers get time from `clock`, never the wall clock (ARCH §3). */
export type AppDeps = {
  readonly pool: Pool;
  /** Kysely over the same pool; repositories use it inside tenant transactions (D-10). */
  readonly db: Database;
  /**
   * Fable pass 2, review L-27: a few connections only the SOS routes use (`policy.sos`), so a sync
   * storm that takes every connection of `pool` cannot hold an SOS back (INV-15). Absent in tests
   * that do not need it; the SOS routes then share `pool`.
   */
  readonly sos?: { readonly pool: Pool; readonly db: Database };
  readonly clock: Clock;
  readonly config: Config;
  readonly rateLimiter: RateLimiter;
  readonly metrics: Metrics;
  /** Null when no identity provider is configured (development and tests use DEV_AUTH). */
  readonly oidc: OidcClient | null;
  /** Incident photos (ARCH §12). */
  readonly objects: ObjectStore;
  /** Web Push, Firebase and SMS (ARCH §13.4). */
  readonly notify: Providers;
};
