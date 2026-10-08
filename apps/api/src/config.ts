// Configuration from the environment, validated once at startup. Error messages name the
// variable, never its value (secrets live in these variables; SEC §13, §15).
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(4000),
    /** The app_runtime connection. The startup role check refuses anything else (D-33). */
    DATABASE_URL: z.string().min(1),
    /** The cell's data region (D-13); must match organizations.data_region. */
    CELL_REGION: z.string().min(1),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    /** The dashboard's public origin. The API shares it (review A-07); CSRF checks compare to it. */
    PUBLIC_ORIGIN: z.url().default('http://127.0.0.1:3000'),
    /** Development sign-in without an identity provider. Refused in production (below). */
    DEV_AUTH: flag,
    /** True only behind the load balancer, which sets X-Forwarded-For. */
    TRUST_PROXY: flag,
    /** OpenID Connect provider for dashboard users (D-01: Amazon Cognito in production). */
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV !== 'production') return;
    if (c.DEV_AUTH) {
      ctx.addIssue({ code: 'custom', path: ['DEV_AUTH'], message: 'must be false in production' });
    }
    if (!c.OIDC_ISSUER || !c.OIDC_CLIENT_ID || !c.OIDC_CLIENT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'an identity provider is required' });
    }
    if (!c.PUBLIC_ORIGIN.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'must be https in production' });
    }
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => `${issue.path.join('.')} (${issue.message})`);
    throw new Error(`invalid configuration: ${fields.join(', ')}`);
  }
  return result.data;
}

/** HTTPS deployments use a `__Host-` cookie: Secure, host-only, path /, so no subdomain can set it. */
export function sessionCookieName(config: Config): string {
  return config.PUBLIC_ORIGIN.startsWith('https://') ? '__Host-sentry_session' : 'sentry_session';
}
