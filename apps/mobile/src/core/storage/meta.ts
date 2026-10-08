// Small persistent key-value settings in the local database (the `meta` table): cached mobile
// config, accepted disclosure version, chosen language, sync bookkeeping. Never secrets: tokens and
// the device key live in the secure store (SEC §5, §11).
import type { SqlDatabase, SqlExecutor } from './sql.ts';

export const META_KEYS = {
  installMarker: 'install.marker',
  locale: 'app.locale',
  identity: 'identity.profile',
  config: 'config.mobile',
  configFetchedAtMs: 'config.fetchedAtMs',
  consentVersion: 'consent.version',
  consentLocale: 'consent.locale',
  signedOut: 'session.signedOut',
  updateRequired: 'app.updateRequired',
  serverOffsetMs: 'time.serverOffsetMs',
  lastSuccessfulSyncAtMs: 'sync.lastSuccessAtMs',
  discarded: 'outbox.discarded',
  shiftsCache: 'shifts.cache',
  trackingRuntime: 'tracking.runtime',
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];

export class MetaStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  async get(key: MetaKey): Promise<string | null> {
    const row = await this.#db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  async set(key: MetaKey, value: string, tx?: SqlExecutor): Promise<void> {
    await (tx ?? this.#db).run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }

  async delete(key: MetaKey, tx?: SqlExecutor): Promise<void> {
    await (tx ?? this.#db).run('DELETE FROM meta WHERE key = ?', [key]);
  }

  async getJson<T>(key: MetaKey): Promise<T | null> {
    const text = await this.get(key);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: MetaKey, value: unknown, tx?: SqlExecutor): Promise<void> {
    await this.set(key, JSON.stringify(value), tx);
  }

  async getNumber(key: MetaKey): Promise<number | null> {
    const text = await this.get(key);
    if (text === null) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
}
