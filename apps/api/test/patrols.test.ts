// Patrols (PROD §9, ARCH §11): scans arrive through the sync pipeline and the server judges them;
// runs come with the shift and close with the worker. ADV-Q01–Q09 and ADV-T08, by name.
import { randomUUID } from 'node:crypto';

import { createKysely, createPool } from '@sentryops/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runPatrolCloser } from '../src/workers/detectors.ts';
import {
  asOwner,
  asPhone,
  call,
  createGuard,
  enrollPhone,
  errorCode,
  refreshPhone,
  seedOrganization,
  signIn,
  startTestApp,
  type EnrolledPhone,
  type TestApp,
} from './support.ts';

let t: TestApp;
let sweepPool: Pool;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let orgB: Awaited<ReturnType<typeof seedOrganization>>;
let owner: string;
let admin: string;
let adminB: string;
let siteId: string;
let depotId: string;
let routeId: string;
let seq = 0;

const MIN = 60_000;
const H = 60 * MIN;
const BOOT = 'boot-patrol';
// The phone's monotonic clock, far enough from zero for scans captured hours back.
let mono = 1_000_000_000;

const GATE = { lat: 31.47, lng: 74.4 };
/** About `metres` north of the gate. */
const north = (metres: number) => ({ lat: GATE.lat + metres / 111_320, lng: GATE.lng });

/** Checkpoint name → its id and current QR content (from the printed sheet). */
const cp = new Map<string, { id: string; qr: string }>();
const qr = (name: string) => cp.get(name)!.qr;

type Item = Record<string, unknown>;
type ScanReply = {
  outcome: string;
  counted: boolean;
  checkpointName: string | null;
  distanceM: number | null;
  run: { countedCount: number; requiredCount: number; status: string } | null;
};
type SyncReply = { results: { clientEventId: string; status: string; code?: string; scan?: ScanReply }[] };
type Run = {
  id: string;
  sequenceNo: number;
  dueAt: string;
  windowEndsAt: string;
  status: string;
  requiredCount: number;
  countedCount: number;
  unconfirmedCount: number;
  missing: string[];
};

/** An item captured `agoMs` before the batch is sent, in the same app run. */
function item(type: string, fields: Item, agoMs = 1_000): Item {
  mono += 10;
  return {
    clientEventId: randomUUID(),
    type,
    recordedAt: new Date(t.clock.now().getTime() - agoMs).toISOString(),
    monoMs: mono - agoMs,
    bootId: BOOT,
    ...fields,
  };
}

const at = (point: { lat: number; lng: number }, accuracyM: number | null = 8, fixAgeS = 2) => ({
  lat: point.lat,
  lon: point.lng,
  accuracyM,
  fixAgeS,
});

function scan(shiftId: string | null, token: string, fix: Item | null, agoMs = 1_000): Item {
  return item('CHECKPOINT_SCAN', { shiftId, token, fix }, agoMs);
}

async function send(phone: EnrolledPhone, items: Item[]): Promise<SyncReply> {
  const post = () =>
    asPhone(t.app, phone, {
      method: 'POST',
      url: '/api/v1/sync/batch',
      body: {
        batchId: randomUUID(),
        sentAt: t.clock.now().toISOString(),
        sentMonoMs: mono,
        bootId: BOOT,
        items,
      },
    });
  let res = await post();
  if (res.statusCode === 401) {
    // The fake clock moved past the access token's life: refresh, as the app does.
    await refreshPhone(t.app, phone);
    res = await post();
  }
  if (res.statusCode !== 200) throw new Error(`sync failed: ${res.statusCode} ${res.body}`);
  return res.json<SyncReply>();
}

async function scanOne(phone: EnrolledPhone, scanItem: Item) {
  const reply = await send(phone, [scanItem]);
  return reply.results[0]!;
}

async function newPhone(): Promise<{ phone: EnrolledPhone; guardId: string }> {
  const number = `+9230033${String(10_000 + seq++).padStart(5, '0')}`;
  const guardId = await createGuard(t.app, admin, org.id, {
    employeeNumber: `P-${number.slice(-5)}`,
    displayName: `Patrol ${number.slice(-3)}`,
    phone: number,
  });
  return { phone: await enrollPhone(t.app, admin, org.id, guardId, number), guardId };
}

async function createShift(guardId: string, site: string, hours = 8): Promise<string> {
  const startsAt = new Date(t.clock.now().getTime() + 5 * MIN);
  const created = await call(t.app, {
    method: 'POST',
    url: '/api/v1/shifts',
    cookie: admin,
    org: org.id,
    body: {
      guardId,
      siteId: site,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + hours * H).toISOString(),
    },
  });
  if (created.statusCode !== 201) throw new Error(`create shift failed: ${created.body}`);
  return created.json<{ id: string }>().id;
}

/**
 * A guard on an active shift at the site, started online five minutes early, then two minutes into
 * it. The shift ends `hours` after its scheduled start, so it has `hours + 1` hourly runs.
 */
