// The local object store, for development and tests only (production refuses it, config.ts). It
// behaves like S3's signed links: the API signs a token naming the key, the method, the expiry and,
// for uploads, the exact type and length; /api/v1/local-objects/:token serves it (routes/objects.ts).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type { Clock } from '@sentryops/domain';

import { isSafeKey, NO_OVERWRITE, type ObjectStore, type SignedLink, type SignedUpload } from './objects.ts';

export type LocalGrant = {
  readonly key: string;
  readonly method: 'PUT' | 'GET';
  readonly expiresAtMs: number;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly downloadName?: string;
};

export class LocalObjectStore implements ObjectStore {
  readonly kind = 'local' as const;
  readonly #root: string;
  readonly #secret: string;
  readonly #baseUrl: string;
  readonly #clock: Clock;

  constructor(options: { root: string; secret: string; baseUrl: string; clock: Clock }) {
    this.#root = resolve(options.root);
    this.#secret = options.secret;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#clock = options.clock;
  }

  #token(grant: LocalGrant): string {
    const payload = Buffer.from(
      JSON.stringify({
        k: grant.key,
        m: grant.method,
        e: grant.expiresAtMs,
        t: grant.contentType,
        l: grant.contentLength,
        n: grant.downloadName,
      }),
    ).toString('base64url');
    const mac = createHmac('sha256', this.#secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  /** The grant a token carries, if this store signed it, it hasn't expired, and it's for `method`. */
  verify(token: string, method: 'PUT' | 'GET'): LocalGrant | null {
    const [payload, mac] = token.split('.');
    if (!payload || !mac || token.split('.').length !== 2) return null;
    const expected = createHmac('sha256', this.#secret).update(payload).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let raw: { k?: unknown; m?: unknown; e?: unknown; t?: unknown; l?: unknown; n?: unknown };
    try {
      raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof raw;
    } catch {
      return null;
    }
    if (typeof raw.k !== 'string' || !isSafeKey(raw.k) || raw.m !== method || typeof raw.e !== 'number')
      return null;
    if (raw.e <= this.#clock.now().getTime()) return null;
    return {
      key: raw.k,
      method,
      expiresAtMs: raw.e,
      ...(typeof raw.t === 'string' ? { contentType: raw.t } : {}),
      ...(typeof raw.l === 'number' ? { contentLength: raw.l } : {}),
      ...(typeof raw.n === 'string' ? { downloadName: raw.n } : {}),
    };
  }

  #path(key: string): string {
    if (!isSafeKey(key)) throw new RangeError('unsafe object key');
    const path = resolve(join(this.#root, ...key.split('/')));
    if (!path.startsWith(this.#root + sep)) throw new RangeError('object key escapes the store');
    return path;
  }

  signUpload(
    key: string,
    contentType: string,
    contentLength: number,
    expiresInS: number,
  ): Promise<SignedUpload> {
    const expiresAtMs = this.#clock.now().getTime() + expiresInS * 1000;
    const token = this.#token({ key, method: 'PUT', expiresAtMs, contentType, contentLength });
    return Promise.resolve({
      url: `${this.#baseUrl}/api/v1/local-objects/${token}`,
      method: 'PUT',
      headers: { 'content-type': contentType, 'content-length': String(contentLength), ...NO_OVERWRITE },
      expiresAt: new Date(expiresAtMs),
    });
  }

  signDownload(key: string, expiresInS: number, downloadName?: string): Promise<SignedLink> {
    const expiresAtMs = this.#clock.now().getTime() + expiresInS * 1000;
    const token = this.#token({ key, method: 'GET', expiresAtMs, ...(downloadName ? { downloadName } : {}) });
    return Promise.resolve({
      url: `${this.#baseUrl}/api/v1/local-objects/${token}`,
      expiresAt: new Date(expiresAtMs),
    });
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.#path(key))).size;
    } catch {
      return null;
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer | null> {
    const size = await this.size(key);
    if (size === null) return null;
    if (size > maxBytes) throw new RangeError('object larger than allowed');
    return readFile(this.#path(key));
  }

  async write(key: string, body: Buffer): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${this.#clock.now().getTime()}.part`;
    await writeFile(temporary, body);
    await rename(temporary, path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  /** Like S3's `if-none-match: *`: false, and nothing written, when the object is already there. */
  async writeNew(key: string, body: Buffer): Promise<boolean> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, body, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }
}
