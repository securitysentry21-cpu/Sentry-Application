// The guard app's engine room. One instance per JavaScript runtime, shared by the screens and the
// headless location task. It owns the outbox, the session, the sync and SOS lanes, the local shift
// records and the tracking lifecycle, and exposes a snapshot the screens render. Pure TypeScript:
// every phone capability comes in through ports (src/core/ports.ts), so all of this runs in tests.
import {
  DEVICE_KEY_ALGORITHM,
  type DeviceStatus,
  type Fix,
  type GuardShift,
  type INCIDENT_SEVERITIES,
  type MobileConfig,
  type SyncItem,
} from '@sentryops/contracts';

import { ApiClient } from './api/client.ts';
import { ApiError, NetworkError, SignedOutError, type SignedOutReason } from './api/errors.ts';
import type { HttpTransport } from './api/http.ts';
import { SessionManager, sessionFromTokens } from './api/session.ts';
import {
  effectiveSettings,
  type EffectiveSettings,
  type RuntimeConfig,
  versionGate,
  type VersionGate,
} from './config.ts';
import { publicKeySpkiBase64 } from './device-key.ts';
import { disclosureFor } from './i18n/disclosure.ts';
import {
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
  type MessageKey,
  type Params,
  translate,
} from './i18n/index.ts';
import {
  loadOrCreateInstallation,
  secureSessionStore,
  type Installation,
  wipeSecureStore,
} from './identity.ts';
import { createIdFactory, type IdFactory, type RandomBytes } from './ids.ts';
import { errorKind, type Logger } from './log.ts';
import {
  type DiscardedSummary,
  Outbox,
  type Partition,
  partitionKey,
  type QueueStats,
  type Receipt,
} from './outbox/outbox.ts';
import type { DevicePort, LocationPort, SecureKV } from './ports.ts';
import { ServerTime } from './server-time.ts';
import {
  canResume,
  failsafeDeadlineMs,
  type LocalShift,
  newLocalShift,
  type ShiftEvent,
  shiftReducer,
  shouldTrack,
} from './shift/local-shift.ts';
import { LocalShiftStore } from './shift/store.ts';
import { type Scheduler, SosLane } from './sos/lane.ts';
import type { SosState } from './sos/machine.ts';
import { syncDisplay, type SyncDisplay } from './status.ts';
import { META_KEYS, MetaStore } from './storage/meta.ts';
import { configureConnection, migrate, SchemaTooNewError } from './storage/schema.ts';
import type { SqlDatabase } from './storage/sql.ts';
import { type BatchExchange, SyncEngine, type SyncStatus } from './sync/engine.ts';
import { type Clocks, HOUR, isoFromMs, MINUTE, msFromIso } from './time.ts';
import {
  buildDeviceStatus,
  type DeviceProbe,
  significantChange,
  trackingProblem,
  type TrackingProblem,
  trackingServiceState,
} from './tracking/device-status.ts';
import { captureAgeMs, isPlausibleCoordinate, type RawFix, toContractFix } from './tracking/fix.ts';
import { readiness, type ReadinessItem } from './tracking/readiness.ts';
import { initialSamplerState, sample, type SamplerState } from './tracking/sampler.ts';

// ── Types the screens use ────────────────────────────────────────────────────────────────────

export type IdentityProfile = {
  readonly deviceId: string;
  readonly guardId: string;
  readonly organizationId: string;
  readonly guardDisplayName: string;
  readonly organizationName: string;
  readonly preferredLocale: Locale;
  readonly enrolledAtMs: number;
};

export type AppPhase = 'BOOTING' | 'STORAGE_ERROR' | 'CHOOSE_LANGUAGE' | 'ENROLL' | 'SIGNED_OUT' | 'READY';

export type TrackingView = {
  readonly lastFixAtMs: number | null;
  readonly lastFixAccuracyM: number | null;
  readonly running: boolean | null;
  readonly problem: TrackingProblem | null;
};

export type AppSnapshot = {
  readonly phase: AppPhase;
  readonly locale: Locale;
  readonly variant: RuntimeConfig['variant'];
  readonly appVersion: string;
  readonly platform: 'ANDROID' | 'IOS';
  readonly installationId: string | null;
  readonly identity: IdentityProfile | null;
  readonly config: MobileConfig | null;
  readonly settings: EffectiveSettings;
  readonly versionGate: VersionGate;
  /** The disclosure must be (re)accepted before tracking; `bundled` says whether this build has its text. */
  readonly consent: {
    readonly required: boolean;
    readonly version: string | null;
    readonly bundled: boolean;
  };
  readonly shifts: readonly GuardShift[];
  readonly shiftsFetchedAtMs: number | null;
  readonly shiftsFromCache: boolean;
  readonly localShifts: Readonly<Record<string, LocalShift>>;
  readonly tracking: TrackingView;
  readonly probe: DeviceProbe | null;
  readonly queue: QueueStats;
  readonly discarded: DiscardedSummary;
  readonly sync: SyncStatus;
  readonly syncDisplay: SyncDisplay;
  readonly serverOffsetMs: number | null;
  readonly clockSkewed: boolean;
  readonly sos: SosState | null;
  readonly signedOutReason: SignedOutReason | null;
  readonly storageError: string | null;
};

export type EnrollInput = {
  readonly code: string;
  readonly phone: string;
  readonly confirmDataLoss: boolean;
};

export type EnrollErrorReason =
  | 'INVALID'
  | 'EXPIRED'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'PHONE_FORMAT'
  | 'CODE_FORMAT'
  | 'ACTIVE_SHIFT'
  | 'GENERIC';

export type EnrollResult =
  | { readonly kind: 'OK' }
  | { readonly kind: 'NEEDS_CONFIRMATION'; readonly pending: number }
  | { readonly kind: 'ERROR'; readonly reason: EnrollErrorReason; readonly code?: string | undefined };

export type StartResult =
  | { readonly kind: 'OK'; readonly clientEventId: string }
  | { readonly kind: 'BLOCKED'; readonly items: readonly ReadinessItem[] }
  | { readonly kind: 'NO_FIX' }
  | { readonly kind: 'NOT_ALLOWED' };

export type IncidentInput = {
  readonly shiftId: string;
  readonly type: string;
  readonly severity: (typeof INCIDENT_SEVERITIES)[number];
  readonly title: string;
  readonly description: string;
};

export type Diagnostics = {
  readonly recent: readonly Receipt[];
  readonly bootId: string;
  readonly deviceId: string | null;
};

export type GuardAppDeps = {
  readonly openDatabase: () => Promise<SqlDatabase>;
  readonly secure: SecureKV;
  readonly transport: HttpTransport;
  readonly location: LocationPort;
  readonly device: DevicePort;
  readonly runtime: RuntimeConfig;
  readonly appVersion: string;
  readonly clocks: Clocks;
  readonly random: RandomBytes;
  readonly random01: () => number;
  readonly logger: Logger;
  readonly schedule?: Scheduler;
};

/** What the phone remembers about tracking across process runs (meta `tracking.runtime`). */
type TrackingRuntime = {
  lastFixAtMs: number | null;
  lastFixAccuracyM: number | null;
  lastHeartbeatAtMs: number | null;
  lastCallbackAtMs: number | null;
  lastStatusAtMs: number | null;
  lastStatus: DeviceStatus | null;
};

