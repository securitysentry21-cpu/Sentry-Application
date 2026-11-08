// The local stack the browser tests run against (ARCH §21.1): a throwaway PostgreSQL, the API, the
// worker (the outbox dispatcher that carries live changes to dashboards, the notification sender) and
// the dashboard in development mode, which proxies /api to the API (same origin, review A-07). It
// then seeds one company: an owner, an administrator, a site, a guard whose phone is enrolled, and a
// shift in progress. Playwright starts this script as its web server and asks it to stop at the end
// (apps/web/playwright.config.ts). Development only; nothing here touches a real environment.
//
// Ports: dashboard 3100, API 4100, control 4199 (so `pnpm web:dev` and `pnpm api:dev` can run beside it).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { migrate } from '../../../packages/db/src/migrate.ts';
import { bootstrapRoles, createDatabase, MIGRATOR, roleUrl } from '../../../packages/db/src/roles.ts';
import { startCluster } from '../../../packages/db/test-support/cluster.ts';

export const WEB_PORT = 3100;
export const API_PORT = 4100;
export const CONTROL_PORT = 4199;
export const STATE_FILE = join(tmpdir(), 'sentryops-e2e-state.json');

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const API = `http://127.0.0.1:${API_PORT}/api/v1`;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const DATABASE = 'sentryops';
const children: ChildProcess[] = [];

// Playwright closes our output pipes when the tests end, while the children are still saying goodbye:
// a write to a closed pipe must not print a stack trace over a clean run.
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

function start(name: string, args: string[], options: { cwd: string; env: Record<string, string> }) {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  child.once('exit', (code) => {
    if (!stopping) console.error(`${name} exited unexpectedly (code ${code})`);
  });
  children.push(child);
  return child;
}

