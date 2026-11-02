// `pnpm demo`: a working demo on the local database, with no phones. Development only.
//
// Creates (once) the organization "Demo Security" with owner owner@demo.test, guards, a gate and a
// patrol beat in the pilot colony, and today's shifts. Then simulated guard phones enroll with
// dashboard-issued codes, start their shifts and send positions through the real API, exactly as
// the guard app does. Ctrl+C stops the phones. What to watch, on the Live map and the Alerts page:
//   - Bilal walks off the patrol beat after a minute: "Left site" opens about five minutes later,
//     and resolves with the time outside when he walks back at nine minutes.
//   - Sana's phone reports background location turned off: "Tracking disabled", until it is back.
//   - Usman's battery is at 12%: "Low battery".
//   - Hina's phone loses signal after two minutes: DELAYED, then OFFLINE on the map, with her
//     position marked last known, and "Device offline" after ten minutes.
// Patrols, on the Patrols page: the beat has a checkpoint at each corner and a round every 12
// minutes (9 to finish), for each guard on it.
//   - Sana walks every round: Done.
//   - Bilal, off site, scans a photographed label: "Not verified", hundreds of metres away. Back on
//     the beat he walks half of each round: Incomplete, with "Checkpoint run incomplete".
//   - Hina's silent phone sends nothing: her rounds are Missed.
// The demo runs the alert detectors and the patrol-run closer itself every minute, and moves live
// updates to the dashboard every second (the outbox dispatcher), so the worker is not needed.
//
// `pnpm demo --crowd=1000` adds that many more guards, spread over 16 zones across the colony and
// reporting once a minute, to check the Live map at pilot scale (ARCH §22, Phase 6), also on a phone.
//
// Run `pnpm db:up` and `pnpm api:dev` first, then sign in to the dashboard as owner@demo.test.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createPool, verifyRuntimeRole } from '@sentryops/db';
import { haversineM } from '@sentryops/domain';
import type { InjectOptions } from 'fastify';

import { buildApp } from '../src/app.ts';
import { alertsForOrganization } from '../src/workers/detectors.ts';
import { dispatchOrganization } from '../src/workers/outbox.ts';
import { loadConfig } from '../src/config.ts';
import { provisionOrganization } from '../src/provisioning.ts';
import type { RateLimiter } from '../src/rate-limit.ts';
import { createDeps } from '../src/server.ts';
import { closeDueRuns } from '../src/services/patrols.ts';

const config = loadConfig({ ...process.env, DEV_AUTH: process.env.DEV_AUTH ?? 'true' });
if (config.NODE_ENV === 'production' || !config.DEV_AUTH) {
  console.error('The demo runs only in development, with DEV_AUTH=true.');
  process.exit(2);
}

const OWNER = 'owner@demo.test';
const ORG = 'Demo Security';
const GATE = { lat: 31.4697, lng: 74.4078 };
/** A simulated guard moves at most this far between two reports, 10 s apart (15 m/s). */
const MAX_STEP_M = 150;
/** About 1.3 km north of the beat: well outside it. */
const OFF_SITE = { lat: 31.4855, lng: 74.4075 };
const BEAT = [
  { lat: 31.4655, lng: 74.4001 },
  { lat: 31.4655, lng: 74.4112 },
  { lat: 31.4724, lng: 74.4135 },
  { lat: 31.4741, lng: 74.4019 },
];
type DemoGuard = { employeeNumber: string; displayName: string; phone: string; site: string };
const GUARDS: DemoGuard[] = [
  { employeeNumber: 'D-101', displayName: 'Ali Raza', phone: '+923001110101', site: 'gate' },
  { employeeNumber: 'D-102', displayName: 'Bilal Khan', phone: '+923001110102', site: 'beat' },
  { employeeNumber: 'D-103', displayName: 'Sana Iqbal', phone: '+923001110103', site: 'beat' },
  { employeeNumber: 'D-104', displayName: 'Usman Tariq', phone: '+923001110104', site: 'gate' },
  { employeeNumber: 'D-105', displayName: 'Hina Malik', phone: '+923001110105', site: 'beat' },
];
const crowdArg = process.argv.find((a) => a.startsWith('--crowd=')) ?? '';
const CROWD = Math.min(2000, Number(/^--crowd=(\d+)$/.exec(crowdArg)?.[1] ?? 0));
/** 16 zones on a 4 × 4 grid about 5 km apart: roughly the colony's 400 km² (Q-19). */
const ZONES = Array.from({ length: 16 }, (_, i) => ({
  name: `Crowd zone ${i + 1}`,
  center: { lat: GATE.lat + (Math.floor(i / 4) - 1.5) * 0.045, lng: GATE.lng + ((i % 4) - 1.5) * 0.053 },
}));
for (let i = 0; i < CROWD; i++) {
  const n = String(i + 1).padStart(4, '0');
  GUARDS.push({
    employeeNumber: `C-${n}`,
    displayName: `Crowd guard ${n}`,
    phone: `+9230220${n.padStart(5, '0')}`,
    site: `zone:${i % ZONES.length}`,
  });
}

