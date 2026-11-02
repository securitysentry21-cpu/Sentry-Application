// Request signing for S3 (AWS Signature Version 4), checked against AWS's published examples, and the
// local store's signed links. The S3 store builds no public URL: every link is signed and expires.
import { FakeClock } from '@sentryops/domain';
import { describe, expect, it } from 'vitest';

import { LocalObjectStore } from '../src/storage/local.ts';
import { attachmentKeys, isSafeKey } from '../src/storage/objects.ts';
import { containerCredentials, S3ObjectStore } from '../src/storage/s3.ts';
import { EMPTY_SHA256, presignUrl, signedHeaders } from '../src/storage/sigv4.ts';

// AWS's example credentials (S3 API reference, "Authenticating Requests: AWS Signature Version 4").
const EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const AT = new Date('2013-05-24T00:00:00.000Z');

describe('AWS Signature Version 4', () => {
  it("matches AWS's presigned URL example", () => {
    const url = presignUrl({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      expiresInS: 86_400,
      credentials: EXAMPLE,
      region: 'us-east-1',
      at: AT,
    });
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it("matches AWS's signed GET Object example", () => {
    const headers = signedHeaders({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY_SHA256,
      credentials: EXAMPLE,
      region: 'us-east-1',
      at: AT,
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('an upload link holds the content type and the exact length; links name the bucket region and expire', async () => {
    const clock = new FakeClock('2026-11-02T10:00:00.000Z');
    const store = new S3ObjectStore({
      bucket: 'sentryops-test-photos',
      region: 'ap-southeast-2',
      credentials: () => Promise.resolve({ ...EXAMPLE, sessionToken: 'session-token' }),
      clock,
    });
    const key = attachmentKeys(
      '0190f6f6-0000-7000-8000-000000000001',
      '0190f6f6-0000-7000-8000-000000000002',
      '0190f6f6-0000-7000-8000-000000000003',
    ).original;
    const upload = await store.signUpload(key, 'image/jpeg', 12_345, 900);
    const url = new URL(upload.url);
    expect(url.host).toBe('sentryops-test-photos.s3.ap-southeast-2.amazonaws.com');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host;if-none-match',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('session-token');
    expect(upload.headers).toEqual({
      'content-type': 'image/jpeg',
      'content-length': '12345',
      'if-none-match': '*',
    });
    const download = await store.signDownload(key, 300, 'INC-000001-photo.jpg');
    expect(new URL(download.url).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(download.expiresAt.toISOString()).toBe('2026-11-02T10:05:00.000Z');
  });
});

describe('task-role credentials (ECS)', () => {
  it('are fetched from the container endpoint, kept, and renewed before a link signed with them could outlive them', async () => {
    const clock = new FakeClock('2026-11-02T10:00:00.000Z');
    let calls = 0;
    const fetcher = (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(url instanceof Request ? url.url : url.toString()).toBe(
        'http://169.254.170.2/v2/credentials/abc',
      );
      expect(init?.headers).toEqual({});
      const expires = new Date(clock.now().getTime() + 60 * 60_000).toISOString();
      return Promise.resolve(
        Response.json({
          AccessKeyId: `AK${calls}`,
          SecretAccessKey: 'secret',
          Token: 'token',
          Expiration: expires,
        }),
      );
    };
    const credentials = containerCredentials(
      { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' },
      clock,
      fetcher,
    );
    expect((await credentials()).accessKeyId).toBe('AK1');
    clock.advance(39 * 60_000); // 21 minutes left: still good for a 15-minute link
    expect((await credentials()).accessKeyId).toBe('AK1');
    clock.advance(2 * 60_000); // 19 minutes left: renewed
    expect((await credentials()).accessKeyId).toBe('AK2');
    expect(calls).toBe(2);
  });
});

describe('object keys and the local store', () => {
  it('keys are built from UUIDs only and can never climb out of the store', () => {
    expect(() => attachmentKeys('../etc', '1', '2')).toThrow(RangeError);
    expect(isSafeKey('org/a/incidents/b/c/original')).toBe(true);
    for (const bad of ['../x', '/x', 'a//b', 'a/../b', 'a\\b', '']) expect(isSafeKey(bad), bad).toBe(false);
  });

  it('a link is good for its method only, until it expires, and only as signed', () => {
    const clock = new FakeClock('2026-11-02T10:00:00.000Z');
    const store = new LocalObjectStore({
      root: '.local/never-written',
      secret: 'x'.repeat(40),
      baseUrl: 'http://x',
      clock,
    });
    const other = new LocalObjectStore({
      root: '.local/never-written',
      secret: 'y'.repeat(40),
      baseUrl: 'http://x',
      clock,
    });
    return store.signDownload('org/a/b', 300).then((link) => {
      const token = link.url.split('/').at(-1) ?? '';
      expect(store.verify(token, 'GET')?.key).toBe('org/a/b');
      expect(store.verify(token, 'PUT')).toBeNull();
      expect(other.verify(token, 'GET')).toBeNull();
      clock.advance(300_001);
      expect(store.verify(token, 'GET')).toBeNull();
    });
  });
});