/** Stops a process and everything it started (Next starts workers). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

async function waitFor(url: string, what: string, timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`${what} did not start within ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function call(
  path: string,
  options: {
    method?: string;
    cookie?: string;
    org?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const res = await fetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'x-sentry-csrf': '1',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.org ? { 'x-organization-id': options.org } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
  return { res, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function signIn(email: string): Promise<string> {
  const { res } = await call('/auth/dev-login', { method: 'POST', body: { email } });
  const cookie = res.headers.getSetCookie()[0]?.split(';')[0];
  if (!cookie) throw new Error('no session cookie');
  return cookie;
}

let stopping = false;
let stopCluster: () => Promise<void> = () => Promise.resolve();

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child);
  await stopCluster().catch((error: unknown) => console.error('stopping the database failed:', error));
  console.log('e2e stack stopped');
}

const cluster = await startCluster();
stopCluster = cluster.stop;
try {
  // 1. The database: roles, the database, the migrations.
  const admin = new pg.Client({ connectionString: cluster.adminUrl });
  await admin.connect();
  await bootstrapRoles(admin);
  await createDatabase(admin, DATABASE);
  await admin.end();
  const migrator = new pg.Client({ connectionString: roleUrl(cluster.adminUrl, DATABASE, MIGRATOR) });
  await migrator.connect();
  await migrate(migrator);

  // 2. One company, created the way the platform operator would (directly), with its people.
  const orgId = randomUUID();
  const orgName = 'E2E Security';
  const people = [
    { email: 'owner@e2e.test', role: 'OWNER' },
    { email: 'admin@e2e.test', role: 'ADMIN' },
  ];
  await migrator.query(
    `insert into organizations (id, name, timezone, data_region) values ($1, $2, 'Asia/Karachi', 'eu-central-1')`,
    [orgId, orgName],
  );
  await migrator.query(`insert into organization_settings (id, organization_id) values ($1, $2)`, [
    randomUUID(),
    orgId,
  ]);
  for (const person of people) {
    const userId = randomUUID();
    await migrator.query(`insert into users (id, email, name) values ($1, $2, $3)`, [
      userId,
      person.email,
      person.email.split('@')[0],
    ]);
    await migrator.query(
      `insert into organization_members (id, organization_id, user_id, role, status) values ($1, $2, $3, $4, 'ACTIVE')`,
      [randomUUID(), orgId, userId, person.role],
    );
  }
  await migrator.end();

  // 3. The API and the worker, as the runtime roles (they refuse any other, D-33).
  const common = {
    NODE_ENV: 'development',
    CELL_REGION: 'eu-central-1',
    DEV_AUTH: 'true',
    PUBLIC_ORIGIN: WEB_ORIGIN,
    DATABASE_URL: roleUrl(cluster.adminUrl, DATABASE, 'app_runtime'),
    FEATURE_SOS: 'true',
    LOG_LEVEL: 'warn',
  };
  start('api', [join(ROOT, 'apps/api/src/main.ts')], {
    cwd: join(ROOT, 'apps/api'),
    env: { ...common, HOST: '127.0.0.1', PORT: String(API_PORT) },
  });
  await waitFor(`${API}/health`, 'the API');
  start('worker', [join(ROOT, 'apps/api/src/worker.ts')], {
    cwd: join(ROOT, 'apps/api'),
    env: { ...common, SWEEP_DATABASE_URL: roleUrl(cluster.adminUrl, DATABASE, 'system_worker') },
  });

  // 4. The dashboard, in development mode so that /api is proxied to the API.
  spawnSync(process.execPath, [join(WEB, 'scripts', 'copy-map-worker.mjs')], { cwd: WEB, stdio: 'inherit' });
  start(
    'web',
    [
      join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(WEB_PORT),
    ],
    { cwd: WEB, env: { API_DEV_ORIGIN: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: '1' } },
  );
  await waitFor(`${WEB_ORIGIN}/sign-in`, 'the dashboard');

  // 5. A site, a guard with an enrolled phone, and a shift in progress.
  const adminCookie = await signIn('admin@e2e.test');
  const as = { cookie: adminCookie, org: orgId };
  const site = await call('/sites', {
    ...as,
    method: 'POST',
    body: {
      name: 'ABC Warehouse',
      boundary: { kind: 'CIRCLE', center: { lat: 31.47, lng: 74.4 }, radiusM: 300 },
    },
  });
  const siteId = site.json.id as string;
  const phoneNumber = '+923001234567';
  const guard = await call('/guards', {
    ...as,
    method: 'POST',
    body: { employeeNumber: 'E-1', displayName: 'Ahmed Khan', phone: phoneNumber },
  });
  const guardId = guard.json.id as string;
  const issued = await call(`/guards/${guardId}/enrollment-codes`, { ...as, method: 'POST' });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const redeemed = await call('/enrollments/redeem', {
    method: 'POST',
    body: {
      code: issued.json.code,
      phone: phoneNumber,
      installationId: randomUUID(),
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      keyAlgorithm: 'ECDSA_P256_SHA256',
      platform: 'ANDROID',
      manufacturer: 'E2E',
      model: 'Phone',
      osVersion: '14',
      appVersion: '0.1.0',
    },
  });
  const session = redeemed.json.session as { accessToken: string; refreshToken: string };
  const deviceId = redeemed.json.deviceId as string;
  const startsAt = new Date(Date.now() + 5 * 60_000);
  const shift = await call('/shifts', {
    ...as,
    method: 'POST',
    body: {
      guardId,
      siteId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 8 * 3_600_000).toISOString(),
    },
  });
  const shiftId = shift.json.id as string;
  const now = new Date();
  await call('/sync/batch', {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessToken}`, 'x-device-id': deviceId },
    body: {
      batchId: randomUUID(),
      sentAt: now.toISOString(),
      sentMonoMs: 60_000,
      bootId: 'e2e-boot',
      items: [
        {
          clientEventId: randomUUID(),
          type: 'SHIFT_START',
          recordedAt: new Date(now.getTime() - 1_000).toISOString(),
          monoMs: 59_000,
          bootId: 'e2e-boot',
          shiftId,
          fix: { lat: 31.4702, lon: 74.4001, accuracyM: 8, fixAgeS: 2 },
          permission: { location: 'ALWAYS', precise: true },
        },
      ],
    },
  });

  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      webOrigin: WEB_ORIGIN,
      apiOrigin: API,
      orgId,
      orgName,
      ownerEmail: 'owner@e2e.test',
      adminEmail: 'admin@e2e.test',
      guard: { id: guardId, name: 'Ahmed Khan' },
      site: { id: siteId, name: 'ABC Warehouse' },
      shiftId,
      phone: { deviceId, accessToken: session.accessToken, refreshToken: session.refreshToken },
    }),
  );

  // 6. Ready. Playwright polls /ready, and asks for /stop when the tests are done.
  const control = createServer((request, response) => {
    if (request.url === '/stop') {
      // Answer only when everything has stopped: Playwright ends this process as soon as it hears back.
      void shutdown().then(() => {
        response.end('stopped');
        setTimeout(() => process.exit(0), 200);
      });
      return;
    }
    response.end('ready');
  });
  control.listen(CONTROL_PORT, '127.0.0.1');
  console.log(`e2e stack ready: dashboard ${WEB_ORIGIN}, API ${API}, state ${STATE_FILE}`);
} catch (error) {
  console.error('e2e stack failed to start:', error);
  await shutdown();
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown().then(() => process.exit(0)));
}
