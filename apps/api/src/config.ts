// Configuration from the environment, validated once at startup. Error messages name the
// variable, never its value (secrets live in these variables; SEC §13, §15).
import { CURRENT_DISCLOSURE_VERSION } from '@sentryops/contracts';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
/** Development only; production refuses to start with it (below). */
const DEV_QR_SECRET = 'development-only-qr-secret-do-not-use-in-production';
const DEV_OBJECT_SECRET = 'development-only-object-link-secret-not-for-production';
const list = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
const proxyAddress = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);
/**
 * Review L-06: the proxies whose X-Forwarded-For the API believes, as addresses or CIDR ranges, or
 * "false". Never "true": that believes every hop, and the left-most one is whatever the client
 * wrote, so per-IP limits and the IP in sessions and audit rows (SEC §17.2) would be the client's
 * choice. With the list, the API takes the right-most address that is not a trusted proxy.
 */
const trustedProxies = z
  .string()
  .default('false')
  .transform((v, ctx): false | string => {
    if (v.trim() === '' || v.trim() === 'false') return false;
    const items = v.split(',').map((s) => s.trim());
    if (!items.every((item) => proxyAddress.safeParse(item).success)) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be "false" or a list of proxy addresses or CIDR ranges',
      });
      return z.NEVER;
    }
    return items.join(',');
  });

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
    /** The load balancer's addresses (the cell's VPC range): it sets X-Forwarded-For. */
    TRUST_PROXY: trustedProxies,
    /** OpenID Connect provider for dashboard users (D-01: Amazon Cognito in production). */
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    /** Derives checkpoint QR tokens (ARCH §11.1). Changing it invalidates every printed label. */
    QR_TOKEN_SECRET: z.string().min(32).default(DEV_QR_SECRET),
    /** Guard app versions (ARCH §15.2). */
    MOBILE_MIN_VERSION: z.string().default('0.0.0'),
    MOBILE_RECOMMENDED_VERSION: z.string().default('0.0.0'),
    MOBILE_REVOKED_VERSIONS: list,
    /** The disclosure text version guards must accept before tracking (SEC §16.3). */
    DISCLOSURE_VERSION: z.string().default(CURRENT_DISCLOSURE_VERSION),
    /** SOS stays off for pilot guards until the Phase 8 exit tests pass (ARCH §22). */
    FEATURE_SOS: flag,
    /** SEC §9: guard codes only for +92 numbers unless the operator allows other countries. */
    ALLOW_FOREIGN_GUARD_PHONES: flag,
    /**
     * Where incident photos live (ARCH §12, SEC §12): a private S3 bucket in AWS; a local folder,
     * reached through links this API signs, in development and tests only.
     */
    OBJECT_STORE: z.enum(['local', 's3']).default('local'),
    OBJECT_STORE_DIR: z.string().min(1).default('.local/objects'),
    LOCAL_OBJECT_SECRET: z.string().min(32).default(DEV_OBJECT_SECRET),
    /** The origin the local store's links use; the dashboard's by default (it proxies /api). */
    LOCAL_OBJECT_BASE_URL: z.url().optional(),
    S3_BUCKET: z.string().min(3).optional(),
    S3_REGION: z.string().min(1).optional(),
    /** Web Push for the dashboard (D-26): the VAPID key pair, base64url. Without it nobody subscribes. */
    WEB_PUSH_VAPID_PUBLIC_KEY: z.string().min(80).optional(),
    WEB_PUSH_VAPID_PRIVATE_KEY: z.string().min(40).optional(),
    /** Or the private key as a P-256 PEM (infra generates it); the public key is derived from it. */
    WEB_PUSH_VAPID_PRIVATE_KEY_PEM: z.string().startsWith('-----BEGIN').optional(),
    /**
     * Or only the public half, as a PEM: for the API, which tells browsers the key but never sends.
     * Only the worker holds the private key, so the internet-facing process can't forge a push.
     */
    WEB_PUSH_VAPID_PUBLIC_KEY_PEM: z.string().startsWith('-----BEGIN').optional(),
    /** Firebase Cloud Messaging for the guard app (D-26): the service account JSON. */
    FCM_SERVICE_ACCOUNT: z.string().min(2).optional(),
    /** SMS (D-08): no provider until EXT-10. `memory` keeps texts in memory, for tests. */
    SMS_PROVIDER: z.enum(['none', 'memory']).default('none'),
    /** Outside production, texts go only to these numbers (ARCH §13.4; SEC §20 #30). */
    SMS_ALLOWED_NUMBERS: list,
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV !== 'production') return;
    if (c.QR_TOKEN_SECRET === DEV_QR_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['QR_TOKEN_SECRET'], message: 'must be set in production' });
    }
    if (c.DEV_AUTH) {
      ctx.addIssue({ code: 'custom', path: ['DEV_AUTH'], message: 'must be false in production' });
    }
    if (!c.OIDC_ISSUER || !c.OIDC_CLIENT_ID || !c.OIDC_CLIENT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'an identity provider is required' });
    }
    if (!c.PUBLIC_ORIGIN.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'must be https in production' });
    }
    if (c.OBJECT_STORE !== 's3' || !c.S3_BUCKET) {
      ctx.addIssue({ code: 'custom', path: ['OBJECT_STORE'], message: 'production keeps photos in S3' });
    }
    if (c.SMS_PROVIDER === 'memory') {
      ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'memory is for tests' });
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
