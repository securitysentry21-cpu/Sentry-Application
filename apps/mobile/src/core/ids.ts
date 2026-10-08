// Identifiers made on the phone. clientEventId is a UUIDv7 (RFC 9562 §5.7): the idempotency key of
// every offline event (INV-06), time-ordered so the server's indexes stay compact.
import { base64UrlEncode, hexEncode } from './encoding.ts';
import type { WallClock } from './time.ts';

/** Cryptographically secure random bytes (expo-crypto on the phone, node:crypto in tests). */
export type RandomBytes = (length: number) => Uint8Array;

export type IdFactory = {
  /** A new UUIDv7. Monotonic within this process even when the wall clock stands still. */
  uuidv7(): string;
  /** A random (version 4) UUID, for the installation ID. */
  uuidv4(): string;
  /** A short random token (base64url), e.g. for the run ID. */
  token(bytes?: number): string;
};

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isUuidV7 = (value: string): boolean => UUID_V7.test(value);
export const isUuidV4 = (value: string): boolean => UUID_V4.test(value);

function format(bytes: Uint8Array): string {
  const hex = hexEncode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The Unix-millisecond timestamp encoded in a UUIDv7. */
export function uuidV7Timestamp(uuid: string): number {
  return Number.parseInt(uuid.replace(/-/g, '').slice(0, 12), 16);
}

export function createIdFactory(random: RandomBytes, wall: WallClock): IdFactory {
  // RFC 9562 §6.2 method 1: a 12-bit counter in rand_a, seeded randomly each new millisecond and
  // incremented within the same millisecond. If the wall clock goes backwards (the guard changed the
  // time), the last timestamp is kept so IDs still sort in creation order.
  let lastMs = -1;
  let counter = 0;

  return {
    uuidv7() {
      let ms = Math.max(0, Math.floor(wall.nowMs()));
      if (ms > lastMs) {
        lastMs = ms;
        const seed = random(2);
        counter = (((seed[0] ?? 0) << 8) | (seed[1] ?? 0)) & 0x7ff; // top bit clear: room to count
      } else {
        ms = lastMs;
        counter++;
        if (counter > 0xfff) {
          lastMs++;
          ms = lastMs;
          counter = 0;
        }
      }
      const bytes = new Uint8Array(16);
      bytes.set(random(8), 8);
      // 48-bit big-endian timestamp. Bit operations are 32-bit in JS, so split by division.
      const high = Math.floor(ms / 2 ** 16);
      bytes[0] = (high >>> 24) & 0xff;
      bytes[1] = (high >>> 16) & 0xff;
      bytes[2] = (high >>> 8) & 0xff;
      bytes[3] = high & 0xff;
      bytes[4] = (ms >>> 8) & 0xff;
      bytes[5] = ms & 0xff;
      bytes[6] = 0x70 | ((counter >>> 8) & 0x0f); // version 7
      bytes[7] = counter & 0xff;
      bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // variant 10
      return format(bytes);
    },
    uuidv4() {
      const bytes = random(16);
      bytes[6] = 0x40 | ((bytes[6] ?? 0) & 0x0f);
      bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
      return format(bytes);
    },
    token(length = 16) {
      return base64UrlEncode(random(length));
    },
  };
}
