// The S3 object store (ARCH §12): a private bucket (Block Public Access; infra/terraform), signed
// links for the phone's upload and the dashboard's view, and signed requests for the worker.
// Credentials come from the ECS task role (container credentials), or from the environment.
import type { Clock } from '@sentryops/domain';

import {
  isSafeKey,
  NO_OVERWRITE,
  UPLOAD_LINK_TTL_S,
  type ObjectStore,
  type SignedLink,
  type SignedUpload,
} from './objects.ts';
import { EMPTY_SHA256, presignUrl, sha256Hex, signedHeaders, type AwsCredentials } from './sigv4.ts';

type Fetch = typeof fetch;

export type CredentialSource = () => Promise<AwsCredentials>;

const REFRESH_MARGIN_MS = (UPLOAD_LINK_TTL_S + 5 * 60) * 1000;

/**
 * Task-role credentials from the ECS container endpoint, refreshed 20 minutes before they expire, so
 * a link signed with them (15 minutes at most) never outlives them; the environment's static keys
 * when they are set (local experiments only).
 */
export function containerCredentials(
  env: Readonly<Record<string, string | undefined>>,
  clock: Clock,
  fetcher: Fetch = fetch,
): CredentialSource {
  let cached: { credentials: AwsCredentials; expiresAtMs: number } | null = null;
  return async () => {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
      };
    }
    const now = clock.now().getTime();
    if (cached && cached.expiresAtMs - now > REFRESH_MARGIN_MS) return cached.credentials;
    const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    const url = relative ? `http://169.254.170.2${relative}` : full;
    if (!url) throw new Error('no AWS credentials: not on ECS and none in the environment');
    const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    const response = await fetcher(url, {
      headers: token ? { authorization: token } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`container credentials: HTTP ${response.status}`);
    const body = (await response.json()) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      Token?: string;
      Expiration?: string;
    };
    if (!body.AccessKeyId || !body.SecretAccessKey) throw new Error('container credentials: incomplete');
    const credentials = {
      accessKeyId: body.AccessKeyId,
      secretAccessKey: body.SecretAccessKey,
      sessionToken: body.Token,
    };
    cached = { credentials, expiresAtMs: body.Expiration ? Date.parse(body.Expiration) : now + 15 * 60_000 };
    return credentials;
  };
}

export class S3ObjectStore implements ObjectStore {
  readonly kind = 's3' as const;
  readonly #bucket: string;
  readonly #region: string;
  readonly #host: string;
  readonly #credentials: CredentialSource;
  readonly #clock: Clock;
  readonly #fetch: Fetch;

  constructor(options: {
    bucket: string;
    region: string;
    credentials: CredentialSource;
    clock: Clock;
    fetcher?: Fetch;
  }) {
    this.#bucket = options.bucket;
    this.#region = options.region;
    // Virtual-hosted style, in the bucket's own region.
    this.#host = `${options.bucket}.s3.${options.region}.amazonaws.com`;
    this.#credentials = options.credentials;
    this.#clock = options.clock;
    this.#fetch = options.fetcher ?? fetch;
  }

  #path(key: string): string {
    if (!isSafeKey(key)) throw new RangeError('unsafe object key');
    return `/${key}`;
  }

  async signUpload(
    key: string,
    contentType: string,
    contentLength: number,
    expiresInS: number,
  ): Promise<SignedUpload> {
    const at = this.#clock.now();
    // Signed headers: the phone must send them exactly, so it can't change the type, length or condition.
    const headers = { 'content-type': contentType, 'content-length': String(contentLength), ...NO_OVERWRITE };
    const url = presignUrl({
      method: 'PUT',
      host: this.#host,
      path: this.#path(key),
      headers,
      expiresInS,
      credentials: await this.#credentials(),
      region: this.#region,
      at,
    });
    return { url, method: 'PUT', headers, expiresAt: new Date(at.getTime() + expiresInS * 1000) };
  }

  async signDownload(key: string, expiresInS: number, downloadName?: string): Promise<SignedLink> {
    const at = this.#clock.now();
    const url = presignUrl({
      method: 'GET',
      host: this.#host,
      path: this.#path(key),
      ...(downloadName
        ? {
            query: {
              'response-content-disposition': `attachment; filename="${downloadName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
            },
          }
        : {}),
      expiresInS,
      credentials: await this.#credentials(),
      region: this.#region,
      at,
    });
    return { url, expiresAt: new Date(at.getTime() + expiresInS * 1000) };
  }

  async #request(method: 'HEAD' | 'GET' | 'PUT', key: string, body?: Buffer, contentType?: string) {
    const headers = signedHeaders({
      method,
      host: this.#host,
      path: this.#path(key),
      ...(contentType ? { headers: { 'content-type': contentType } } : {}),
      payloadHash: body ? sha256Hex(body) : EMPTY_SHA256,
      credentials: await this.#credentials(),
      region: this.#region,
      at: this.#clock.now(),
    });
    // fetch sets Host itself, from the URL, which is what was signed.
    const { host: _host, ...sent } = headers;
    return this.#fetch(`https://${this.#host}${this.#path(key)}`, {
      method,
      headers: sent,
      ...(body ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  }

  async size(key: string): Promise<number | null> {
    const response = await this.#request('HEAD', key);
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) throw new Error(`S3 HEAD: HTTP ${response.status}`);
    return Number(response.headers.get('content-length') ?? '0');
  }

  async read(key: string, maxBytes: number): Promise<Buffer | null> {
    const response = await this.#request('GET', key);
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) throw new Error(`S3 GET: HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > maxBytes) {
      await response.body?.cancel();
      throw new RangeError('object larger than allowed');
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maxBytes) throw new RangeError('object larger than allowed');
    return body;
  }

  async write(key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.#request('PUT', key, body, contentType);
    if (!response.ok) throw new Error(`S3 PUT: HTTP ${response.status}`);
  }

  /** For logs and errors: never a key or a URL. */
  toString(): string {
    return `S3ObjectStore(${this.#bucket})`;
  }
}
