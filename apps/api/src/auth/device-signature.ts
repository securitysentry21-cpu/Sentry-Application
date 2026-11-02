// Requests signed with the device key (ARCH §5.3, D-30): the SOS fallback when the session can't be
// used (INV-15, ADV-S11). Verified exactly as the guard app signs (apps/mobile/src/core/device-key.ts):
//   X-Device-Signature: v1.<timestampMs>.<base64url(r ‖ s)>
//   ECDSA P-256 with SHA-256 over "v1\n<METHOD>\n<path>\n<timestampMs>\n<base64url(sha256(body))>"
// The timestamp must be within five minutes of the server's clock; a replay inside that window
// repeats an idempotent request (every SOS item carries a clientEventId), so it changes nothing.
import { createHash, createPublicKey, verify } from 'node:crypto';

export const DEVICE_SIGNATURE_MAX_SKEW_MS = 5 * 60_000;

const HEADER = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{85,86})$/;

export type ParsedSignature = { readonly timestampMs: number; readonly signature: Buffer };

export function parseDeviceSignature(value: unknown): ParsedSignature | null {
  if (typeof value !== 'string') return null;
  const match = HEADER.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const signature = Buffer.from(match[2], 'base64url');
  if (signature.length !== 64) return null;
  return { timestampMs: Number(match[1]), signature };
}

export function signingInput(method: string, path: string, timestampMs: number, body: Buffer): string {
  const bodyHash = createHash('sha256').update(body).digest('base64url');
  return ['v1', method.toUpperCase(), path, String(timestampMs), bodyHash].join('\n');
}

/** True when `signature` is the device key's signature of this request, made within the window. */
export function verifyDeviceSignature(input: {
  publicKeySpki: Buffer;
  method: string;
  path: string;
  body: Buffer;
  signature: ParsedSignature;
  nowMs: number;
}): boolean {
  if (Math.abs(input.nowMs - input.signature.timestampMs) > DEVICE_SIGNATURE_MAX_SKEW_MS) return false;
  try {
    const key = createPublicKey({ key: input.publicKeySpki, format: 'der', type: 'spki' });
    const data = Buffer.from(
      signingInput(input.method, input.path, input.signature.timestampMs, input.body),
      'utf8',
    );
    return verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, input.signature.signature);
  } catch {
    return false;
  }
}
