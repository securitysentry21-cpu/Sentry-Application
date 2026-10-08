// UUIDv7 primary keys, generated in the API (ARCH §6.1): 48-bit Unix milliseconds from the
// injected clock, then version, variant and 74 random bits, so IDs sort by creation time.
import { createHash, randomBytes } from 'node:crypto';

import type { Clock } from '@sentryops/domain';

export function uuidv7(clock: Clock): string {
  const bytes = randomBytes(16);
  const ms = BigInt(clock.now().getTime());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A random secret, base64url. 32 bytes = 256 bits; never fewer than 16 (SEC §5). */
export function randomToken(bytes = 32): string {
  if (bytes < 16) throw new RangeError('tokens are at least 128 bits');
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored as SHA-256: they are long and random, so a slow hash adds nothing (ARCH §11.1). */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
