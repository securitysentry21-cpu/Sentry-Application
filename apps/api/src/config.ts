// Configuration from the environment, validated once at startup. Error messages name the
// variable, never its value (secrets live in these variables; SEC §13, §15).
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  /** The app_runtime connection. The startup role check refuses anything else (D-33). */
  DATABASE_URL: z.string().min(1),
  /** The cell's data region (D-13); must match organizations.data_region. */
  CELL_REGION: z.string().min(1),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join('.')} (${issue.code})`);
    throw new Error(`invalid configuration: ${fields.join(', ')}`);
  }
  return result.data;
}
