import { randomBytes } from 'node:crypto';

import { syncItemSchema } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import {
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  hexDecode,
  hexEncode,
} from '../src/core/encoding.ts';
import { createIdFactory, isUuidV4, isUuidV7, uuidV7Timestamp } from '../src/core/ids.ts';
import { ManualClocks } from '../src/core/time.ts';
import { cryptoRandom } from './support/fakes.ts';

describe('encodings (no Buffer on the phone)', () => {
  it('base64 and base64url match Node for every length 0–64', () => {
    for (let n = 0; n <= 64; n++) {
      const bytes = new Uint8Array(randomBytes(n));
      const buffer = Buffer.from(bytes);
      expect(base64Encode(bytes)).toBe(buffer.toString('base64'));
      expect(base64UrlEncode(bytes)).toBe(buffer.toString('base64url'));
      expect([...base64Decode(buffer.toString('base64'))]).toEqual([...bytes]);
      expect([...base64UrlDecode(buffer.toString('base64url'))]).toEqual([...bytes]);
      expect([...hexDecode(hexEncode(bytes))]).toEqual([...bytes]);
    }
  });

  it('rejects malformed input instead of guessing', () => {
    expect(() => base64Decode('ab$d')).toThrow();
    expect(() => base64Decode('abcde')).toThrow();
    expect(() => hexDecode('abc')).toThrow();
    expect(() => hexDecode('zz')).toThrow();
  });
});

describe('UUIDv7 client event IDs (INV-06)', () => {
  const clocks = new ManualClocks(Date.parse('2026-10-08T15:00:00.000Z'));
  const ids = createIdFactory(cryptoRandom, clocks.wall);

  it('INV-06 every clientEventId is an RFC 9562 version-7 UUID the contract accepts', () => {
    for (let i = 0; i < 200; i++) {
      const id = ids.uuidv7();
      expect(isUuidV7(id)).toBe(true);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    const item = {
      clientEventId: ids.uuidv7(),
      type: 'HEARTBEAT',
      recordedAt: '2026-10-08T15:00:00.000Z',
      monoMs: 5,
      shiftId: null,
    };
    expect(syncItemSchema.safeParse(item).success).toBe(true);
  });

  it('encodes the wall-clock millisecond in the first 48 bits', () => {
    expect(uuidV7Timestamp(ids.uuidv7())).toBe(clocks.wall.nowMs());
    clocks.advance(1234);
    expect(uuidV7Timestamp(ids.uuidv7())).toBe(clocks.wall.nowMs());
  });

  it('sorts in creation order within one millisecond and when the clock is turned back', () => {
    const made: string[] = [];
    for (let i = 0; i < 5000; i++) made.push(ids.uuidv7()); // same millisecond: the counter orders them
    clocks.setWall(clocks.wall.nowMs() - 3_600_000); // the guard sets the phone an hour back
    for (let i = 0; i < 10; i++) made.push(ids.uuidv7());
    expect(new Set(made).size).toBe(made.length);
    expect([...made].sort()).toEqual(made);
  });

  it('makes version-4 installation IDs from secure randomness', () => {
    const a = ids.uuidv4();
    expect(isUuidV4(a)).toBe(true);
    expect(a).not.toBe(ids.uuidv4());
  });
});
