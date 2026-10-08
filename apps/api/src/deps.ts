import type { Pool } from '@sentryops/db';
import type { Clock } from '@sentryops/domain';

import type { Config } from './config.ts';

/** Everything a handler may use. Handlers get time from `clock`, never the wall clock (ARCH §3). */
export type AppDeps = {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly config: Config;
};
