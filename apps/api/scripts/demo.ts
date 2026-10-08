// `pnpm demo`: a working demo on the local database, with no phones. Development only.
//
// Creates (once) the organization "Demo Security" with owner owner@demo.test, guards, a gate and a
// patrol beat in the pilot colony, and today's shifts. Then simulated guard phones enroll with
// dashboard-issued codes, start their shifts and send positions through the real API, exactly as
// the guard app does. One phone "loses signal" after two minutes, so the live map shows it turn
// DELAYED, then OFFLINE, with its position marked last known. Ctrl+C stops the phones.
//
// Run `pnpm db:up` and `pnpm api:dev` first, then sign in to the dashboard as owner@demo.test.
import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { createPool, verifyRuntimeRole } from '@sentryops/db';
import type { InjectOptions } from 'fastify';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { provisionOrganization } from '../src/provisioning.ts';
import { createDeps } from '../src/server.ts';

const config = loadConfig({ ...process.env, DEV_AUTH: process.env.DEV_AUTH ?? 'true' });
if (config.NODE_ENV === 'production' || !config.DEV_AUTH) {
  console.error('The demo runs only in development, with DEV_AUTH=true.');
  process.exit(2);
}

const OWNER = 'owner@demo.test';
const ORG = 'Demo Security';
const GATE = { lat: 31.4697, lng: 74.4078 };
const BEAT = [
  { lat: 31.4655, lng: 74.4001 },
  { lat: 31.4655, lng: 74.4112 },
  { lat: 31.4724, lng: 74.4135 },
  { lat: 31.4741, lng: 74.4019 },
];
const GUARDS = [
  { employeeNumber: 'D-101', displayName: 'Ali Raza', phone: '+923001110101', site: 'gate' },
  { employeeNumber: 'D-102', displayName: 'Bilal Khan', phone: '+923001110102', site: 'beat' },
  { employeeNumber: 'D-103', displayName: 'Sana Iqbal', phone: '+923001110103', site: 'beat' },
  { employeeNumber: 'D-104', displayName: 'Usman Tariq', phone: '+923001110104', site: 'gate' },
  { employeeNumber: 'D-105', displayName: 'Hina Malik', phone: '+923001110105', site: 'beat' },
] as const;

const pool = createPool(config.DATABASE_URL, { applicationName: 'sentryops-demo', max: 4 });
await verifyRuntimeRole(pool, ['app_runtime']);
const deps = createDeps(config, pool, { oidc: null });
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
  const home = g.site === 'gate' ? GATE : { lat: 31.469, lng: 74.406 };
  // Today's shift, from now for 8 hours (skipped if one already overlaps).
  const now = deps.clock.now();
  let shiftId: string;
  try {
    shiftId = (
      await call<{ id: string }>({
        method: 'POST',
        url: '/api/v1/shifts',
        cookie,
        org,
        payload: {
          guardId,
          siteId: g.site === 'gate' ? gateId : beatId,
          startsAt: new Date(now.getTime() + 60_000).toISOString(),
          endsAt: new Date(now.getTime() + 8 * 3_600_000).toISOString(),
        },
      })
    ).id;
  } catch {
    console.log(`${g.displayName} already has a shift now; skipping.`);
    continue;
  }
  // The phone enrolls with a dashboard-issued code, as a guard would.
  const { code } = await call<{ code: string }>({
    method: 'POST',
    url: `/api/v1/guards/${guardId}/enrollment-codes`,
    cookie,
    org,
  });
  const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64');
  const enrolled = await call<{ deviceId: string; session: { accessToken: string; refreshToken: string } }>({
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
  });
  phones.push({
    name: g.displayName,
    guardId,
    shiftId,
    deviceId: enrolled.deviceId,
    access: enrolled.session.accessToken,
    refresh: enrolled.session.refreshToken,
    position: { ...home },
    home,
  });
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
console.log(`${phones.length} simulated phones enrolled. Starting shifts in about a minute…`);
await new Promise((r) => setTimeout(r, 61_000));
for (const p of phones) {
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
console.log('Phones are reporting every 10 s. Open the Live map. Ctrl+C to stop.');
while (!stopping) {
  for (const [index, p] of phones.entries()) {
    // The last phone "loses signal" after two minutes: watch it turn DELAYED, then OFFLINE.
    if (index === phones.length - 1 && Date.now() - started > 120_000) continue;
    const drift = (index % 2 === 0 ? 0.00025 : 0.00045) * (Math.random() - 0.5);
    p.position = {
      lat: p.position.lat + drift + (p.home.lat - p.position.lat) * 0.05,
      lng: p.position.lng + drift * 1.4 + (p.home.lng - p.position.lng) * 0.05,
    };
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
    }
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
await app.close();
await pool.end();
