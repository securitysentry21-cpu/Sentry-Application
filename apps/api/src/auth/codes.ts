// Secrets handed to people or printed on labels.
//
// Enrollment codes (SEC §5): 8 characters from Crockford's base-32 alphabet (no I, L, O or U, so
// nothing is misread aloud), about 40 bits. Short enough to type, safe because each code is bound
// to a guard and a phone number, allows 5 attempts, and redemption is rate-limited (SEC §9).
//
// QR tokens (ARCH §11.1): HMAC-SHA256(secret, checkpointId ‖ version), truncated to 128 bits,
// base64url. Nothing is stored but the token's hash, and reprinting recomputes it.
import { createHmac, randomInt } from 'node:crypto';

import { sha256 } from '../ids.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ENROLLMENT_QR_PREFIX = 'SGE1:';
export const CHECKPOINT_QR_PREFIX = 'SG1:';

export function newEnrollmentCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Accepts what a guard types or scans: case, spaces, hyphens and the QR prefix don't matter. */
export function normalizeEnrollmentCode(input: string): string | null {
  const bare = input.trim().replace(new RegExp(`^${ENROLLMENT_QR_PREFIX}`, 'i'), '');
  const code = bare.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : null;
}

export const enrollmentCodeHash = (normalized: string) => sha256(`enrollment:${normalized}`);

export function checkpointToken(secret: string, checkpointId: string, version: number): string {
  return createHmac('sha256', secret)
    .update(`${checkpointId}:${version}`)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

export const checkpointQrContent = (token: string) => `${CHECKPOINT_QR_PREFIX}${token}`;

/** The token from a scanned label, or null if it isn't one of ours. */
export function parseCheckpointQr(content: string): string | null {
  const match = /^SG1:([A-Za-z0-9_-]{22})$/.exec(content.trim());
  return match?.[1] ?? null;
}

export const checkpointTokenHash = (token: string) => sha256(`checkpoint:${token}`);