const pool = createPool(config.DATABASE_URL, { applicationName: 'sentryops-demo', max: 4 });
await verifyRuntimeRole(pool, ['app_runtime']);
// One process plays every phone here, so the per-user and per-IP limits (SEC §9) would throttle
// the crowd. They are off in the demo only, which refuses to run outside development (above).
const deps = {
  ...createDeps(config, pool, { oidc: null }),
  rateLimiter: { hit: () => undefined } as unknown as RateLimiter,
};
const app = buildApp(deps, { logger: false });
await app.ready();

type CallOptions = {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  payload?: Record<string, unknown>;
  cookie?: string;
  org?: string | undefined;
  token?: string;
  device?: string;
};

async function call<T>(options: CallOptions): Promise<T> {
  // Content-Type only with a body: Fastify refuses an empty JSON body.
  const headers: Record<string, string> = options.payload ? { 'content-type': 'application/json' } : {};
  if (options.cookie) {
    headers.cookie = options.cookie;
    headers['x-sentry-csrf'] = '1';
  }
  if (options.org) headers['x-organization-id'] = options.org;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.device) headers['x-device-id'] = options.device;
  const request: InjectOptions = { method: options.method, url: options.url, headers };
  if (options.payload) request.payload = options.payload;
  const res = await app.inject(request);
  if (res.statusCode >= 400)
    throw new Error(`${options.method} ${options.url}: ${res.statusCode} ${res.body}`);
  return res.json<T>();
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    headers: { 'content-type': 'application/json', 'x-sentry-csrf': '1' },
    payload: { email, name: 'Demo Owner' },
  });
  return String(res.headers['set-cookie']).split(';')[0] ?? '';
}

// ── The organization, once ──────────────────────────────────────────────────────────────────
let cookie = await signIn(OWNER);
type Me = { memberships: { organizationId: string; organizationName: string }[] };
let org = (await call<Me>({ method: 'GET', url: '/api/v1/me', cookie })).memberships.find(
  (m) => m.organizationName === ORG,
)?.organizationId;
if (!org) {
  const created = await provisionOrganization(deps, {
    name: ORG,
    timezone: 'Asia/Karachi',
    ownerEmail: OWNER,
  });
  const token = new URL(created.acceptUrl).hash.replace('#token=', '');
  await call({ method: 'POST', url: '/api/v1/invitations/accept', cookie, payload: { token } });
  org = created.organizationId;
  console.log(`Created "${ORG}". Sign in to the dashboard as ${OWNER}.`);
}
cookie = await signIn(OWNER);

type Site = { id: string; name: string };
const sites = (await call<{ sites: Site[] }>({ method: 'GET', url: '/api/v1/sites', cookie, org })).sites;
async function site(name: string, boundary: unknown): Promise<string> {
  const existing = sites.find((s) => s.name === name);
  if (existing) return existing.id;
  return (
    await call<Site>({
      method: 'POST',
      url: '/api/v1/sites',
      cookie,
      org,
      payload: { name, clientName: 'Pilot colony', boundary },
    })
  ).id;
}
const gateId = await site('Main gate', { kind: 'CIRCLE', center: GATE, radiusM: 150 });
const beatId = await site('Sector C patrol beat', { kind: 'POLYGON', points: BEAT });