const EMPTY_QUEUE: QueueStats = {
  pending: 0,
  pendingMain: 0,
  pendingSos: 0,
  inBatch: 0,
  oldestRecordedAtMs: null,
};
const NO_DISCARDS: DiscardedSummary = { count: 0, lastReason: null, lastAtMs: null };
const IDLE_SYNC: SyncStatus = {
  inFlight: false,
  consecutiveFailures: 0,
  backoffUntilMs: 0,
  retryAfterUntilMs: 0,
  lastAttemptAtMs: null,
  lastSuccessAtMs: null,
  lastError: null,
  blocked: null,
};

/** Wait up to 10 s for a good on-demand fix, keep the best (PROD §8.2). */
const ON_DEMAND_FIX = { timeoutMs: 10_000, targetAccuracyM: 20 } as const;
/** A DEVICE_STATUS goes up at least this often during a shift, even with no change. */
const STATUS_REFRESH_MS = 15 * MINUTE;
/** A gap between location callbacks longer than this is reported as an interruption. */
const INTERRUPTION_MIN_MS = 5 * MINUTE;
/** For an SOS, a tracking fix this recent is attached at once instead of waiting for a new one. */
const SOS_RECENT_FIX_MS = 60_000;
const HOUSEKEEPING_EVERY_MS = 10 * MINUTE;
const KEEP_FINISHED_MS = 7 * 24 * HOUR;

export class GuardApp {
  readonly #deps: GuardAppDeps;
  readonly #ids: IdFactory;
  readonly #serverTime = new ServerTime();
  readonly #listeners = new Set<() => void>();

  #db: SqlDatabase | null = null;
  #meta: MetaStore | null = null;
  #outbox: Outbox | null = null;
  #shiftStore: LocalShiftStore | null = null;
  #session: SessionManager | null = null;
  #api: ApiClient | null = null;
  #engine: SyncEngine | null = null;
  #sos: SosLane | null = null;
  #installation: Installation | null = null;