async function onShift(site = siteId, hours = 8, startPoint = GATE) {
  const { phone, guardId } = await newPhone();
  const shiftId = await createShift(guardId, site, hours);
  const started = await send(phone, [
    item('SHIFT_START', {
      shiftId,
      fix: { ...at(startPoint), fixAgeS: 2 },
      permission: { location: 'ALWAYS', precise: true },
    }),
  ]);
  expect(started.results[0]?.status).toBe('ACCEPTED');
  t.clock.advance(2 * MIN);
  return { phone, guardId, shiftId };
}

async function runsOf(shiftId: string): Promise<Run[]> {
  const res = await call(t.app, {
    method: 'GET',
    url: `/api/v1/patrol-runs?shiftId=${shiftId}&from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z`,
    cookie: admin,
    org: org.id,
  });
  // Outside the range: none. The real query follows.
  expect(res.json<{ runs: Run[] }>().runs).toEqual([]);
  const now = t.clock.now().getTime();
  const all = await call(t.app, {
    method: 'GET',
    url: `/api/v1/patrol-runs?shiftId=${shiftId}&from=${new Date(now - 2 * 24 * H).toISOString()}&to=${new Date(now + 2 * 24 * H).toISOString()}`,
    cookie: admin,
    org: org.id,
  });
  expect(all.statusCode).toBe(200);
  return all.json<{ runs: Run[] }>().runs.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

async function runDetail(runId: string) {
  const res = await call(t.app, {
    method: 'GET',
    url: `/api/v1/patrol-runs/${runId}`,
    cookie: admin,
    org: org.id,
  });
  expect(res.statusCode).toBe(200);
  return res.json<{
    run: Run;
    checkpoints: { name: string; done: string | null }[];
    visits: {
      outcome: string;
      counted: boolean;
      checkpoint: { name: string } | null;
      late: boolean;
      flags: string[];
    }[];
  }>();
}

const closer = () => runPatrolCloser({ ...t.deps, sweep: createKysely(sweepPool) });

async function alertsOf(shiftId: string) {
  const res = await call(t.app, {
    method: 'GET',
    url: `/api/v1/alerts?shiftId=${shiftId}&status=all`,
    cookie: admin,
    org: org.id,
  });
  return res.json<{
    alerts: { type: string; summary: string; status: string; details: Record<string, unknown> }[];
  }>().alerts;
}

async function addCheckpoint(
  cookie: string,
  orgId: string,
  site: string,
  name: string,
  point: { lat: number; lng: number } | null,
) {
  const res = await call(t.app, {
    method: 'POST',
    url: `/api/v1/sites/${site}/checkpoints`,
    cookie,
    org: orgId,
    body: { name, ...(point ? { location: point } : {}), verificationRadiusM: 30 },
  });
  if (res.statusCode !== 201) throw new Error(`checkpoint failed: ${res.body}`);
  return res.json<{ id: string }>().id;
}

async function loadLabels(cookie: string, orgId: string, site: string): Promise<void> {
  const res = await call(t.app, {
    method: 'GET',
    url: `/api/v1/sites/${site}/checkpoints/print-sheet`,
    cookie,
    org: orgId,
  });
  for (const l of res.json<{ labels: { checkpointId: string; name: string; qrContent: string }[] }>()
    .labels) {
    cp.set(l.name, { id: l.checkpointId, qr: l.qrContent });
  }
}

async function addSite(cookie: string, orgId: string, name: string, center: { lat: number; lng: number }) {
  const res = await call(t.app, {
    method: 'POST',
    url: '/api/v1/sites',
    cookie,
    org: orgId,
    body: { name, boundary: { kind: 'CIRCLE', center, radiusM: 800 } },
  });
  return res.json<{ id: string }>().id;
}

async function createRoute(site: string, body: Record<string, unknown>) {
  return call(t.app, {
    method: 'POST',
    url: `/api/v1/sites/${site}/patrol-routes`,
    cookie: admin,
    org: org.id,
    body,
  });
}

const ROUND = { intervalMinutes: 60, firstRunOffsetMinutes: 0, completionWindowMinutes: 30 };

beforeAll(async () => {
  t = await startTestApp();
  sweepPool = createPool(t.db.urls.system_worker, { max: 2 });
  org = await seedOrganization(t.db, 'Patrol Co', [
    { email: 'owner@patrol.test', role: 'OWNER' },
    { email: 'admin@patrol.test', role: 'ADMIN' },
  ]);
  orgB = await seedOrganization(t.db, 'Bravo Patrol', [{ email: 'admin@bravo-patrol.test', role: 'ADMIN' }]);
  owner = await signIn(t.app, 'owner@patrol.test');
  admin = await signIn(t.app, 'admin@patrol.test');
  adminB = await signIn(t.app, 'admin@bravo-patrol.test');

  siteId = await addSite(admin, org.id, 'Gulberg Warehouse', GATE);
  await addCheckpoint(admin, org.id, siteId, 'Main gate', north(0));
  await addCheckpoint(admin, org.id, siteId, 'Store room', north(200));
  await addCheckpoint(admin, org.id, siteId, 'Back fence', north(500));
  await addCheckpoint(admin, org.id, siteId, 'Office', null);
  await addCheckpoint(admin, org.id, siteId, 'Side door', north(100));
  await loadLabels(admin, org.id, siteId);
  depotId = await addSite(admin, org.id, 'Depot', north(3_000));
  await addCheckpoint(admin, org.id, depotId, 'Depot door', north(3_000));
  await loadLabels(admin, org.id, depotId);
  const siteB = await addSite(adminB, orgB.id, 'Bravo yard', GATE);
  await addCheckpoint(adminB, orgB.id, siteB, 'Bravo door', north(0));
  await loadLabels(adminB, orgB.id, siteB);

  const route = await createRoute(siteId, {
    name: 'Night round',
    schedule: ROUND,
    checkpoints: ['Main gate', 'Store room', 'Back fence'].map((n) => ({ checkpointId: cp.get(n)!.id })),
  });
  expect(route.statusCode).toBe(201);
  routeId = route.json<{ id: string }>().id;
});

afterAll(async () => {
  await sweepPool?.end();
  await t?.close();
});

describe('checkpoint scans (ARCH §11.2)', () => {
  it('ADV-Q01 a valid scan at the checkpoint is VERIFIED and counts toward the run', async () => {
    const { phone, shiftId } = await onShift();
    const result = await scanOne(phone, scan(shiftId, qr('Main gate'), at(north(4))));
    expect(result.status).toBe('ACCEPTED');
    expect(result.scan).toEqual({
      outcome: 'VERIFIED',
      counted: true,
      checkpointName: 'Main gate',
      distanceM: null,
      run: { countedCount: 1, requiredCount: 3, status: 'IN_PROGRESS' },
    });
    const [first] = await runsOf(shiftId);
    const detail = await runDetail(first!.id);
    expect(detail.run).toMatchObject({
      status: 'IN_PROGRESS',
      countedCount: 1,
      missing: ['Store room', 'Back fence'],
    });
    expect(detail.checkpoints.map((c) => [c.name, c.done])).toEqual([
      ['Main gate', 'VERIFIED'],
      ['Store room', null],
      ['Back fence', null],
    ]);
    // The scanned token is never stored (ARCH §11.1).
    const rows = await asOwner(t.db, (c) =>
      c.query<{ row: string }>(
        `select row_to_json(v)::text as row from checkpoint_visits v where shift_id = $1`,
        [shiftId],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.row).not.toContain(qr('Main gate').slice(4));
  });

  it('ADV-Q02 a photographed QR scanned far away is OUTSIDE_RADIUS and does not count', async () => {
    const { phone, shiftId } = await onShift();
    const far = await scanOne(phone, scan(shiftId, qr('Store room'), at(north(2_200), 15)));
    expect(far.scan).toMatchObject({
      outcome: 'OUTSIDE_RADIUS',
      counted: false,
      checkpointName: 'Store room',
      distanceM: 2_000,
      run: { countedCount: 0, status: 'PENDING' },
    });
    // Even with accuracy too poor to verify with, 2 km is clearly outside (PROD §9.3).
    const blurry = await scanOne(phone, scan(shiftId, qr('Store room'), at(north(2_200), 150)));
    expect(blurry.scan).toMatchObject({ outcome: 'OUTSIDE_RADIUS', counted: false });
  });

  it('ADV-Q03 an indoor scan with poor accuracy is LOCATION_UNCONFIRMED, labelled QR only, counted per D-17', async () => {
    const { phone, shiftId } = await onShift();
    const indoor = await scanOne(phone, scan(shiftId, qr('Store room'), at(north(215), 90)));
    expect(indoor.scan).toMatchObject({
      outcome: 'LOCATION_UNCONFIRMED',
      counted: true,
      checkpointName: 'Store room',
    });
    const [first] = await runsOf(shiftId);
    expect(first).toMatchObject({ countedCount: 1, unconfirmedCount: 1 });
    expect((await runDetail(first!.id)).checkpoints[1]).toMatchObject({
      name: 'Store room',
      done: 'QR_ONLY',
    });

    // An organization that doesn't count QR-only scans (D-17 off).
    const settings = await call(t.app, {
      method: 'GET',
      url: '/api/v1/settings',
      cookie: owner,
      org: org.id,
    });
    const off = await call(t.app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      cookie: owner,
      org: org.id,
      body: {
        changes: { 'patrol.count_unconfirmed_as_completed': false },
        version: settings.json<{ version: number }>().version,
      },
    });
    expect(off.statusCode).toBe(200);
    const notCounted = await scanOne(phone, scan(shiftId, qr('Back fence'), at(north(510), 90)));
    expect(notCounted.scan).toMatchObject({ outcome: 'LOCATION_UNCONFIRMED', counted: false });
    // A checkpoint without a position can never be verified: QR only.
    const office = await scanOne(phone, scan(shiftId, qr('Office'), at(north(3))));
    expect(office.scan).toMatchObject({ outcome: 'LOCATION_UNCONFIRMED', counted: false, run: null });
    const back = await call(t.app, {
      method: 'PATCH',
      url: '/api/v1/settings',
      cookie: owner,
      org: org.id,
      body: {
        changes: { 'patrol.count_unconfirmed_as_completed': true },
        version: off.json<{ version: number }>().version,
      },
    });
    expect(back.statusCode).toBe(200);
  });

  it('ADV-Q04 the same scan resubmitted keeps its first result; a new scan of the same checkpoint in the window is DUPLICATE', async () => {
    const { phone, shiftId } = await onShift();
    const first = scan(shiftId, qr('Main gate'), at(north(2)), 61_000);
    expect((await scanOne(phone, first)).scan?.outcome).toBe('VERIFIED');
    const again = await scanOne(phone, first);
    expect(again.status).toBe('DUPLICATE');
    expect(again.scan).toMatchObject({ outcome: 'VERIFIED', counted: true, run: { countedCount: 1 } });
    const second = await scanOne(phone, scan(shiftId, qr('Main gate'), at(north(2))));
    expect(second.status).toBe('ACCEPTED');
    expect(second.scan).toMatchObject({ outcome: 'DUPLICATE', counted: false, run: { countedCount: 1 } });
    const rows = await asOwner(t.db, (c) =>
      c.query<{ verification_status: string }>(
        'select verification_status from checkpoint_visits where shift_id = $1 order by scanned_at',
        [shiftId],
      ),
    );
    expect(rows.rows.map((r) => r.verification_status)).toEqual(['VERIFIED', 'DUPLICATE']);
  });

  it('ADV-Q05 an old label after rotation is INVALID_QR; the new one works', async () => {
    const { phone, shiftId } = await onShift();
    const old = qr('Side door');
    const rotated = await call(t.app, {
      method: 'POST',
      url: `/api/v1/checkpoints/${cp.get('Side door')!.id}/rotate-qr`,
      cookie: admin,
      org: org.id,
    });
    expect(rotated.statusCode).toBe(200);
    await loadLabels(admin, org.id, siteId);
    const stale = await scanOne(phone, scan(shiftId, old, at(north(100))));
    expect(stale.scan).toEqual({
      outcome: 'INVALID_QR',
      counted: false,
      checkpointName: null,
      distanceM: null,
      run: null,
    });
    const fresh = await scanOne(phone, scan(shiftId, qr('Side door'), at(north(100))));
    // Side door is in no route: the scan is recorded, verified, and belongs to no run.
    expect(fresh.scan).toMatchObject({ outcome: 'VERIFIED', checkpointName: 'Side door', run: null });
    const ids = await asOwner(t.db, (c) =>
      c.query<{ checkpoint_id: string | null }>(
        'select checkpoint_id from checkpoint_visits where shift_id = $1 order by created_at',
        [shiftId],
      ),
    );
    expect(ids.rows.map((r) => r.checkpoint_id)).toEqual([null, cp.get('Side door')!.id]);
  });

  it('ADV-Q06 a checkpoint of another site is WRONG_SITE and does not count', async () => {
    const { phone, shiftId } = await onShift();
    const result = await scanOne(phone, scan(shiftId, qr('Depot door'), at(north(3_000))));
    expect(result.scan).toEqual({
      outcome: 'WRONG_SITE',
      counted: false,
      checkpointName: null,
      distanceM: null,
      run: null,
    });
  });

  it('ADV-Q07 a scan with no active shift is NO_ACTIVE_SHIFT and keeps no coordinates (INV-08)', async () => {
    const { phone, guardId } = await newPhone();
    await createShift(guardId, siteId); // scheduled, never started
    const result = await scanOne(phone, scan(null, qr('Main gate'), at(north(30))));
    expect(result.scan).toEqual({
      outcome: 'NO_ACTIVE_SHIFT',
      counted: false,
      checkpointName: null,
      distanceM: null,
      run: null,
    });
    const row = await asOwner(t.db, (c) =>
      c.query<Record<string, unknown>>('select * from checkpoint_visits where guard_id = $1', [guardId]),
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      shift_id: null,
      latitude: null,
      longitude: null,
      distance_m: null,
      distance_band: '0-50',
      verification_status: 'NO_ACTIVE_SHIFT',
      counted: false,
    });
    // Coordinates outside a shift can't be written even by mistake: the database refuses them.
    await expect(
      asOwner(t.db, (c) =>
        c.query(
          `insert into checkpoint_visits (id, organization_id, guard_id, checkpoint_id, device_id, client_event_id,
             scanned_at_recorded, scanned_at, received_at, clock_status, latitude, longitude, verification_status)
           values ($1, $2, $3, $4, $5, $6, now(), now(), now(), 'VERIFIED_MONOTONIC', 31.47, 74.4, 'NO_ACTIVE_SHIFT')`,
          [randomUUID(), org.id, guardId, cp.get('Main gate')!.id, phone.deviceId, randomUUID()],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('ADV-Q08 two checkpoints 500 m apart scanned 10 s apart: IMPLAUSIBLE_TRAVEL and SUSPICIOUS_LOCATION', async () => {
    const { phone, shiftId } = await onShift();
    expect((await scanOne(phone, scan(shiftId, qr('Main gate'), at(north(3)), 11_000))).scan?.outcome).toBe(
      'VERIFIED',
    );
    const jump = await scanOne(phone, scan(shiftId, qr('Back fence'), at(north(498)), 1_000));
    expect(jump.scan?.outcome).toBe('VERIFIED');
    const visits = await call(t.app, {
      method: 'GET',
      url: `/api/v1/checkpoint-visits?shiftId=${shiftId}`,
      cookie: admin,
      org: org.id,
    });
    const list = visits.json<{ visits: { checkpoint: { name: string }; flags: string[] }[] }>().visits;
    expect(list.map((v) => [v.checkpoint.name, v.flags])).toEqual([
      ['Main gate', []],
      ['Back fence', ['IMPLAUSIBLE_TRAVEL']],
    ]);
    // No coordinates leave the server with a scan, only distances.
    expect(JSON.stringify(visits.json())).not.toMatch(/"lat"|"lng"|"latitude"|"longitude"/);
    const alerts = await alertsOf(shiftId);
    expect(alerts.filter((a) => a.type === 'SUSPICIOUS_LOCATION' && a.status === 'OPEN')).toHaveLength(1);
  });

  it('ADV-Q09 scans made offline are verified on sync, by their capture time', async () => {
    const { phone, shiftId } = await onShift();
    t.clock.advance(70 * MIN);
    // One batch after 70 min offline: a scan from run 1's window, then one from run 2's.
    const reply = await send(phone, [
      scan(shiftId, qr('Main gate'), at(north(5)), 60 * MIN),
      scan(shiftId, qr('Store room'), at(north(205)), 4 * MIN),
    ]);
    expect(reply.results.map((r) => r.scan?.outcome)).toEqual(['VERIFIED', 'VERIFIED']);
    const [run1, run2] = await runsOf(shiftId);
    expect(run1).toMatchObject({ sequenceNo: 1, countedCount: 1 });
    expect(run2).toMatchObject({ sequenceNo: 2, countedCount: 1 });
    const visits = (await runDetail(run1!.id)).visits;
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ outcome: 'VERIFIED', late: true, checkpoint: { name: 'Main gate' } });
  });

  it("ADV-T08 another organization's label scanned by a guard is INVALID_QR, exactly like an unknown token", async () => {
    const { phone, shiftId } = await onShift();
    const foreign = await scanOne(phone, scan(shiftId, qr('Bravo door'), at(north(2))));
    const unknown = await scanOne(phone, scan(shiftId, 'SG1:AAAAAAAAAAAAAAAAAAAAAA', at(north(2))));
    const garbage = await scanOne(phone, scan(shiftId, 'https://example.test/x', at(north(2))));
    expect(foreign.scan).toEqual({
      outcome: 'INVALID_QR',
      counted: false,
      checkpointName: null,
      distanceM: null,
      run: null,
    });
    expect(unknown).toEqual({ ...foreign, clientEventId: unknown.clientEventId });
    expect(garbage).toEqual({ ...foreign, clientEventId: garbage.clientEventId });
    // Nothing about B's checkpoint is kept on A's side, and B sees no scan at all.
    const mine = await asOwner(t.db, (c) =>
      c.query<{ checkpoint_id: string | null }>(
        'select checkpoint_id from checkpoint_visits where shift_id = $1',
        [shiftId],
      ),
    );
    expect(mine.rows.map((r) => r.checkpoint_id)).toEqual([null, null, null]);
    const theirs = await asOwner(t.db, (c) =>
      c.query<{ n: number }>('select count(*)::int as n from checkpoint_visits where organization_id = $1', [
        orgB.id,
      ]),
    );
    expect(theirs.rows[0]?.n).toBe(0);
  });
});

describe('patrol runs (PROD §9.2)', () => {
  it('a shift start generates its runs: due at start + offset + k·interval, closing at due + window', async () => {
    const { shiftId } = await onShift();
    const shift = await call(t.app, {
      method: 'GET',
      url: `/api/v1/shifts/${shiftId}`,
      cookie: admin,
      org: org.id,
    });
    const startedAt = new Date(shift.json<{ actualStartedAt: string }>().actualStartedAt).getTime();
    const runs = await runsOf(shiftId);
    expect(runs).toHaveLength(9);
    runs.forEach((r, k) => {
      expect(r.sequenceNo).toBe(k + 1);
      expect(new Date(r.dueAt).getTime()).toBe(startedAt + k * H);
      expect(new Date(r.windowEndsAt).getTime()).toBe(startedAt + k * H + 30 * MIN);
      expect(r).toMatchObject({ status: 'PENDING', requiredCount: 3, countedCount: 0 });
    });
  });

  it('completes with every required checkpoint; the closer marks the rest INCOMPLETE or MISSED, one alert each', async () => {
    const { phone, shiftId } = await onShift();
    const reply = await send(phone, [
      scan(shiftId, qr('Main gate'), at(north(2)), 100_000),
      scan(shiftId, qr('Store room'), at(north(198)), 60_000),
      scan(shiftId, qr('Back fence'), at(north(503)), 1_000),
    ]);
    expect(reply.results.at(-1)?.scan?.run).toEqual({
      countedCount: 3,
      requiredCount: 3,
      status: 'COMPLETED',
    });

    t.clock.advance(60 * MIN + 5 * MIN); // run 2's window
    expect((await scanOne(phone, scan(shiftId, qr('Main gate'), at(north(1))))).scan?.run?.status).toBe(
      'IN_PROGRESS',
    );
    t.clock.advance(28 * MIN); // past run 2's window and the grace
    await closer();
    t.clock.advance(60 * MIN); // past run 3's window too
    await closer();
    await closer(); // a second pass changes nothing

    const runs = await runsOf(shiftId);
    expect(runs.slice(0, 3).map((r) => r.status)).toEqual(['COMPLETED', 'INCOMPLETE', 'MISSED']);
    expect(runs[1]).toMatchObject({ countedCount: 1, missing: ['Store room', 'Back fence'] });
    const missed = (await alertsOf(shiftId)).filter((a) => a.type === 'CHECKPOINT_MISSED');
    expect(missed.map((a) => a.summary).sort()).toEqual([
      expect.stringMatching(/^Checkpoint run incomplete: Patrol \d+ \(Gulberg Warehouse\), 2 of 3 missing$/),
      expect.stringMatching(/^Checkpoint run missed: Patrol \d+ \(Gulberg Warehouse\), 3 of 3 missing$/),
    ]);
    expect(missed.every((a) => a.status === 'OPEN')).toBe(true);
    expect(missed.find((a) => a.summary.includes('incomplete'))?.details).toMatchObject({
      runId: runs[1]!.id,
      route: 'Night round',
      missing: ['Store room', 'Back fence'],
    });
  });

  it('late scans update a closed run; its alert stays for a person (PROD §12.1)', async () => {
    const { phone, shiftId } = await onShift();
    t.clock.advance(33 * MIN); // past run 1's window and the grace, with nothing received
    await closer();
    expect((await runsOf(shiftId))[0]?.status).toBe('MISSED');
    // The phone was offline; its round arrives now.
    const reply = await send(phone, [
      scan(shiftId, qr('Main gate'), at(north(2)), 30 * MIN),
      scan(shiftId, qr('Store room'), at(north(199)), 28 * MIN),
      scan(shiftId, qr('Back fence'), at(north(501)), 26 * MIN),
    ]);
    expect(reply.results.at(-1)?.scan?.run?.status).toBe('COMPLETED');
    expect((await runsOf(shiftId))[0]?.status).toBe('COMPLETED');
    const missed = (await alertsOf(shiftId)).filter((a) => a.type === 'CHECKPOINT_MISSED');
    expect(missed.map((a) => a.status)).toEqual(['OPEN']);
  });

  it("the shift's end cancels the runs not yet due and closes the one under way", async () => {
    const { phone, shiftId } = await onShift();
    await scanOne(phone, scan(shiftId, qr('Main gate'), at(north(1))));
    t.clock.advance(5 * MIN);
    const ended = await send(phone, [item('SHIFT_END', { shiftId, fix: at(GATE) })]);
    expect(ended.results[0]?.status).toBe('ACCEPTED');
    const runs = await runsOf(shiftId);
    expect(runs.map((r) => r.status)).toEqual(['INCOMPLETE', ...Array<string>(8).fill('CANCELLED')]);
    expect(runs[1]?.missing).toEqual([]);
    expect((await alertsOf(shiftId)).filter((a) => a.type === 'CHECKPOINT_MISSED')).toHaveLength(1);
  });

  it('an extension adds runs; a route change replaces only the runs not yet due', async () => {
    const yard = await addSite(admin, org.id, 'Yard', north(6_000));
    await addCheckpoint(admin, org.id, yard, 'Yard gate', north(6_000));
    await addCheckpoint(admin, org.id, yard, 'Yard shed', north(6_050));
    await loadLabels(admin, org.id, yard);
    const created = await createRoute(yard, {
      name: 'Yard round',
      schedule: ROUND,
      checkpoints: [{ checkpointId: cp.get('Yard gate')!.id }, { checkpointId: cp.get('Yard shed')!.id }],
    });
    const yardRoute = created.json<{ id: string; version: number }>();
    const { shiftId } = await onShift(yard, 4, north(6_000));
    expect((await runsOf(shiftId)).map((r) => r.sequenceNo)).toEqual([1, 2, 3, 4, 5]);

    const shift = await call(t.app, {
      method: 'GET',
      url: `/api/v1/shifts/${shiftId}`,
      cookie: admin,
      org: org.id,
    });
    const extended = await call(t.app, {
      method: 'POST',
      url: `/api/v1/shifts/${shiftId}/extend`,
      cookie: admin,
      org: org.id,
      body: {
        endsAt: new Date(new Date(shift.json<{ endsAt: string }>().endsAt).getTime() + 2 * H).toISOString(),
      },
    });
    expect(extended.statusCode).toBe(200);
    expect((await runsOf(shiftId)).map((r) => r.sequenceNo)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    t.clock.advance(10 * MIN); // run 1 is due; the rest are not
    const before = await runsOf(shiftId);
    const changed = await call(t.app, {
      method: 'PATCH',
      url: `/api/v1/patrol-routes/${yardRoute.id}`,
      cookie: admin,
      org: org.id,
      body: {
        schedule: { intervalMinutes: 120, firstRunOffsetMinutes: 0, completionWindowMinutes: 45 },
        version: yardRoute.version,
      },
    });
    expect(changed.statusCode).toBe(200);
    const after = await runsOf(shiftId);
    expect(after[0]).toEqual(before[0]); // already due: untouched
    expect(
      after
        .slice(1)
        .map((r) => [r.sequenceNo, new Date(r.dueAt).getTime() - new Date(after[0]!.dueAt).getTime()]),
    ).toEqual([
      [2, 2 * H],
      [3, 4 * H],
      [4, 6 * H],
    ]);
    expect(
      after
        .slice(1)
        .every((r) => new Date(r.windowEndsAt).getTime() - new Date(r.dueAt).getTime() === 45 * MIN),
    ).toBe(true);

    // Taking the schedule away leaves the run already due and owes nothing more.
    const onDemand = await call(t.app, {
      method: 'PATCH',
      url: `/api/v1/patrol-routes/${yardRoute.id}`,
      cookie: admin,
      org: org.id,
      body: { schedule: null, version: changed.json<{ version: number }>().version },
    });
    expect(onDemand.statusCode).toBe(200);
    // The run under way is cancelled, not left to close as missed against the guard.
    expect((await runsOf(shiftId)).map((r) => [r.sequenceNo, r.status])).toEqual([[1, 'CANCELLED']]);
    expect((await alertsOf(shiftId)).filter((a) => a.type === 'CHECKPOINT_MISSED')).toEqual([]);
  });
});

describe('patrol routes', () => {
  it('validation: the site, one scheduled route per checkpoint, a required checkpoint, the window', async () => {
    const badSite = await createRoute(siteId, {
      name: 'Wrong',
      schedule: null,
      checkpoints: [{ checkpointId: cp.get('Depot door')!.id }],
    });
    expect(badSite.statusCode).toBe(400);
    expect(errorCode(badSite)).toBe('VALIDATION_FAILED');
    const taken = await createRoute(siteId, {
      name: 'Second round',
      schedule: ROUND,
      checkpoints: [{ checkpointId: cp.get('Main gate')!.id }],
    });
    expect(taken.statusCode).toBe(400);
    expect(taken.json<{ error: { message: string } }>().error.message).toContain('Main gate');
    const noneRequired = await createRoute(siteId, {
      name: 'Optional only',
      schedule: ROUND,
      checkpoints: [{ checkpointId: cp.get('Office')!.id, required: false }],
    });
    expect(noneRequired.statusCode).toBe(400);
    const longWindow = await createRoute(siteId, {
      name: 'Too long',
      schedule: { intervalMinutes: 30, completionWindowMinutes: 45 },
      checkpoints: [{ checkpointId: cp.get('Office')!.id }],
    });
    expect(longWindow.statusCode).toBe(400);
    // On demand, a checkpoint may sit in another route as well.
    const onDemand = await createRoute(siteId, {
      name: 'Spot checks',
      schedule: null,
      checkpoints: [{ checkpointId: cp.get('Main gate')!.id }, { checkpointId: cp.get('Office')!.id }],
    });
    expect(onDemand.statusCode).toBe(201);
    expect(onDemand.json()).toMatchObject({
      schedule: null,
      checkpoints: [
        { name: 'Main gate', sequence: 1 },
        { name: 'Office', sequence: 2 },
      ],
    });

    const list = await call(t.app, {
      method: 'GET',
      url: `/api/v1/sites/${siteId}/patrol-routes`,
      cookie: admin,
      org: org.id,
    });
    expect(list.json<{ routes: { name: string }[] }>().routes.map((r) => r.name)).toEqual([
      'Night round',
      'Spot checks',
    ]);
  });

  it('edits are versioned and audited', async () => {
    const list = await call(t.app, {
      method: 'GET',
      url: `/api/v1/sites/${siteId}/patrol-routes`,
      cookie: admin,
      org: org.id,
    });
    const spot = list
      .json<{ routes: { id: string; name: string; version: number }[] }>()
      .routes.find((r) => r.name === 'Spot checks')!;
    const renamed = await call(t.app, {
      method: 'PATCH',
      url: `/api/v1/patrol-routes/${spot.id}`,
      cookie: admin,
      org: org.id,
      body: { name: 'Spot checks (day)', enforceOrder: true, version: spot.version },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      name: 'Spot checks (day)',
      enforceOrder: true,
      version: spot.version + 1,
    });
    const stale = await call(t.app, {
      method: 'PATCH',
      url: `/api/v1/patrol-routes/${spot.id}`,
      cookie: admin,
      org: org.id,
      body: { name: 'Lost update', version: spot.version },
    });
    expect(stale.statusCode).toBe(409);
    expect(errorCode(stale)).toBe('VERSION_CONFLICT');
    const audit = await asOwner(t.db, (c) =>
      c.query<{ action: string }>(
        `select action from audit_logs where organization_id = $1 and resource_type = 'patrol_route' order by created_at`,
        [org.id],
      ),
    );
    expect(audit.rows.map((r) => r.action)).toContain('PATROL_ROUTE_CREATED');
    expect(audit.rows.map((r) => r.action)).toContain('PATROL_ROUTE_UPDATED');
    // An organization in the body is refused, never applied (ADV-A10).
    expect(
      (
        await call(t.app, {
          method: 'PATCH',
          url: `/api/v1/patrol-routes/${spot.id}`,
          cookie: admin,
          org: org.id,
          body: { name: 'x', version: 1, organizationId: orgB.id },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("an active route's checkpoints stay active: an inactive one can't be added, a stop can't be switched off", async () => {
    const read = async () =>
      (
        await call(t.app, {
          method: 'GET',
          url: `/api/v1/sites/${siteId}/checkpoints`,
          cookie: admin,
          org: org.id,
        })
      ).json<{ checkpoints: { id: string; version: number }[] }>().checkpoints;
    const versionOf = async (id: string) => (await read()).find((c) => c.id === id)!.version;
    const patch = async (id: string, body: Record<string, unknown>) =>
      call(t.app, {
        method: 'PATCH',
        url: `/api/v1/checkpoints/${id}`,
        cookie: admin,
        org: org.id,
        body: { ...body, version: await versionOf(id) },
      });

    const side = cp.get('Side door')!.id;
    expect((await patch(side, { status: 'INACTIVE' })).statusCode).toBe(200);
    const withInactive = await createRoute(siteId, {
      name: 'Side checks',
      schedule: null,
      checkpoints: [{ checkpointId: side }],
    });
    expect(withInactive.statusCode).toBe(400);
    expect(withInactive.json<{ error: { message: string } }>().error.message).toContain('Side door');

    const store = cp.get('Store room')!.id;
    const archive = await patch(store, { status: 'ARCHIVED' });
    expect(archive.statusCode).toBe(400);
    expect(archive.json<{ error: { message: string } }>().error.message).toContain('Night round');
    // Other edits of a stop are fine.
    expect((await patch(store, { description: 'Behind the loading bay' })).statusCode).toBe(200);
  });

  it("ADV-T04 a route can't name another organization's checkpoint, through the API or in the database", async () => {
    const viaApi = await createRoute(siteId, {
      name: 'Sneaky',
      schedule: null,
      checkpoints: [{ checkpointId: cp.get('Bravo door')!.id }],
    });
    expect(viaApi.statusCode).toBe(400);
    expect(errorCode(viaApi)).toBe('VALIDATION_FAILED');
    await expect(
      asOwner(t.db, (c) =>
        c.query(
          `insert into patrol_route_checkpoints (id, organization_id, site_id, patrol_route_id, checkpoint_id, sequence)
           values ($1, $2, $3, $4, $5, 9)`,
          [randomUUID(), org.id, siteId, routeId, cp.get('Bravo door')!.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
    // A checkpoint of another site of the same organization is refused by the same key.
    await expect(
      asOwner(t.db, (c) =>
        c.query(
          `insert into patrol_route_checkpoints (id, organization_id, site_id, patrol_route_id, checkpoint_id, sequence)
           values ($1, $2, $3, $4, $5, 9)`,
          [randomUUID(), org.id, siteId, routeId, cp.get('Depot door')!.id],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("the guard's own rounds", () => {
  it("ADV-A03 the guard sees their own shift's rounds; another guard's shift is not found", async () => {
    const mine = await onShift();
    const other = await onShift();
    await scanOne(mine.phone, scan(mine.shiftId, qr('Main gate'), at(north(1))));
    const res = await asPhone(t.app, mine.phone, {
      method: 'GET',
      url: `/api/v1/me/patrols?shiftId=${mine.shiftId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      runs: { routeName: string; checkpoints: { name: string; done: string | null }[] }[];
    }>();
    expect(body.runs).toHaveLength(9);
    expect(body.runs[0]).toMatchObject({ routeName: 'Night round' });
    expect(body.runs[0]?.checkpoints.map((c) => [c.name, c.done])).toEqual([
      ['Main gate', 'VERIFIED'],
      ['Store room', null],
      ['Back fence', null],
    ]);
    // No QR data reaches the guard (PROD §3.2).
    expect(JSON.stringify(body)).not.toContain('SG1:');
    const theirs = await asPhone(t.app, mine.phone, {
      method: 'GET',
      url: `/api/v1/me/patrols?shiftId=${other.shiftId}`,
    });
    expect(theirs.statusCode).toBe(404);
    expect(errorCode(theirs)).toBe('NOT_FOUND');
    // Dashboard users have no rounds of their own.
    const dashboard = await call(t.app, {
      method: 'GET',
      url: `/api/v1/me/patrols?shiftId=${mine.shiftId}`,
      cookie: admin,
      org: org.id,
    });
    expect(dashboard.statusCode).toBe(403);
  });

  it('the mobile configuration switches patrols on', async () => {
    const { phone } = await newPhone();
    const config = await asPhone(t.app, phone, { method: 'GET', url: '/api/v1/mobile/config' });
    expect(config.json<{ features: { patrols: boolean } }>().features.patrols).toBe(true);
  });

  it('beyond 60 scans a minute, a scan waits (RETRY) and nothing is lost (SEC §9)', async () => {
    const { phone, shiftId } = await onShift();
    const items = Array.from({ length: 61 }, (_, i) =>
      scan(shiftId, qr('Office'), at(north(5)), 61_000 - i * 1_000),
    );
    const reply = await send(phone, items);
    expect(reply.results.slice(0, 60).every((r) => r.status === 'ACCEPTED')).toBe(true);
    expect(reply.results[60]?.status).toBe('RETRY');
    t.clock.advance(61_000);
    const later = await send(phone, [items[60]!]);
    expect(later.results[0]?.status).toBe('ACCEPTED');
  });
});