// Patrols (Phase 7): a checkpoint at each corner of the beat, and a round every 12 minutes.
const CORNERS = [
  { name: 'South-west corner', point: BEAT[0]! },
  { name: 'South-east corner', point: BEAT[1]! },
  { name: 'North-east corner', point: BEAT[2]! },
  { name: 'North-west corner', point: BEAT[3]! },
];
type Checkpoint = { id: string; name: string };
const beatCheckpoints = (
  await call<{ checkpoints: Checkpoint[] }>({
    method: 'GET',
    url: `/api/v1/sites/${beatId}/checkpoints`,
    cookie,
    org,
  })
).checkpoints;
for (const c of CORNERS) {
  if (beatCheckpoints.some((x) => x.name === c.name)) continue;
  beatCheckpoints.push(
    await call<Checkpoint>({
      method: 'POST',
      url: `/api/v1/sites/${beatId}/checkpoints`,
      cookie,
      org,
      payload: { name: c.name, location: c.point, verificationRadiusM: 30 },
    }),
  );
}
const beatRoutes = (
  await call<{ routes: { name: string }[] }>({
    method: 'GET',
    url: `/api/v1/sites/${beatId}/patrol-routes`,
    cookie,
    org,
  })
).routes;
if (!beatRoutes.some((r) => r.name === 'Beat round')) {
  await call({
    method: 'POST',
    url: `/api/v1/sites/${beatId}/patrol-routes`,
    cookie,
    org,
    payload: {
      name: 'Beat round',
      schedule: { intervalMinutes: 12, firstRunOffsetMinutes: 1, completionWindowMinutes: 9 },
      checkpoints: CORNERS.map((c) => ({ checkpointId: beatCheckpoints.find((x) => x.name === c.name)!.id })),
    },
  });
}
// The labels, as printed: what a phone camera reads at each corner.
const labels = new Map(
  (
    await call<{ labels: { name: string; qrContent: string }[] }>({
      method: 'GET',
      url: `/api/v1/sites/${beatId}/checkpoints/print-sheet`,
      cookie,
      org,
    })
  ).labels.map((l) => [l.name, l.qrContent]),
);
const cornerAt = new Map(CORNERS.map((c) => [c.name, c.point]));

const zoneIds: string[] = [];
if (CROWD > 0) {
  for (const z of ZONES)
    zoneIds.push(await site(z.name, { kind: 'CIRCLE', center: z.center, radiusM: 5000 }));
}
/** A crowd guard stays within about 3 km of their zone's centre: inside it. */
function placeFor(g: DemoGuard): { siteId: string; home: { lat: number; lng: number } } {
  if (g.site === 'gate') return { siteId: gateId, home: GATE };
  if (g.site === 'beat') return { siteId: beatId, home: { lat: 31.469, lng: 74.406 } };
  const zone = Number(g.site.slice('zone:'.length));
  const c = ZONES[zone]!.center;
  return {
    siteId: zoneIds[zone]!,
    home: { lat: c.lat + (Math.random() - 0.5) * 0.05, lng: c.lng + (Math.random() - 0.5) * 0.06 },
  };
}

// The demo's phones, kept between runs (git-ignored, development data only). A rerun signs the same
// phones in again, as a real phone keeps its session. Enrolling new ones every run would use up the
// enrollment codes, which are limited to 3 per guard per day (SEC §9), by the third run of the day.
const PHONES_FILE = join(import.meta.dirname, '..', '..', '..', '.local', 'demo-phones.json');
type SavedPhone = { deviceId: string; refresh: string };
const savedPhones: Record<string, SavedPhone> = existsSync(PHONES_FILE)
  ? (JSON.parse(readFileSync(PHONES_FILE, 'utf8')) as Record<string, SavedPhone>)
  : {};
function savePhone(guardId: string, phone: SavedPhone): void {
  savedPhones[guardId] = phone;
  mkdirSync(dirname(PHONES_FILE), { recursive: true });
  writeFileSync(PHONES_FILE, JSON.stringify(savedPhones));
}

type Guard = { id: string; employeeNumber: string };
const existingGuards = (
  await call<{ guards: Guard[] }>({ method: 'GET', url: '/api/v1/guards', cookie, org })
).guards;

type Phone = {
  name: string;
  guardId: string;
  shiftId: string;
  deviceId: string;
  access: string;
  refresh: string;
  position: { lat: number; lng: number };
  home: { lat: number; lng: number };
  /** Picked up a shift already running from an earlier demo run (no new start). */
  resumed: boolean;
  /** Crowd phones report once a minute, not every 10 s. */
  crowd: boolean;
  /** On the patrol beat: walks its rounds. */
  beat: boolean;
};
const phones: Phone[] = [];
const bootId = randomUUID();
const monoStart = Date.now();
const mono = () => Date.now() - monoStart + 1_000;