  #phase: AppPhase = 'BOOTING';
  #storageError: string | null = null;
  #locale: Locale | null = null;
  #identity: IdentityProfile | null = null;
  #config: MobileConfig | null = null;
  #consentVersion: string | null = null;
  #shifts: GuardShift[] = [];
  #shiftsFetchedAtMs: number | null = null;
  #shiftsFromCache = false;
  readonly #local = new Map<string, LocalShift>();
  #sampler: SamplerState = initialSamplerState;
  #tracking: TrackingRuntime = {
    lastFixAtMs: null,
    lastFixAccuracyM: null,
    lastHeartbeatAtMs: null,
    lastCallbackAtMs: null,
    lastStatusAtMs: null,
    lastStatus: null,
  };
  #lastRawFix: RawFix | null = null;
  #trackingRunning: boolean | null = null;
  #probe: DeviceProbe | null = null;
  #queue: QueueStats = EMPTY_QUEUE;
  #discarded: DiscardedSummary = NO_DISCARDS;
  #signedOut: SignedOutReason | null = null;
  #lastFlushAttemptMs = 0;
  #lastHousekeepingMs = 0;
  /** Server time and the monotonic clock at the last response: a floor for "now" if the phone clock is set back. */
  #anchor: { serverMs: number; monoMs: number } | null = null;
  #started: Promise<void> | null = null;
  #snapshot: AppSnapshot | null = null;

  constructor(deps: GuardAppDeps) {
    this.#deps = deps;
    this.#ids = createIdFactory(deps.random, deps.clocks.wall);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────

  /** Opens storage and restores state. Idempotent: the screens and the location task share it. */
  start(): Promise<void> {
    this.#started ??= this.#start();
    return this.#started;
  }

  async #start(): Promise<void> {
    const deps = this.#deps;
    let db: SqlDatabase;
    try {
      db = await deps.openDatabase();
      await configureConnection(db);
      await migrate(db);
    } catch (error) {
      this.#phase = 'STORAGE_ERROR';
      this.#storageError = error instanceof SchemaTooNewError ? 'SCHEMA_TOO_NEW' : errorKind(error);
      deps.logger.error('storage.open-failed', { errorKind: this.#storageError });
      this.#emit();
      return;
    }
    this.#db = db;
    const meta = new MetaStore(db);
    this.#meta = meta;
    const outbox = new Outbox(db, meta, () => deps.clocks.wall.nowMs());
    this.#outbox = outbox;
    const shiftStore = new LocalShiftStore(db, () => deps.clocks.wall.nowMs());
    this.#shiftStore = shiftStore;

    // A brand-new database means a new installation: forget any Keychain leftovers (iOS keeps them).
    if ((await meta.get(META_KEYS.installMarker)) === null) {
      await wipeSecureStore(deps.secure);
      await meta.set(META_KEYS.installMarker, isoFromMs(deps.clocks.wall.nowMs()));
    }
    const installation = await loadOrCreateInstallation(deps.secure, this.#ids, deps.random);
    this.#installation = installation;

    const locale = await meta.get(META_KEYS.locale);
    this.#locale = isLocale(locale) ? locale : null;
    this.#identity = await meta.getJson<IdentityProfile>(META_KEYS.identity);
    this.#config = await meta.getJson<MobileConfig>(META_KEYS.config);
    this.#consentVersion = await meta.get(META_KEYS.consentVersion);
    const offset = await meta.getNumber(META_KEYS.serverOffsetMs);
    if (offset !== null) this.#serverTime.restore(offset);
    const cached = await meta.getJson<{ fetchedAtMs: number; shifts: GuardShift[] }>(META_KEYS.shiftsCache);
    if (cached) {
      this.#shifts = cached.shifts;
      this.#shiftsFetchedAtMs = cached.fetchedAtMs;
      this.#shiftsFromCache = true;
    }
    this.#tracking = (await meta.getJson<TrackingRuntime>(META_KEYS.trackingRuntime)) ?? this.#tracking;
    const signedOut = await meta.get(META_KEYS.signedOut);
    this.#signedOut = signedOut === null ? null : (signedOut as SignedOutReason);

    const api = new ApiClient({
      baseUrl: deps.runtime.apiBaseUrl,
      transport: deps.transport,
      app: { version: deps.appVersion, platform: deps.device.info.platform },
      ids: this.#ids,
      wall: deps.clocks.wall,
      serverTime: this.#serverTime,
      logger: deps.logger,
      deviceId: () => this.#identity?.deviceId ?? null,
      onServerTime: (offsetMs) => this.#onServerTime(offsetMs),
    });
    this.#api = api;
    const session = new SessionManager({
      store: secureSessionStore(deps.secure),
      refresh: (refreshToken) => api.refreshSession(refreshToken),
      now: () => this.#serverNow(),
      logger: deps.logger,
      onSignedOut: (reason) => this.#onSignedOut(reason),
    });
    this.#session = session;
    const stored = await session.load();
    if (stored && this.#identity && stored.guardId !== this.#identity.guardId) {
      // Never pair one guard's session with another guard's identity.
      await session.signOut('NO_SESSION');
    }

    const engine = new SyncEngine({
      outbox,
      send: (body) => session.withAuth((token) => api.syncBatch(token, body)),
      clocks: deps.clocks,
      ids: this.#ids,
      random01: deps.random01,
      logger: deps.logger,
      partition: () => this.#partition(),
      maxBatchItems: () => this.settings.sync.maxBatchItems,
      heldTypes: () => heldItemTypes(this.settings),
      onExchange: (exchange) => this.#onExchange(exchange),
      onBlocked: (block) => this.#onSyncBlocked(block),
      initialLastSuccessAtMs: await meta.getNumber(META_KEYS.lastSuccessfulSyncAtMs),
    });
    this.#engine = engine;
    engine.subscribe(() => this.#emit());
    if (this.#signedOut) engine.block('SIGNED_OUT');
    if ((await meta.get(META_KEYS.updateRequired)) === 'REVOKED') engine.block('UPDATE_REQUIRED');

    const sos = new SosLane({
      outbox,
      api,
      session,
      identity: () => {
        const identity = this.#identity;
        return identity
          ? {
              partition: { organizationId: identity.organizationId, guardId: identity.guardId },
              deviceId: identity.deviceId,
            }
          : null;
      },
      deviceKey: () => Promise.resolve(installation.secretKey),
      clocks: deps.clocks,
      serverTime: this.#serverTime,
      ids: this.#ids,
      random01: deps.random01,
      logger: deps.logger,
      onChange: () => this.#emit(),
      ...(deps.schedule ? { schedule: deps.schedule } : {}),
    });
    this.#sos = sos;

    const identity = this.#identity;
    if (identity) {
      for (const shift of await shiftStore.all(partitionKeyOf(identity)))
        this.#local.set(shift.shiftId, shift);
      await this.#recoverUnqueuedEnds();
      await sos.restore();
    }
    this.#phase = this.#computePhase();
    // After a kill, reboot or update mid-shift: resume tracking where the platform allows (ARCH §8.8),
    // and make sure nothing tracks when no shift should be.
    await this.#tick();
    await this.#reconcileTracking();
    await this.#refreshCounts();
    this.#emit();
  }

  #computePhase(): AppPhase {
    if (this.#storageError) return 'STORAGE_ERROR';
    if (this.#locale === null) return 'CHOOSE_LANGUAGE';
    if (!this.#identity) return 'ENROLL';
    if (!this.#session?.current) return 'SIGNED_OUT';
    return 'READY';
  }

  // ── Snapshot for the screens ───────────────────────────────────────────────────────────────

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): AppSnapshot {
    this.#snapshot ??= this.#buildSnapshot();
    return this.#snapshot;
  }

  #emit(): void {
    this.#snapshot = null;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // a screen never breaks the engine
      }
    }
  }

  get settings(): EffectiveSettings {
    return effectiveSettings(this.#config);
  }

  get locale(): Locale {
    return this.#locale ?? DEFAULT_LOCALE;
  }

  #buildSnapshot(): AppSnapshot {
    const sync = this.#engine?.status() ?? IDLE_SYNC;
    const consentVersion = this.#config?.disclosureVersion ?? null;
    return {
      phase: this.#phase,
      locale: this.locale,
      variant: this.#deps.runtime.variant,
      appVersion: this.#deps.appVersion,
      platform: this.#deps.device.info.platform,
      installationId: this.#installation?.installationId ?? null,
      identity: this.#identity,
      config: this.#config,
      settings: this.settings,
      versionGate: versionGate(this.#deps.appVersion, this.#config),
      consent: {
        required: consentVersion !== null && this.#consentVersion !== consentVersion,
        version: consentVersion,
        bundled: consentVersion !== null && disclosureFor(consentVersion, this.locale) !== null,
      },
      shifts: this.#shifts,
      shiftsFetchedAtMs: this.#shiftsFetchedAtMs,
      shiftsFromCache: this.#shiftsFromCache,
      localShifts: Object.fromEntries(this.#local),
      tracking: {
        lastFixAtMs: this.#tracking.lastFixAtMs,
        lastFixAccuracyM: this.#tracking.lastFixAccuracyM,
        running: this.#trackingRunning,
        problem: this.#probe ? trackingProblem(this.#probe) : null,
      },
      probe: this.#probe,
      queue: this.#queue,
      discarded: this.#discarded,
      sync,
      syncDisplay: syncDisplay({
        queue: this.#queue,
        sync,
        signedOut: this.#signedOut !== null,
        discarded: this.#discarded,
      }),
      serverOffsetMs: this.#serverTime.offsetMs,
      clockSkewed: this.#serverTime.skewed,
      sos: this.#sos?.latest() ?? null,
      signedOutReason: this.#signedOut,
      storageError: this.#storageError,
    };
  }

  // ── Small helpers ──────────────────────────────────────────────────────────────────────────

  #requireOutbox(): Outbox {
    if (!this.#outbox) throw new Error('storage is not open');
    return this.#outbox;
  }

  /** The partition uploads may use: only the signed-in guard's (ADV-O07). */
  #partition(): Partition | null {
    const session = this.#session?.current;
    const identity = this.#identity;
    if (!session || !identity) return null;
    if (session.guardId !== identity.guardId || session.organizationId !== identity.organizationId)
      return null;
    return { organizationId: session.organizationId, guardId: session.guardId };
  }

  /** The enrolled guard's partition, also while signed out (captured data keeps its owner). */
  #identityPartition(): Partition | null {
    const identity = this.#identity;
    return identity ? { organizationId: identity.organizationId, guardId: identity.guardId } : null;
  }

  /**
   * Server time now, estimated: the phone clock plus the last measured offset, and never earlier
   * than the monotonic estimate from the last response, so a clock turned back cannot postpone the
   * failsafe within one run.
   */
  #serverNow(): number {
    const { clocks } = this.#deps;
    const corrected = this.#serverTime.correct(clocks.wall.nowMs());
    if (!this.#anchor) return corrected;
    return Math.max(corrected, this.#anchor.serverMs + (clocks.mono.nowMs() - this.#anchor.monoMs));
  }

  #onServerTime(offsetMs: number): void {
    const { clocks } = this.#deps;
    this.#anchor = { serverMs: clocks.wall.nowMs() + offsetMs, monoMs: clocks.mono.nowMs() };
    void this.#meta?.set(META_KEYS.serverOffsetMs, String(offsetMs));
  }

  #t(key: MessageKey, params?: Params): string {
    return translate(this.locale, key, params);
  }

  async #refreshCounts(): Promise<void> {
    const outbox = this.#outbox;
    if (!outbox) return;
    this.#queue = await outbox.stats();
    this.#discarded = await outbox.discardedSummary();
  }

  async #saveTracking(): Promise<void> {
    await this.#meta?.setJson(META_KEYS.trackingRuntime, this.#tracking);
  }

  async #applyShift(shiftId: string, event: ShiftEvent, endsAtMs: number): Promise<LocalShift> {
    const current =
      this.#local.get(shiftId) ?? newLocalShift(shiftId, endsAtMs, this.settings.shift.autoEndAfterMinutes);
    const next = shiftReducer(current, event);
    if (next !== current || !this.#local.has(shiftId)) {
      this.#local.set(shiftId, next);
      this.#snapshot = null; // the screens must never show a shift state that is no longer true
      const identity = this.#identity;
      if (identity) await this.#shiftStore?.put(partitionKeyOf(identity), next);
    }
    return next;
  }

  #trackedShift(): LocalShift | null {
    const now = this.#serverNow();
    for (const shift of this.#local.values()) if (shouldTrack(shift, now)) return shift;
    return null;
  }

  #fix(raw: RawFix, ageMs: number): Fix {
    return toContractFix(raw, {
      ...(this.#deps.device.info.platform === 'ANDROID' ? { provider: 'FUSED' as const } : {}),
      fixAgeS: ageMs / 1_000,
    });
  }

  // ── Language ───────────────────────────────────────────────────────────────────────────────

  async setLocale(locale: Locale): Promise<void> {
    this.#locale = locale;
    await this.#meta?.set(META_KEYS.locale, locale);
    if (this.#phase === 'CHOOSE_LANGUAGE') this.#phase = this.#computePhase();
    this.#emit();
  }

  // ── Enrollment (ARCH §5.3; a lent phone, ADV-O07) ──────────────────────────────────────────

  async enroll(input: EnrollInput): Promise<EnrollResult> {
    const outbox = this.#requireOutbox();
    const api = this.#api;
    const session = this.#session;
    const installation = this.#installation;
    const meta = this.#meta;
    if (!api || !session || !installation || !meta) return { kind: 'ERROR', reason: 'GENERIC' };
    if (this.#trackedShift()) return { kind: 'ERROR', reason: 'ACTIVE_SHIFT' };

    const code = input.code.trim();
    if (code.length < 6 || code.length > 64) return { kind: 'ERROR', reason: 'CODE_FORMAT' };
    const phone = normalizePhone(input.phone);
    if (!phone) return { kind: 'ERROR', reason: 'PHONE_FORMAT' };

    // Data still on the phone: the signed-in guard's own data goes first, then what is left is counted.
    if (this.#partition()) await this.flush({ urgent: true });
    const pending = (await outbox.stats()).pending;
    if (pending > 0 && !input.confirmDataLoss) return { kind: 'NEEDS_CONFIRMATION', pending };

    const info = this.#deps.device.info;
    let response;
    try {
      response = await api.redeemEnrollment({
        code,
        phone,
        installationId: installation.installationId,
        publicKey: publicKeySpkiBase64(installation.secretKey),
        keyAlgorithm: DEVICE_KEY_ALGORITHM,
        platform: info.platform,
        ...(info.manufacturer ? { manufacturer: info.manufacturer.slice(0, 120) } : {}),
        ...(info.model ? { model: info.model.slice(0, 120) } : {}),
        osVersion: info.osVersion.slice(0, 40),
        appVersion: this.#deps.appVersion.slice(0, 40),
      });
    } catch (error) {
      return { kind: 'ERROR', ...enrollmentError(error) };
    }

    const identity: IdentityProfile = {
      deviceId: response.deviceId,
      guardId: response.guard.id,
      organizationId: response.organization.id,
      guardDisplayName: response.guard.displayName,
      organizationName: response.organization.name,
      preferredLocale: response.guard.preferredLocale,
      enrolledAtMs: this.#deps.clocks.wall.nowMs(),
    };
    const newKey = partitionKeyOf(identity);
    const previous = this.#identity;
    await session.establish(
      sessionFromTokens(
        { deviceId: identity.deviceId, guardId: identity.guardId, organizationId: identity.organizationId },
        response.session,
      ),
    );
    await meta.setJson(META_KEYS.identity, identity);
    await meta.delete(META_KEYS.signedOut);
    this.#identity = identity;
    this.#signedOut = null;
    // Another guard's unsent data can never be sent with this session: delete it, as confirmed.
    await outbox.discardOtherPartitions(newKey);
    if (!previous || partitionKeyOf(previous) !== newKey) {
      this.#local.clear();
      this.#shifts = [];
      this.#shiftsFetchedAtMs = null;
      this.#shiftsFromCache = false;
      this.#consentVersion = null;
      await meta.delete(META_KEYS.consentVersion);
      await meta.delete(META_KEYS.shiftsCache);
    }
    this.#engine?.unblock();
    this.#phase = this.#computePhase();
    await this.#refreshCounts();
    this.#emit();
    this.#deps.logger.info('enrollment.done', { deviceId: identity.deviceId });
    void this.refresh().then(() => this.flush({ urgent: true }));
    return { kind: 'OK' };
  }

  // ── Server reads: config and shifts (ARCH §8.8: server state wins) ─────────────────────────

  /** GET /mobile/config and GET /me/shifts, then reconcile. Errors are logged, never thrown. */
  async refresh(): Promise<void> {
    await this.start();
    const session = this.#session;
    const api = this.#api;
    const meta = this.#meta;
    if (!session?.current || !api || !meta) return;
    try {
      const config = await session.withAuth((token) => api.getMobileConfig(token));
      this.#config = config;
      await meta.setJson(META_KEYS.config, config);
      await meta.set(META_KEYS.configFetchedAtMs, String(this.#deps.clocks.wall.nowMs()));
      await this.#applyVersionGate();
    } catch (error) {
      await this.#readFailed('config', error);
    }
    try {
      const response = await session.withAuth((token) => api.getMyShifts(token));
      this.#shifts = response.shifts;
      this.#shiftsFetchedAtMs = this.#deps.clocks.wall.nowMs();
      this.#shiftsFromCache = false;
      await meta.setJson(META_KEYS.shiftsCache, {
        fetchedAtMs: this.#shiftsFetchedAtMs,
        shifts: response.shifts,
      });
      const now = this.#serverNow();
      for (const shift of response.shifts) {
        // Only shifts this phone acted on, or that are active on the server (e.g. started by a supervisor).
        if (!this.#local.has(shift.id) && shift.status !== 'ACTIVE') continue;
        const endsAtMs = msFromIso(shift.endsAt);
        await this.#applyShift(
          shift.id,
          { type: 'SERVER_STATUS', status: shift.status, endsAtMs, nowMs: now },
          endsAtMs,
        );
      }
    } catch (error) {
      await this.#readFailed('shifts', error);
    }
    await this.#reconcileTracking();
    this.#emit();
  }

  async #readFailed(what: string, error: unknown): Promise<void> {
    if (error instanceof ApiError && error.status === 426)
      await this.#meta?.set(META_KEYS.updateRequired, 'REQUIRED');
    this.#deps.logger.info('refresh.failed', {
      reason: what,
      errorKind: errorKind(error),
      httpStatus: error instanceof ApiError ? error.status : null,
    });
  }

  async #applyVersionGate(): Promise<void> {
    const gate = versionGate(this.#deps.appVersion, this.#config);
    if (gate === 'REVOKED') {
      await this.#meta?.set(META_KEYS.updateRequired, 'REVOKED');
      this.#engine?.block('UPDATE_REQUIRED');
      await this.#haltTracking('UPDATE_REQUIRED');
    } else {
      await this.#meta?.delete(META_KEYS.updateRequired);
      if (this.#engine?.status().blocked === 'UPDATE_REQUIRED') this.#engine.unblock();
    }
  }

  // ── Consent (PROD §7.2, SEC §16.3) ─────────────────────────────────────────────────────────

  /** Records acceptance of the current disclosure version. Throws if the server did not record it. */
  async acceptDisclosure(): Promise<void> {
    const version = this.#config?.disclosureVersion;
    const session = this.#session;
    const api = this.#api;
    if (!version || !session || !api) throw new Error('no disclosure to accept');
    if (!disclosureFor(version, this.locale)) throw new Error('this build does not contain that disclosure');
    const locale = this.locale;
    await session.withAuth((token) => api.postTrackingConsent(token, { disclosureVersion: version, locale }));
    this.#consentVersion = version;
    await this.#meta?.set(META_KEYS.consentVersion, version);
    await this.#meta?.set(META_KEYS.consentLocale, locale);
    this.#emit();
  }

  // ── Readiness and permissions ──────────────────────────────────────────────────────────────

  /** Reads permissions, battery and services again (after a permission prompt, or back in the app). */
  async probeDevice(): Promise<DeviceProbe | null> {
    let probe = this.#probe;
    try {
      probe = await this.#deps.device.probe();
    } catch (error) {
      this.#deps.logger.warn('device.probe-failed', { errorKind: errorKind(error) });
    }
    let running: boolean | null;
    try {
      running = await this.#deps.location.isRunning();
    } catch {
      running = null;
    }
    // Only a real change replaces the probe and re-renders: screens that re-check readiness when the
    // probe changes must not set off another probe by themselves.
    if (JSON.stringify(probe) !== JSON.stringify(this.#probe) || running !== this.#trackingRunning) {
      this.#probe = probe;
      this.#trackingRunning = running;
      this.#emit();
    }
    return this.#probe;
  }

  async readinessItems(): Promise<ReadinessItem[]> {
    const probe = await this.probeDevice();
    let network: boolean | null;
    try {
      network = await this.#deps.device.networkAvailable();
    } catch {
      network = null;
    }
    const snapshot = this.snapshot();
    return readiness(
      {
        signedIn: this.#partition() !== null,
        versionBlocked: snapshot.versionGate === 'REVOKED' || snapshot.versionGate === 'UPDATE_REQUIRED',
        consentCurrent: snapshot.consent.version !== null && !snapshot.consent.required,
        probe,
        networkAvailable: network,
        clockSkewed: this.#serverTime.skewed,
        platform: this.#deps.device.info.platform,
      },
      this.settings.shift,
    );
  }

  // ── Shift actions ──────────────────────────────────────────────────────────────────────────

  async startShift(shiftId: string): Promise<StartResult> {
    await this.start();
    const outbox = this.#requireOutbox();
    const partition = this.#partition();
    const shift = this.#shifts.find((s) => s.id === shiftId);
    if (!partition || !shift) return { kind: 'NOT_ALLOWED' };
    const local = this.#local.get(shiftId);
    if (local && local.phase !== 'NOT_STARTED' && local.phase !== 'START_REJECTED')
      return { kind: 'NOT_ALLOWED' };
    if (this.#trackedShift()) return { kind: 'NOT_ALLOWED' };

    const items = await this.readinessItems();
    const probe = this.#probe;
    if (!probe || items.some((i) => i.level === 'BLOCKING')) return { kind: 'BLOCKED', items };

    const raw = await this.#onDemandFix();
    const { clocks } = this.#deps;
    const now = clocks.wall.nowMs();
    if (!raw) return { kind: 'NO_FIX' };
    const ageMs = captureAgeMs(raw, now);
    if (ageMs > this.settings.shift.startMaxFixAgeSeconds * 1_000) return { kind: 'NO_FIX' };

    const clientEventId = this.#ids.uuidv7();
    const item: SyncItem = {
      clientEventId,
      type: 'SHIFT_START',
      recordedAt: isoFromMs(now),
      monoMs: clocks.mono.nowMs(),
      bootId: clocks.bootId,
      shiftId,
      fix: this.#fix(raw, ageMs),
      permission: { location: probe.locationPermission, precise: probe.preciseLocation },
    };
    await outbox.enqueue(partition, item);
    const endsAtMs = msFromIso(shift.endsAt);
    await this.#applyShift(
      shiftId,
      {
        type: 'START_QUEUED',
        eventId: clientEventId,
        atMs: now,
        endsAtMs,
        autoEndAfterMinutes: this.settings.shift.autoEndAfterMinutes,
      },
      endsAtMs,
    );
    // Offline start is allowed (D-06): tracking starts now; the server confirms later (ADV-O02).
    this.#sampler = initialSamplerState;
    this.#tracking = { ...this.#tracking, lastCallbackAtMs: null, lastHeartbeatAtMs: null };
    await this.#reconcileTracking();
    await this.#reportDeviceStatus(true);
    await this.#refreshCounts();
    this.#emit();
    void this.flush({ urgent: true });
    return { kind: 'OK', clientEventId };
  }

  /** PROD §6.6: tracking stops the moment End is tapped; the end item is queued with a fresh fix. */
  async endShift(shiftId: string): Promise<string | null> {
    await this.start();
    const outbox = this.#requireOutbox();
    const partition = this.#partition() ?? this.#identityPartition();
    const local = this.#local.get(shiftId);
    if (!partition || !local) return null;
    const { clocks } = this.#deps;
    const clientEventId = this.#ids.uuidv7();
    const tappedAt = clocks.wall.nowMs();
    const tappedMono = clocks.mono.nowMs(); // recordedAt and monoMs describe the same instant: the tap
    const ended = await this.#applyShift(
      shiftId,
      { type: 'END_QUEUED', eventId: clientEventId, atMs: tappedAt },
      local.endsAtMs,
    );
    if (ended.endEventId !== clientEventId) return null;
    await this.#reconcileTracking(); // location updates stop now (INV-08)
    this.#emit();

    const raw = await this.#onDemandFix();
    const now = clocks.wall.nowMs();
    await outbox.enqueue(partition, {
      clientEventId,
      type: 'SHIFT_END',
      recordedAt: isoFromMs(tappedAt),
      monoMs: tappedMono,
      bootId: clocks.bootId,
      shiftId,
      fix: raw ? this.#fix(raw, captureAgeMs(raw, now)) : null,
    });
    await this.#refreshCounts();
    this.#emit();
    void this.flush({ urgent: true });
    return clientEventId;
  }

  /** "Resume tracking": the shift was extended, a supervisor started it, or the guard signed back in. */
  async resumeTracking(shiftId: string): Promise<boolean> {
    await this.start();
    const local = this.#local.get(shiftId);
    if (!local || !this.#partition() || !canResume(local, this.#serverNow())) return false;
    const next = await this.#applyShift(
      shiftId,
      {
        type: 'RESUME',
        atMs: this.#serverNow(),
        autoEndAfterMinutes: this.settings.shift.autoEndAfterMinutes,
      },
      local.endsAtMs,
    );
    this.#sampler = initialSamplerState;
    await this.#reconcileTracking();
    await this.#reportDeviceStatus(true);
    this.#emit();
    return next.tracking;
  }

  /**
   * If the app died between End and queuing SHIFT_END, queue it now, without a fix. The tap happened
   * in an earlier run whose monotonic clock is gone: no bootId, so the server uses recordedAt.
   */
  async #recoverUnqueuedEnds(): Promise<void> {
    const outbox = this.#outbox;
    const partition = this.#identityPartition();
    if (!outbox || !partition) return;
    for (const shift of this.#local.values()) {
      if (shift.phase !== 'ENDED' || shift.endResult !== 'PENDING' || !shift.endEventId) continue;
      if (await outbox.receipt(shift.endEventId)) continue;
      await outbox.enqueue(partition, {
        clientEventId: shift.endEventId,
        type: 'SHIFT_END',
        recordedAt: isoFromMs(shift.endedAtMs ?? this.#deps.clocks.wall.nowMs()),
        monoMs: 0,
        shiftId: shift.shiftId,
        fix: null,
      });
    }
  }

  // ── Incidents (PROD §7.8; text only in this build) ─────────────────────────────────────────

  async reportIncident(input: IncidentInput): Promise<string | null> {
    await this.start();
    const outbox = this.#requireOutbox();
    const partition = this.#partition() ?? this.#identityPartition();
    const tracked = this.#trackedShift();
    // The server accepts incidents only once the organization has them switched on.
    if (!this.settings.features.incidents) return null;
    // INV-08: incidents only during an active shift (an open SOS is the other case, not in this build).
    if (!partition || !tracked || tracked.shiftId !== input.shiftId) return null;
    const raw = await this.#onDemandFix();
    const { clocks } = this.#deps;
    const now = clocks.wall.nowMs();
    const clientEventId = this.#ids.uuidv7();
    await outbox.enqueue(partition, {
      clientEventId,
      type: 'INCIDENT',
      recordedAt: isoFromMs(now),
      monoMs: clocks.mono.nowMs(),
      bootId: clocks.bootId,
      shiftId: input.shiftId,
      incident: {
        type: input.type.slice(0, 40),
        severity: input.severity,
        title: input.title.trim().slice(0, 120),
        description: input.description.trim().slice(0, 4_000),
        occurredAt: isoFromMs(now),
      },
      fix: raw ? this.#fix(raw, captureAgeMs(raw, now)) : null,
    });
    await this.#refreshCounts();
    this.#emit();
    void this.flush({ urgent: true });
    return clientEventId;
  }

  async receipt(clientEventId: string): Promise<Receipt | null> {
    return (await this.#outbox?.receipt(clientEventId)) ?? null;
  }

  // ── SOS (PROD §11; offered only when features.sos is on) ───────────────────────────────────

  /** Saves and sends an SOS at once; never waits for a fix (a recent tracking fix rides along). */
  async triggerSos(): Promise<string> {
    await this.start();
    const sos = this.#sos;
    if (!sos) throw new SignedOutError('NO_SESSION');
    const now = this.#deps.clocks.wall.nowMs();
    const lastFixAt = this.#tracking.lastFixAtMs;
    const recent =
      this.#lastRawFix && lastFixAt !== null && now - lastFixAt <= SOS_RECENT_FIX_MS
        ? this.#lastRawFix
        : null;
    const clientEventId = await sos.trigger(recent ? this.#fix(recent, captureAgeMs(recent, now)) : null);
    // PROD §11.2 step 3: the best fix within 10 s goes up as a location update. The contract has no
    // SOS location item yet, so during a shift it travels as a LOCATION item of that shift.
    void this.#sosLocationUpdate();
    return clientEventId;
  }

  async #sosLocationUpdate(): Promise<void> {
    const tracked = this.#trackedShift();
    const partition = this.#partition() ?? this.#identityPartition();
    if (!tracked || !partition) return;
    const raw = await this.#onDemandFix();
    if (!raw) return;
    await this.#enqueueLocation(partition, tracked, raw);
    await this.#refreshCounts();
    void this.flush({ urgent: true });
  }

  // ── Location (the background task and on-demand fixes) ─────────────────────────────────────

  async #onDemandFix(): Promise<RawFix | null> {
    try {
      const fix = await this.#deps.location.currentFix(ON_DEMAND_FIX);
      return fix && isPlausibleCoordinate(fix) ? fix : null;
    } catch (error) {
      this.#deps.logger.warn('location.on-demand-failed', { errorKind: errorKind(error) });
      return null;
    }
  }

  /**
   * Readings from the background location task (also with the screens closed). The failsafe is
   * checked first (ADV-SH05); then the sampler's points are queued, a heartbeat goes in when due, and
   * an upload starts when due.
   */
  async onLocations(readings: readonly RawFix[]): Promise<void> {
    await this.start();
    if (!this.#outbox) return;
    const { clocks } = this.#deps;
    await this.#tick(); // failsafe and housekeeping before anything is recorded
    const tracked = this.#trackedShift();
    const partition = this.#partition() ?? this.#identityPartition();
    if (!tracked || !partition) {
      await this.#reconcileTracking(); // nothing should be tracking: make sure updates are off (INV-08)
      this.#emit();
      return;
    }
    const wallNow = clocks.wall.nowMs();
    // A long silence between callbacks is a gap the guard and the supervisor should know about.
    const lastCallback = this.#tracking.lastCallbackAtMs;
    const gapLimit = Math.max(INTERRUPTION_MIN_MS, 3 * this.settings.tracking.maxIntervalS * 1_000);
    if (lastCallback !== null && wallNow - lastCallback > gapLimit) {
      await this.#applyShift(
        tracked.shiftId,
        { type: 'INTERRUPTION', fromMs: lastCallback, toMs: wallNow },
        tracked.endsAtMs,
      );
    }
    this.#tracking = { ...this.#tracking, lastCallbackAtMs: wallNow };

    const deadline = failsafeDeadlineMs(tracked);
    const startedAt = tracked.startedAtMs ?? 0;
    const sorted = readings.filter(isPlausibleCoordinate).sort((a, b) => a.timestampMs - b.timestampMs);
    for (const raw of sorted) {
      const ageMs = captureAgeMs(raw, wallNow);
      const capturedWall = wallNow - ageMs;
      if (capturedWall < startedAt - 60_000) continue; // a cached reading from before the start
      if (this.#serverTime.correct(capturedWall) >= deadline) continue; // INV-08: nothing after the deadline
      const decision = sample(this.#sampler, raw, capturedWall, this.settings.tracking);
      this.#sampler = decision.state;
      this.#lastRawFix = raw;
      this.#tracking = { ...this.#tracking, lastFixAtMs: capturedWall, lastFixAccuracyM: raw.accuracyM };
      if (decision.record) await this.#enqueueLocation(partition, tracked, raw, ageMs);
    }
    await this.#heartbeatIfDue(partition, tracked);
    await this.#saveTracking();
    await this.#refreshCounts();
    this.#emit();
    await this.#flushIfDue();
  }

  async #enqueueLocation(
    partition: Partition,
    shift: LocalShift,
    raw: RawFix,
    ageMs?: number,
  ): Promise<void> {
    const { clocks, device } = this.#deps;
    const wallNow = clocks.wall.nowMs();
    const age = ageMs ?? captureAgeMs(raw, wallNow);
    // The library gives no per-fix monotonic time: monoMs is the callback's, minus the fix's age by
    // the phone clock (bounded to 10 minutes; see README, "Time and the monotonic clock").
    await this.#requireOutbox().enqueue(partition, {
      clientEventId: this.#ids.uuidv7(),
      type: 'LOCATION',
      recordedAt: isoFromMs(wallNow - age),
      monoMs: Math.max(0, clocks.mono.nowMs() - age),
      bootId: clocks.bootId,
      shiftId: shift.shiftId,
      fix: toContractFix(raw, device.info.platform === 'ANDROID' ? { provider: 'FUSED' } : {}),
    });
  }

  async #heartbeatIfDue(partition: Partition, shift: LocalShift): Promise<void> {
    const { clocks } = this.#deps;
    const now = clocks.wall.nowMs();
    const last = this.#tracking.lastHeartbeatAtMs;
    if (last !== null && now >= last && now - last < this.settings.sync.heartbeatIntervalS * 1_000) return;
    await this.#requireOutbox().enqueue(partition, {
      clientEventId: this.#ids.uuidv7(),
      type: 'HEARTBEAT',
      recordedAt: isoFromMs(now),
      monoMs: clocks.mono.nowMs(),
      bootId: clocks.bootId,
      shiftId: shift.shiftId,
    });
    this.#tracking = { ...this.#tracking, lastHeartbeatAtMs: now };
    await this.#reportDeviceStatus(false);
  }

  /** DEVICE_STATUS at once on a meaningful change (or when forced), and every 15 minutes in a shift. */
  async #reportDeviceStatus(force: boolean): Promise<void> {
    const partition = this.#partition() ?? this.#identityPartition();
    const outbox = this.#outbox;
    if (!partition || !outbox) return;
    const probe = await this.probeDevice();
    if (!probe) return;
    const queue = await outbox.stats(partitionKey(partition));
    const lastSuccess = this.#engine?.status().lastSuccessAtMs ?? null;
    const status = buildDeviceStatus(probe, trackingServiceState(probe, this.#trackingRunning), {
      pendingQueueCount: queue.pending,
      oldestPendingAt: queue.oldestRecordedAtMs === null ? null : isoFromMs(queue.oldestRecordedAtMs),
      lastSuccessfulSyncAt: lastSuccess === null ? null : isoFromMs(lastSuccess),
    });
    const { clocks } = this.#deps;
    const now = clocks.wall.nowMs();
    const lastAt = this.#tracking.lastStatusAtMs;
    const due = lastAt === null || now - lastAt >= STATUS_REFRESH_MS || now < lastAt;
    if (!force && !due && !significantChange(this.#tracking.lastStatus, status)) return;
    await outbox.enqueue(partition, {
      clientEventId: this.#ids.uuidv7(),
      type: 'DEVICE_STATUS',
      recordedAt: isoFromMs(now),
      monoMs: clocks.mono.nowMs(),
      bootId: clocks.bootId,
      shiftId: this.#trackedShift()?.shiftId ?? null,
      status,
    });
    this.#tracking = { ...this.#tracking, lastStatusAtMs: now, lastStatus: status };
    await this.#saveTracking();
  }

  /** The location task reported an error (permission revoked, services off): report it now (ADV-U02). */
  async onLocationError(): Promise<void> {
    await this.start();
    if (!this.#trackedShift()) return;
    await this.#reportDeviceStatus(true);
    await this.#refreshCounts();
    this.#emit();
    await this.flush({ urgent: true });
  }

  /** A permission or setting may have changed (back from Settings, after a prompt). */
  async onPermissionsChanged(): Promise<void> {
    await this.start();
    await this.probeDevice();
    if (this.#trackedShift()) {
      await this.#reportDeviceStatus(false);
      await this.#reconcileTracking();
      await this.#refreshCounts();
    }
    this.#emit();
  }

  // ── Tracking lifecycle (ARCH §8.8) ─────────────────────────────────────────────────────────

  /** Starts or stops background updates so they run exactly while a shift should be tracked. */
  async #reconcileTracking(): Promise<void> {
    const { location, logger, appVersion } = this.#deps;
    const now = this.#serverNow();
    const want =
      [...this.#local.values()].some((s) => shouldTrack(s, now)) &&
      this.#partition() !== null &&
      versionGate(appVersion, this.#config) !== 'REVOKED';
    let running: boolean | null;
    try {
      running = await location.isRunning();
    } catch {
      running = null;
    }
    try {
      if (want && running !== true) {
        await location.startUpdates({
          timeIntervalMs: this.settings.tracking.minIntervalS * 1_000,
          distanceIntervalM: 0,
          notificationTitle: this.#t('notification.title'),
          notificationBody: this.#t('notification.body', { org: this.#identity?.organizationName ?? '' }),
        });
        running = true;
      } else if (!want && running !== false) {
        await location.stopUpdates();
        running = false;
      }
    } catch (error) {
      // Android may refuse to start a location service from the background. The guard is prompted
      // when the app is next opened, and the gap shows on the dashboard.
      logger.warn('tracking.reconcile-failed', { errorKind: errorKind(error), tracking: want });
      running = await location.isRunning().catch(() => null);
    }
    this.#trackingRunning = running;
  }

  async #haltTracking(reason: 'SIGNED_OUT' | 'UPDATE_REQUIRED'): Promise<void> {
    const atMs = this.#deps.clocks.wall.nowMs();
    for (const shift of [...this.#local.values()]) {
      if (shift.tracking)
        await this.#applyShift(shift.shiftId, { type: 'TRACKING_HALTED', reason, atMs }, shift.endsAtMs);
    }
    await this.#reconcileTracking();
  }

  async #onSignedOut(reason: SignedOutReason): Promise<void> {
    this.#signedOut = reason;
    await this.#meta?.set(META_KEYS.signedOut, reason);
    this.#engine?.block('SIGNED_OUT');
    await this.#haltTracking('SIGNED_OUT'); // stop tracking, keep the queue (ARCH §5.3)
    this.#phase = this.#computePhase();
    await this.#refreshCounts();
    this.#emit();
  }

  #onSyncBlocked(block: 'SIGNED_OUT' | 'UPDATE_REQUIRED'): void {
    if (block === 'UPDATE_REQUIRED') {
      void this.#meta?.set(META_KEYS.updateRequired, 'REVOKED');
      void this.#haltTracking('UPDATE_REQUIRED').then(() => this.#emit());
    }
    this.#emit();
  }

  // ── Sync ───────────────────────────────────────────────────────────────────────────────────

  /** Uploads both lanes. Urgent: start, end, incidents, a regained network ("Send now"). */
  async flush(options: { urgent?: boolean } = {}): Promise<void> {
    await this.start();
    const engine = this.#engine;
    if (!engine) return;
    this.#lastFlushAttemptMs = this.#deps.clocks.wall.nowMs();
    try {
      await engine.flush(options);
    } catch (error) {
      this.#deps.logger.error('sync.flush-crashed', { errorKind: errorKind(error) });
    }
    try {
      await this.#sos?.flush();
    } catch (error) {
      this.#deps.logger.error('sos.flush-crashed', { errorKind: errorKind(error) });
    }
    await this.#refreshCounts();
    this.#emit();
  }

  async #flushIfDue(): Promise<void> {
    const now = this.#deps.clocks.wall.nowMs();
    const interval = this.settings.sync.uploadIntervalS * 1_000;
    if (now >= this.#lastFlushAttemptMs && now - this.#lastFlushAttemptMs < interval) return;
    await this.flush();
  }

  /** A regained network: forget the exponential backoff (never Retry-After) and try both lanes. */
  async onNetworkRegained(): Promise<void> {
    await this.start();
    this.#engine?.resetBackoff();
    await this.#sos?.retryNow();
    await this.flush({ urgent: true });
  }

  async #onExchange(exchange: BatchExchange): Promise<void> {
    const outbox = this.#requireOutbox();
    const now = this.#serverNow();
    // 1. Server state first: it wins (ARCH §8.8).
    for (const s of exchange.response.shifts) {
      const endsAtMs = msFromIso(s.endsAt);
      if (this.#local.has(s.shiftId) || s.status === 'ACTIVE') {
        await this.#applyShift(
          s.shiftId,
          { type: 'SERVER_STATUS', status: s.status, endsAtMs, nowMs: now },
          endsAtMs,
        );
      }
      this.#shifts = this.#shifts.map((x) =>
        x.id === s.shiftId ? { ...x, status: s.status, endsAt: s.endsAt } : x,
      );
    }
    // 2. Then this phone's own start and end items.
    const rejectedStarts: string[] = [];
    for (const outcome of exchange.outcomes) {
      if (!outcome.shiftId || outcome.status === 'RETRY' || outcome.status === 'MISSING') continue;
      const local = this.#local.get(outcome.shiftId);
      if (!local) continue;
      if (outcome.type === 'SHIFT_START' && outcome.clientEventId === local.startEventId) {
        const next = await this.#applyShift(
          outcome.shiftId,
          {
            type: 'START_RESULT',
            status: outcome.status,
            errorCode: outcome.errorCode,
            atMs: this.#deps.clocks.wall.nowMs(),
          },
          local.endsAtMs,
        );
        if (next.phase === 'START_REJECTED') rejectedStarts.push(outcome.shiftId);
      } else if (outcome.type === 'SHIFT_END' && outcome.clientEventId === local.endEventId) {
        await this.#applyShift(
          outcome.shiftId,
          { type: 'END_RESULT', status: outcome.status, errorCode: outcome.errorCode },
          local.endsAtMs,
        );
      }
    }
    // 3. A refused start: the shift's queued points go too (ADV-O03).
    for (const shiftId of rejectedStarts) {
      await outbox.dropShiftItemsAfterRejectedStart(partitionKey(exchange.partition), shiftId);
    }
    const lastSuccess = this.#engine?.status().lastSuccessAtMs ?? null;
    if (lastSuccess !== null) await this.#meta?.set(META_KEYS.lastSuccessfulSyncAtMs, String(lastSuccess));
    await this.#reconcileTracking();
    await this.#refreshCounts();
    this.#emit();
  }

  // ── Periodic work ──────────────────────────────────────────────────────────────────────────

  /** Every few seconds while the screens are open (the location task calls the same checks). */
  async tick(): Promise<void> {
    await this.start();
    await this.#tick();
    const tracked = this.#trackedShift();
    const partition = this.#partition() ?? this.#identityPartition();
    if (tracked && partition) {
      await this.#heartbeatIfDue(partition, tracked);
      await this.#saveTracking();
      await this.#refreshCounts();
    }
    await this.#flushIfDue();
    this.#emit();
  }

  async #tick(): Promise<void> {
    const now = this.#serverNow();
    let changed = false;
    for (const shift of [...this.#local.values()]) {
      if (!shift.tracking) continue;
      const next = await this.#applyShift(shift.shiftId, { type: 'CLOCK', nowMs: now }, shift.endsAtMs);
      if (next !== shift) changed = true;
    }
    if (changed) await this.#reconcileTracking();
    await this.#housekeeping();
  }

  async #housekeeping(): Promise<void> {
    const outbox = this.#outbox;
    if (!outbox) return;
    const now = this.#deps.clocks.wall.nowMs();
    if (now >= this.#lastHousekeepingMs && now - this.#lastHousekeepingMs < HOUSEKEEPING_EVERY_MS) return;
    this.#lastHousekeepingMs = now;
    // A margin beyond the server's limit, so a slightly wrong clock never drops data the server
    // would still have accepted.
    const maxAgeMs = this.settings.sync.maxOfflineAgeHours * HOUR + 6 * HOUR;
    await outbox.dropExpired(this.#serverTime.correct(now), maxAgeMs);
    const identity = this.#identity;
    if (identity) await outbox.thinLocations(partitionKeyOf(identity));
    await outbox.pruneReceipts(now, KEEP_FINISHED_MS);
    await this.#shiftStore?.prune(now - KEEP_FINISHED_MS);
  }

  /** The app came to the front: re-read the phone and the server (ARCH §8.8). */
  async onForeground(): Promise<void> {
    await this.start();
    await this.probeDevice();
    await this.refresh();
    if (this.#trackedShift()) await this.#reportDeviceStatus(false);
    await this.#sos?.retryNow();
    await this.flush();
  }

  async acknowledgeDiscarded(): Promise<void> {
    await this.#outbox?.acknowledgeDiscarded();
    await this.#refreshCounts();
    this.#emit();
  }

  async diagnostics(): Promise<Diagnostics> {
    const identity = this.#identity;
    const outbox = this.#outbox;
    return {
      recent: identity && outbox ? await outbox.recentReceipts(partitionKeyOf(identity), 15) : [],
      bootId: this.#deps.clocks.bootId,
      deviceId: identity?.deviceId ?? null,
    };
  }

  /** For tests: closes the database (simulates the process dying). */
  async close(): Promise<void> {
    this.#sos?.stop();
    await this.#db?.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

function partitionKeyOf(identity: Pick<IdentityProfile, 'organizationId' | 'guardId'>): string {
  return partitionKey({ organizationId: identity.organizationId, guardId: identity.guardId });
}

/**
 * Item types the server does not take yet: incidents and checkpoint scans arrive with their phases,
 * switched on by features.incidents and features.patrols. Until then they are never sent (and the app
 * does not create them); anything already queued waits on the phone.
 */
export function heldItemTypes(settings: Pick<EffectiveSettings, 'features'>): SyncItem['type'][] {
  const held: SyncItem['type'][] = [];
  if (!settings.features.incidents) held.push('INCIDENT');
  if (!settings.features.patrols) held.push('CHECKPOINT_SCAN');
  return held;
}

/**
 * The guard's number as E.164 (the contract requires it). Pakistani numbers are accepted as people
 * type them: 03001234567, 3001234567, 923001234567, +92 300 1234567, 0092….
 */
export function normalizePhone(input: string): string | null {
  const compact = input.replace(/[\s()-]/g, '');
  let e164: string;
  if (/^\+\d+$/.test(compact)) e164 = compact;
  else if (/^00\d+$/.test(compact)) e164 = `+${compact.slice(2)}`;
  else if (/^03\d{9}$/.test(compact)) e164 = `+92${compact.slice(1)}`;
  else if (/^3\d{9}$/.test(compact)) e164 = `+92${compact}`;
  else if (/^92\d{10}$/.test(compact)) e164 = `+${compact}`;
  else return null;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

function enrollmentError(error: unknown): { reason: EnrollErrorReason; code?: string } {
  if (error instanceof NetworkError) return { reason: 'NETWORK' };
  if (error instanceof ApiError) {
    const code = error.code ?? `HTTP_${error.status}`;
    if (error.status === 429) return { reason: 'RATE_LIMITED', code };
    if (error.code === 'INVITATION_EXPIRED' || error.status === 410) return { reason: 'EXPIRED', code };
    if (error.code === 'ENROLLMENT_CODE_INVALID' || error.status === 422 || error.status === 400) {
      return { reason: 'INVALID', code };
    }
    return { reason: 'GENERIC', code };
  }
  return { reason: 'GENERIC' };
}
