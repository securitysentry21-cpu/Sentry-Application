// AWS Signature Version 4 for S3 (presigned links and signed requests), written against AWS's
// published description and checked against its published examples (test/storage.test.ts). Written
// here instead of pulling in the AWS SDK: two request shapes don't justify ~100 more packages in
// the server image (SEC §14).
import { createHash, createHmac } from 'node:crypto';

export type AwsCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
};

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export const EMPTY_SHA256 = sha256Hex('');
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** RFC 3986 encoding as SigV4 wants it; `/` is kept in paths. */
export function uriEncode(value: string, keepSlash: boolean): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** "20130524T000000Z" and "20130524". */
export function amzDate(at: Date): { dateTime: string; date: string } {
  const dateTime = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { dateTime, date: dateTime.slice(0, 8) };
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k] ?? '', false)}`)
    .join('&');
}

type Signed = { signature: string; signedHeaders: string; canonicalRequest: string; stringToSign: string };

function sign(input: {
  method: string;
  path: string;
  query: Readonly<Record<string, string>>;
  headers: Readonly<Record<string, string>>;
  payloadHash: string;
  credentials: AwsCredentials;
  region: string;
  service: string;
  at: Date;
}): Signed {
  const { dateTime, date } = amzDate(input.at);
  const names = Object.keys(input.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lowered = Object.fromEntries(
    Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]),
  );
  const canonicalHeaders = names.map((n) => `${n}:${lowered[n] ?? ''}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    uriEncode(input.path, true),
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', dateTime, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(
    signingKey(input.credentials.secretAccessKey, date, input.region, input.service),
    stringToSign,
  ).toString('hex');
  return { signature, signedHeaders, canonicalRequest, stringToSign };
}

/**
 * A presigned URL (query-string authentication). Every header in `headers` (host included) is
 * signed, so a PUT can be held to one content type and one exact length.
 */
export function presignUrl(input: {
  method: 'GET' | 'PUT';
  host: string;
  path: string;
  headers?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  expiresInS: number;
  credentials: AwsCredentials;
  region: string;
  at: Date;
  service?: string;
}): string {
  const service = input.service ?? 's3';
  const { dateTime, date } = amzDate(input.at);
  const headers = { host: input.host, ...(input.headers ?? {}) };
  const signedHeaders = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
    .join(';');
  const query: Record<string, string> = {
    ...(input.query ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${date}/${input.region}/${service}/aws4_request`,
    'X-Amz-Date': dateTime,
    'X-Amz-Expires': String(input.expiresInS),
    'X-Amz-SignedHeaders': signedHeaders,
    ...(input.credentials.sessionToken ? { 'X-Amz-Security-Token': input.credentials.sessionToken } : {}),
  };
  const { signature } = sign({
    method: input.method,
    path: input.path,
    query,
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
    credentials: input.credentials,
    region: input.region,
    service,
    at: input.at,
  });
  return `https://${input.host}${uriEncode(input.path, true)}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

/** Headers for a request signed in the Authorization header. */
export function signedHeaders(input: {
  method: string;
  host: string;
  path: string;
  headers?: Readonly<Record<string, string>>;
  payloadHash: string;
  credentials: AwsCredentials;
  region: string;
  at: Date;
  service?: string;
}): Record<string, string> {
  const service = input.service ?? 's3';
  const { dateTime, date } = amzDate(input.at);
  const headers: Record<string, string> = {
    host: input.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': dateTime,
    ...(input.credentials.sessionToken ? { 'x-amz-security-token': input.credentials.sessionToken } : {}),
    ...(input.headers ?? {}),
  };
  const signed = sign({
    method: input.method,
    path: input.path,
    query: {},
    headers,
    payloadHash: input.payloadHash,
    credentials: input.credentials,
    region: input.region,
    service,
    at: input.at,
  });
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${date}/${input.region}/${service}/aws4_request, SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}`,
  };
}