for (const g of GUARDS) {
  const guardId =
    existingGuards.find((x) => x.employeeNumber === g.employeeNumber)?.id ??
    (
      await call<Guard>({
        method: 'POST',
        url: '/api/v1/guards',
        cookie,
        org,
        payload: {
          employeeNumber: g.employeeNumber,
          displayName: g.displayName,
          phone: g.phone,
          preferredLocale: 'ur',
        },
      })
    ).id;
  const { siteId, home } = placeFor(g);
  const now = deps.clock.now();
  // A rerun: a shift still running from an earlier demo run is picked up. A leftover shift that
  // never started is cancelled.
  const leftover = await call<{ shifts: { id: string; status: string; endsAt: string }[] }>({
    method: 'GET',
    url: `/api/v1/shifts?from=${encodeURIComponent(new Date(now.getTime() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(now.getTime() + 9 * 3_600_000).toISOString())}&guardId=${guardId}`,
    cookie,
    org,
  });
  // Still within its scheduled time: picked up. Already past its end (an earlier day's run):
  // ended, so a fresh shift can start.
  const running = leftover.shifts.find(
    (x) => x.status === 'ACTIVE' && new Date(x.endsAt).getTime() > now.getTime() + 60_000,
  );
  for (const old of leftover.shifts) {
    const overdue = old.status === 'ACTIVE' && old !== running;
    if (old.status !== 'SCHEDULED' && !overdue) continue;
    await call({
      method: 'POST',
      url: `/api/v1/shifts/${old.id}/${overdue ? 'force-end' : 'cancel'}`,
      cookie,
      org,
      payload: { reason: 'Demo restarted' },
    });
  }
  let shiftId: string;
  if (running) {
    shiftId = running.id;
  } else {
    // Today's shift, from a minute from now for 8 hours.
    try {
      shiftId = (
        await call<{ id: string }>({
          method: 'POST',
          url: '/api/v1/shifts',
          cookie,
          org,
          payload: {
            guardId,
            siteId,
            startsAt: new Date(now.getTime() + 60_000).toISOString(),
            endsAt: new Date(now.getTime() + 8 * 3_600_000).toISOString(),
          },
        })
      ).id;
    } catch {
      console.log(`${g.displayName} has an ended shift covering now; skipping.`);
      continue;
    }
  }
  // The phone from an earlier run, if its session still works; otherwise a new phone enrolls with a
  // dashboard-issued code, as a guard would.
  let session: { deviceId: string; access: string; refresh: string } | null = null;
  const before = savedPhones[guardId];
  if (before) {
    try {
      const fresh = await call<{ session: { accessToken: string; refreshToken: string } }>({
        method: 'POST',
        url: '/api/v1/sessions/refresh',
        payload: { refreshToken: before.refresh },
      });
      session = {
        deviceId: before.deviceId,
        access: fresh.session.accessToken,
        refresh: fresh.session.refreshToken,
      };
    } catch {
      // Expired or revoked: enroll a new phone below.
    }
  }
  if (!session) {
    const { code } = await call<{ code: string }>({
      method: 'POST',
      url: `/api/v1/guards/${guardId}/enrollment-codes`,
      cookie,
      org,
    });
    const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    const enrolled = await call<{ deviceId: string; session: { accessToken: string; refreshToken: string } }>(
      {
        method: 'POST',
        url: '/api/v1/enrollments/redeem',
        payload: {
          code,
          phone: g.phone,
          installationId: randomUUID(),
          publicKey,
          keyAlgorithm: 'ECDSA_P256_SHA256',
          platform: 'ANDROID',
          manufacturer: 'Demo',
          model: 'Simulator',
          osVersion: '14',
          appVersion: '0.1.0-demo',
        },
      },
    );
    session = {
      deviceId: enrolled.deviceId,
      access: enrolled.session.accessToken,
      refresh: enrolled.session.refreshToken,
    };
  }
  savePhone(guardId, { deviceId: session.deviceId, refresh: session.refresh });
  phones.push({
    name: g.displayName,
    guardId,
    shiftId,
    deviceId: session.deviceId,
    access: session.access,
    refresh: session.refresh,
    position: { ...home },
    home,
    resumed: running !== undefined,
    crowd: g.site.startsWith('zone:'),
    beat: g.site === 'beat',
  });
  if (phones.length % 100 === 0) console.log(`${phones.length} phones enrolled…`);
}

async function sync(phone: Phone, items: Record<string, unknown>[]) {
  return call<{ results: { status: string; code?: string }[] }>({
    method: 'POST',
    url: '/api/v1/sync/batch',
    token: phone.access,
    device: phone.deviceId,
    payload: { batchId: randomUUID(), sentAt: new Date().toISOString(), sentMonoMs: mono(), bootId, items },
  });
}

