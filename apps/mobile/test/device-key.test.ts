import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

import { enrollmentRedeemRequestSchema } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import {
  deviceSignature,
  generateSecretKey,
  isValidSecretKey,
  P256_SPKI_PREFIX,
  publicKeySpkiBase64,
  publicKeySpkiDer,
  signingInput,
} from '../src/core/device-key.ts';
import { hexDecode, utf8Encode } from '../src/core/encoding.ts';
import { cryptoRandom } from './support/fakes.ts';

// A fixed key, so the expected public key and signatures can be checked against independent tools.
const FIXED_SECRET = hexDecode('c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721');

/** Exactly what the server must do with an X-Device-Signature header. */
function serverVerifies(
  spkiDer: Uint8Array,
  header: string,
  method: string,
  path: string,
  body: string,
): boolean {
  const [version, timestamp, signature] = header.split('.');
  if (version !== 'v1' || !timestamp || !signature) return false;
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('base64url');
  const data = `v1\n${method}\n${path}\n${timestamp}\n${bodyHash}`;
  return verify(
    'sha256',
    Buffer.from(data, 'utf8'),
    { key: Buffer.from(spkiDer), format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
}

describe('device key and X-Device-Signature (ADV-S11, INV-15)', () => {
  const body = JSON.stringify({ clientEventId: '0190a0d2-7c5e-7000-8000-000000000999', fix: null });
  const request = {
    method: 'POST',
    path: '/api/v1/sos',
    timestampMs: 1_791_450_000_123,
    body: utf8Encode(body),
  };

  it('ADV-S11 a signature from the phone verifies with node:crypto (SPKI DER, SHA-256, IEEE P1363)', () => {
    const header = deviceSignature(FIXED_SECRET, request);
    expect(header).toMatch(/^v1\.1791450000123\.[A-Za-z0-9_-]{86}$/);
    expect(serverVerifies(publicKeySpkiDer(FIXED_SECRET), header, 'POST', '/api/v1/sos', body)).toBe(true);
  });

  it('ADV-S11 verifies for freshly generated keys too, and the raw r‖s signature is 64 bytes', () => {
    for (let i = 0; i < 10; i++) {
      const secret = generateSecretKey(cryptoRandom);
      expect(isValidSecretKey(secret)).toBe(true);
      const header = deviceSignature(secret, request);
      expect(Buffer.from(header.split('.')[2] ?? '', 'base64url')).toHaveLength(64);
      expect(serverVerifies(publicKeySpkiDer(secret), header, 'POST', '/api/v1/sos', body)).toBe(true);
    }
  });

  it('fails verification when the body, path, method, timestamp or key differ', () => {
    const header = deviceSignature(FIXED_SECRET, request);
    const spki = publicKeySpkiDer(FIXED_SECRET);
    expect(serverVerifies(spki, header, 'POST', '/api/v1/sos', `${body} `)).toBe(false);
    expect(serverVerifies(spki, header, 'POST', '/api/v1/sync/batch', body)).toBe(false);
    expect(serverVerifies(spki, header, 'PUT', '/api/v1/sos', body)).toBe(false);
    expect(
      serverVerifies(spki, header.replace('1791450000123', '1791450000124'), 'POST', '/api/v1/sos', body),
    ).toBe(false);
    const other = publicKeySpkiDer(generateSecretKey(cryptoRandom));
    expect(serverVerifies(other, header, 'POST', '/api/v1/sos', body)).toBe(false);
  });

  it('signs the canonical string v1\\nMETHOD\\npath\\ntimestamp\\nbase64url(sha256(body))', () => {
    const expectedHash = createHash('sha256').update(body, 'utf8').digest('base64url');
    expect(signingInput(request)).toBe(`v1\nPOST\n/api/v1/sos\n1791450000123\n${expectedHash}`);
    expect(() => signingInput({ ...request, path: '/sos' })).toThrow();
    expect(() => signingInput({ ...request, path: '/api/v1/sos?x=1' })).toThrow();
  });

  it('exports the public key as base64 SPKI DER that Node imports and the contract accepts', () => {
    const der = publicKeySpkiDer(FIXED_SECRET);
    expect(der).toHaveLength(91);
    expect([...der.slice(0, P256_SPKI_PREFIX.length)]).toEqual([...P256_SPKI_PREFIX]);
    const key = createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' });
    expect(key.asymmetricKeyType).toBe('ec');
    expect(key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    // Same bytes as Node's own encoding of a P-256 public key, so the prefix is right.
    const nodeKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
      format: 'der',
      type: 'spki',
    });
    expect([...nodeKey.subarray(0, P256_SPKI_PREFIX.length)]).toEqual([...P256_SPKI_PREFIX]);

    const base64 = publicKeySpkiBase64(FIXED_SECRET);
    expect(base64).toHaveLength(124);
    const shape = enrollmentRedeemRequestSchema.shape.publicKey.safeParse(base64);
    expect(shape.success).toBe(true);
  });

  it('never needs randomness to sign (deterministic RFC 6979)', () => {
    expect(deviceSignature(FIXED_SECRET, request)).toBe(deviceSignature(FIXED_SECRET, request));
  });
});
