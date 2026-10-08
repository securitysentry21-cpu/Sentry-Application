// The device key (ARCH §5.3, D-30, round-6 decision "Device key"): a P-256 key pair made on the phone
// at first launch. The private key stays in the secure store; the public key is registered at
// enrollment as base64 SPKI DER. Requests signed with it carry X-Device-Signature, which the server
// accepts for POST /api/v1/sos when the session has expired (INV-15, ADV-S11).
//
// Signature format (v1), verified by the server exactly as built here:
//   X-Device-Signature: v1.<timestampMs>.<base64url(signature)>
//   signature = ECDSA P-256 with SHA-256 over the UTF-8 bytes of
//     "v1\n<METHOD>\n<path including /api/v1>\n<timestampMs>\n<base64url(sha256(body bytes))>"
//   encoded as the raw 64-byte r‖s (IEEE P1363), low-S.
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { base64Encode, base64UrlEncode, concatBytes, hexDecode, utf8Encode } from './encoding.ts';
import type { RandomBytes } from './ids.ts';

export const DEVICE_SIGNATURE_VERSION = 'v1';
export const DEVICE_SIGNATURE_HEADER = 'X-Device-Signature';

/** DER prefix of a P-256 SubjectPublicKeyInfo: SEQUENCE { AlgorithmIdentifier { ecPublicKey, prime256v1 }, BIT STRING }. */
export const P256_SPKI_PREFIX = hexDecode('3059301306072a8648ce3d020106082a8648ce3d030107034200');

/** A new 32-byte secret key. Randomness comes from the caller: React Native has no WebCrypto. */
export function generateSecretKey(random: RandomBytes): Uint8Array {
  // 48 bytes reduced modulo the group order (FIPS 186-5 A.2.1): unbiased and always a valid key.
  return p256.utils.randomSecretKey(random(p256.lengths.seed ?? 48));
}

export function isValidSecretKey(secretKey: Uint8Array): boolean {
  return secretKey.length === 32 && p256.utils.isValidSecretKey(secretKey);
}

/** The public key as SPKI DER: the fixed prefix and the 65-byte uncompressed point (04 ‖ X ‖ Y). */
export function publicKeySpkiDer(secretKey: Uint8Array): Uint8Array {
  return concatBytes(P256_SPKI_PREFIX, p256.getPublicKey(secretKey, false));
}

/** What enrollment sends as `publicKey` (base64, 124 characters). */
export function publicKeySpkiBase64(secretKey: Uint8Array): string {
  return base64Encode(publicKeySpkiDer(secretKey));
}

export type SignedRequest = {
  method: string;
  /** The request path including /api/v1, without query string, e.g. "/api/v1/sos". */
  path: string;
  timestampMs: number;
  /** The exact body bytes that go on the wire. */
  body: Uint8Array;
};

export function signingInput(request: SignedRequest): string {
  if (!request.path.startsWith('/api/v1/') || request.path.includes('?')) {
    throw new RangeError('the signed path is the API path including /api/v1, without a query string');
  }
  if (!Number.isSafeInteger(request.timestampMs) || request.timestampMs < 0) {
    throw new RangeError('timestampMs must be a non-negative integer');
  }
  return [
    DEVICE_SIGNATURE_VERSION,
    request.method.toUpperCase(),
    request.path,
    String(request.timestampMs),
    base64UrlEncode(sha256(request.body)),
  ].join('\n');
}

/** The X-Device-Signature header value for this request. */
export function deviceSignature(secretKey: Uint8Array, request: SignedRequest): string {
  // noble hashes the message with SHA-256 before signing (prehash) and signs deterministically
  // (RFC 6979), so no randomness is needed here. 'compact' is r ‖ s, 32 bytes each.
  const signature = p256.sign(utf8Encode(signingInput(request)), secretKey, {
    prehash: true,
    lowS: true,
    format: 'compact',
  });
  return `${DEVICE_SIGNATURE_VERSION}.${request.timestampMs}.${base64UrlEncode(signature)}`;
}