const item = (type: string, fields: Record<string, unknown>) => ({
  clientEventId: randomUUID(),
  type,
  recordedAt: new Date().toISOString(),
  monoMs: mono(),
  bootId,
  ...fields,
});

// Start each shift once its window opens (a minute from now), then walk.
console.log(`${phones.length} simulated phones ready. Starting shifts in about a minute…`);
await new Promise((r) => setTimeout(r, 61_000));
for (const p of phones) {
  if (p.resumed) {
    console.log(`${p.name}: picked up the running shift`);
    continue;
  }
  const res = await sync(p, [
    item('SHIFT_START', {
      shiftId: p.shiftId,
      fix: { lat: p.position.lat, lon: p.position.lng, accuracyM: 6, fixAgeS: 1 },
      permission: { location: 'ALWAYS', precise: true },
    }),
  ]);
  console.log(
    `${p.name}: start ${res.results[0]?.status}${res.results[0]?.code ? ` (${res.results[0].code})` : ''}`,
  );
}

const started = Date.now();
let stopping = false;
process.once('SIGINT', () => {
  stopping = true;
});
const status = (fields: Record<string, unknown>) => ({
  locationPermission: 'ALWAYS',
  preciseLocation: true,
  locationServicesEnabled: true,
  trackingServiceState: 'RUNNING',
  batteryPct: 64,
  isCharging: false,
  ...fields,
});
// Who plays which part, by name; a rerun that skips a guard with a shift already running still works.
const WANDERER = phones.find((p) => p.name === 'Bilal Khan');
const PERMISSION = phones.find((p) => p.name === 'Sana Iqbal');
const BATTERY = phones.find((p) => p.name === 'Usman Tariq');
const SILENT = phones.at(-1);
let lastDetectors = 0;
let tick = 0;

// Each beat phone reads its rounds as the guard app does (GET /me/patrols), walks to the next
// corner of the round that is open, and scans its label there.
type Round = {
  id: string;
  dueAt: string;
  windowEndsAt: string;
  status: string;
  checkpoints: { name: string; sequence: number; required: boolean; done: string | null }[];
};
const patrol = new Map<
  string,
  { rounds: Round[]; fetchedAt: number; lastScanAt: number; photographed: Set<string> }
>();
async function openRound(p: Phone): Promise<Round | null> {
  const state = patrol.get(p.deviceId) ?? {
    rounds: [],
    fetchedAt: 0,
    lastScanAt: 0,
    photographed: new Set<string>(),
  };
  patrol.set(p.deviceId, state);
  if (Date.now() - state.fetchedAt > 20_000) {
    state.rounds = (
      await call<{ runs: Round[] }>({
        method: 'GET',
        url: `/api/v1/me/patrols?shiftId=${p.shiftId}`,
        token: p.access,
        device: p.deviceId,
      })
    ).runs;
    state.fetchedAt = Date.now();
  }
  const now = Date.now();
  return (
    state.rounds.find(
      (r) =>
        (r.status === 'PENDING' || r.status === 'IN_PROGRESS') &&
        Date.parse(r.dueAt) <= now &&
        now <= Date.parse(r.windowEndsAt),
    ) ?? null
  );
}
const scanAt = (p: Phone, name: string) =>
  item('CHECKPOINT_SCAN', {
    shiftId: p.shiftId,
    token: labels.get(name) ?? '',
    fix: { lat: p.position.lat, lon: p.position.lng, accuracyM: 6, fixAgeS: 1 },
  });
let permissionState: 'ok' | 'off' | 'restored' = 'ok';
let batteryReported = false;

// Live updates: committed changes move from the outbox to the dashboards every second, as the
// worker's dispatcher does (ARCH §14).
const dispatcher = setInterval(() => {
  if (org) void dispatchOrganization(deps, org).catch(() => undefined);
}, 1_000);

console.log(
  'Phones are reporting every 10 s. Open the Live map, the Alerts page and the Patrols page. Ctrl+C to stop.',
);
while (!stopping) {
  const elapsed = Date.now() - started;
  tick++;
  for (const [index, p] of phones.entries()) {
    // Crowd phones take turns: each reports once a minute.
    if (p.crowd && (tick + index) % 6 !== 0) continue;
    // The last phone "loses signal" after two minutes: watch it turn DELAYED, then OFFLINE.
    if (p === SILENT && elapsed > 120_000) continue;
    const wandering = p === WANDERER && elapsed > 60_000 && elapsed < 9 * 60_000;
    // Patrol rounds on the beat (Phase 7).
    const extra: Record<string, unknown>[] = [];
    let corner: { name: string; point: { lat: number; lng: number } } | null = null;
    if (p.beat) {
      try {
        const round = await openRound(p);
        const state = patrol.get(p.deviceId)!;
        const todo = (round?.checkpoints ?? [])
          .filter((c) => c.required && c.done === null)
          .sort((a, b) => a.sequence - b.sequence);
        const done = (round?.checkpoints ?? []).filter((c) => c.done !== null).length;
        if (round && todo[0] && wandering && !state.photographed.has(round.id)) {
          // Off site with photos of the labels: the location check catches it.
          state.photographed.add(round.id);
          extra.push(scanAt(p, todo[0].name));
        } else if (round && todo[0] && !wandering && !(p === WANDERER && done >= 2)) {
          const point = cornerAt.get(todo[0].name);
          if (point) corner = { name: todo[0].name, point };
        }
      } catch {
        // The access token ran out; the refresh below fixes it for the next round.
      }
    }
    const target = wandering ? OFF_SITE : (corner?.point ?? p.home);
    const pull = p === WANDERER && wandering ? 0.3 : corner ? 0.35 : 0.05;
    const drift = (index % 2 === 0 ? 0.00025 : 0.00045) * (Math.random() - 0.5);
    // At most a running pace (150 m per 10 s): faster would be flagged as implausible, rightly.
    const away = haversineM(p.position, target);
    const step = away * pull > MAX_STEP_M ? MAX_STEP_M / away : pull;
    p.position = {
      lat: p.position.lat + drift + (target.lat - p.position.lat) * step,
      lng: p.position.lng + drift * 1.4 + (target.lng - p.position.lng) * step,
    };
    const state = patrol.get(p.deviceId);
    if (
      corner &&
      state &&
      haversineM(p.position, corner.point) < 25 &&
      Date.now() - state.lastScanAt > 75_000
    ) {
      extra.push(scanAt(p, corner.name));
      state.lastScanAt = Date.now();
      state.fetchedAt = 0; // read the round again after this scan
    }
    if (p === PERMISSION && permissionState === 'ok' && elapsed > 30_000) {
      extra.push(
        item('DEVICE_STATUS', { shiftId: p.shiftId, status: status({ locationPermission: 'WHEN_IN_USE' }) }),
      );
      permissionState = 'off';
    } else if (p === PERMISSION && permissionState === 'off' && elapsed > 4 * 60_000) {
      extra.push(item('DEVICE_STATUS', { shiftId: p.shiftId, status: status({}) }));
      permissionState = 'restored';
    }
    if (p === BATTERY && !batteryReported) {
      extra.push(item('DEVICE_STATUS', { shiftId: p.shiftId, status: status({ batteryPct: 12 }) }));
      batteryReported = true;
    }
    try {
      await sync(p, [
        item('LOCATION', {
          shiftId: p.shiftId,
          fix: {
            lat: p.position.lat,
            lon: p.position.lng,
            accuracyM: 5 + Math.random() * 10,
            provider: 'FUSED',
          },
        }),
        item('HEARTBEAT', { shiftId: p.shiftId }),
        ...extra,
      ]);
    } catch {
      // The 15-minute access token ran out: refresh, as the app does.
      const fresh = await call<{ session: { accessToken: string; refreshToken: string } }>({
        method: 'POST',
        url: '/api/v1/sessions/refresh',
        payload: { refreshToken: p.refresh },
      });
      p.access = fresh.session.accessToken;
      p.refresh = fresh.session.refreshToken;
      savePhone(p.guardId, { deviceId: p.deviceId, refresh: p.refresh });
    }
  }
  if (Date.now() - lastDetectors >= 60_000 && org) {
    lastDetectors = Date.now();
    await alertsForOrganization(deps, org).catch((e: unknown) => {
      console.error(`alert detectors failed: ${e instanceof Error ? e.message : 'unknown'}`);
    });
    await closeDueRuns(deps, org).catch((e: unknown) => {
      console.error(`patrol-run closer failed: ${e instanceof Error ? e.message : 'unknown'}`);
    });
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
clearInterval(dispatcher);
await app.close();
await pool.end();
