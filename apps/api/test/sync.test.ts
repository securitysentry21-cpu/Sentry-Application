// The sync pipeline (ARCH §9): per-item results, idempotency, the shift window, out-of-order data,
// quarantine. Items are built the way the guard app builds them.
import { randomUUID } from 'node:crypto';

import { syncItemSchema } from '@sentryops/contracts';
import { tenantTables, TABLES } from '@sentryops/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
let org: Awaited<ReturnType<typeof seedOrganization>>;
let admin: string;
let siteId: string;
let seq = 0;

const H = 3_600_000;
const BOOT = 'boot-1';
const AT_SITE = { lat: 31.4702, lon: 74.4001, accuracyM: 8 };
let mono = 1_000_000;

type Item = Record<string, unknown>;

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

async function send(phone: EnrolledPhone, items: Item[]) {
  const res = await asPhone(t.app, phone, {
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
  if (res.statusCode !== 200) throw new Error(`sync failed: ${res.statusCode} ${res.body}`);
  return res.json<{
    results: { clientEventId: string; status: string; code?: string }[];
    shifts: { shiftId: string; status: string }[];
  }>();
}

async function onShift(): Promise<{ phone: EnrolledPhone; shiftId: string; guardId: string }> {
  const number = `+9230022${String(10_000 + seq++).padStart(5, '0')}`;
  const guardId = await createGuard(t.app, admin, org.id, {
    employeeNumber: `Y-${number.slice(-5)}`,
    displayName: `Sync ${number.slice(-3)}`,
    phone: number,
  });
  const phone = await enrollPhone(t.app, admin, org.id, guardId, number);
  const startsAt = new Date(t.clock.now().getTime() + 5 * 60_000);
  const created = await call(t.app, {
    method: 'POST',
    url: '/api/v1/shifts',
    cookie: admin,
    org: org.id,
    body: {
      guardId,
      siteId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 8 * H).toISOString(),
    },
  });
  const shiftId = created.json<{ id: string }>().id;
  const started = await send(phone, [
    item('SHIFT_START', {
      shiftId,
      fix: { ...AT_SITE, fixAgeS: 2 },
      permission: { location: 'ALWAYS', precise: true },
    }),
  ]);
  expect(started.results[0]?.status).toBe('ACCEPTED');
  return { phone, shiftId, guardId };
}

const points = async (shiftId: string) =>
  (
    await asOwner(t.db, (c) =>
      c.query<{ latitude: number; captured_at: Date; flags: string[] }>(
        'select latitude, captured_at, flags from location_points where shift_id = $1 order by captured_at',
        [shiftId],
      ),
    )
  ).rows;

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'Sync Co', [{ email: 'admin@sync.test', role: 'ADMIN' }]);
  admin = await signIn(t.app, 'admin@sync.test');
  const site = await call(t.app, {
    method: 'POST',
    url: '/api/v1/sites',
    cookie: admin,
    org: org.id,
    body: { name: 'Gate', boundary: { kind: 'CIRCLE', center: { lat: 31.47, lng: 74.4 }, radiusM: 300 } },
  });
  siteId = site.json<{ id: string }>().id;
});

afterAll(async () => {
  await t?.close();
});

describe('sync batch (ARCH §9)', () => {
  it('a shift starts through sync, and the reply carries the server state of the shift', async () => {
    const { phone, shiftId } = await onShift();
    const res = await send(phone, [item('HEARTBEAT', { shiftId })]);
    expect(res.results[0]?.status).toBe('ACCEPTED');
    const reply = await send(phone, [item('LOCATION', { shiftId, fix: AT_SITE })]);
    expect(reply.shifts).toEqual([expect.objectContaining({ shiftId, status: 'ACTIVE' })]);
  });

  it('ADV-L01 the same location event twice: one row, the second result DUPLICATE', async () => {
    const { phone, shiftId } = await onShift();
    const point = item('LOCATION', { shiftId, fix: AT_SITE });
    expect((await send(phone, [point])).results[0]?.status).toBe('ACCEPTED');
    expect((await send(phone, [point])).results[0]?.status).toBe('DUPLICATE');
    expect(await points(shiftId)).toHaveLength(1);
  });

  it('ADV-L09 the same client event ID with altered coordinates: original kept, DUPLICATE, anomaly counted', async () => {
    const { phone, shiftId } = await onShift();
    const point = item('LOCATION', { shiftId, fix: AT_SITE });
    await send(phone, [point]);
    const before = t.deps.metrics.get('idempotency_conflict');
    const altered = { ...point, fix: { ...AT_SITE, lat: 31.48 } };
    expect((await send(phone, [altered])).results[0]?.status).toBe('DUPLICATE');
    expect((await points(shiftId))[0]?.latitude).toBe(AT_SITE.lat);
    expect(t.deps.metrics.get('idempotency_conflict')).toBe(before + 1);
  });

  it("ADV-L02 a location for another guard's shift is rejected and not stored", async () => {
    const mine = await onShift();
    const other = await onShift();
    const res = await send(mine.phone, [item('LOCATION', { shiftId: other.shiftId, fix: AT_SITE })]);
    expect(res.results[0]).toMatchObject({ status: 'REJECTED', code: 'NOT_FOUND' });
    expect(await points(other.shiftId)).toHaveLength(0);
  });

  it('ADV-L08 a batch mixing valid and invalid items: per-item results, the valid ones stored', async () => {
    const { phone, shiftId } = await onShift();
    const good = item('LOCATION', { shiftId, fix: AT_SITE });
    const bad = { clientEventId: randomUUID(), type: 'LOCATION', shiftId, fix: { lat: 200, lon: 0 } };
    const good2 = item('LOCATION', { shiftId, fix: { ...AT_SITE, lat: 31.4703 } });
    const res = await send(phone, [good, bad, good2]);
    expect(res.results.map((r) => r.status)).toEqual(['ACCEPTED', 'REJECTED', 'ACCEPTED']);
    expect(await points(shiftId)).toHaveLength(2);
  });

  it('ADV-L04 ADV-P01 a location captured after the shift ended (beyond tolerance) is rejected and not stored', async () => {
    const { phone, shiftId } = await onShift();
    expect((await send(phone, [item('SHIFT_END', { shiftId, fix: AT_SITE })])).results[0]?.status).toBe(
      'ACCEPTED',
    );
    t.clock.advance(5 * 60_000);
    await refreshPhone(t.app, phone);
    const late = await send(phone, [item('LOCATION', { shiftId, fix: AT_SITE }, 1_000)]);
    expect(late.results[0]).toMatchObject({ status: 'REJECTED', code: 'OUTSIDE_SHIFT_WINDOW' });
    expect(await points(shiftId)).toHaveLength(0);
  });

  it('ADV-L05 a location captured during the shift but uploaded after it completed is accepted', async () => {
    const { phone, shiftId } = await onShift();
    t.clock.advance(10 * 60_000);
    // Captured 5 minutes ago (during the shift), then the shift ends, then it uploads.
    const during = item('LOCATION', { shiftId, fix: AT_SITE }, 5 * 60_000);
    expect((await send(phone, [item('SHIFT_END', { shiftId, fix: AT_SITE })])).results[0]?.status).toBe(
      'ACCEPTED',
    );
    expect((await send(phone, [during])).results[0]?.status).toBe('ACCEPTED');
    expect(await points(shiftId)).toHaveLength(1);
  });

  it('ADV-L06 points arriving out of order: history by capture time, live state never moves back', async () => {
    const { phone, shiftId } = await onShift();
    t.clock.advance(3 * 60_000);
    await refreshPhone(t.app, phone);
    const newer = item('LOCATION', { shiftId, fix: { ...AT_SITE, lat: 31.4705 } }, 10_000);
    const older = item('LOCATION', { shiftId, fix: { ...AT_SITE, lat: 31.4701 } }, 100_000);
    await send(phone, [newer]);
    await send(phone, [older]);
    const history = await points(shiftId);
    expect(history.map((p) => p.latitude)).toEqual([31.4701, 31.4705]);
    const snapshot = await call(t.app, {
      method: 'GET',
      url: '/api/v1/dashboard/snapshot',
      cookie: admin,
      org: org.id,
    });
    const live = snapshot
      .json<{ guards: { shiftId: string; lastFix: { lat: number } | null }[] }>()
      .guards.find((g) => g.shiftId === shiftId);
    expect(live?.lastFix?.lat).toBe(31.4705);
  });

  it('ADV-O03 an offline start the server rejects on sync comes back REJECTED with its reason', async () => {
    const number = `+9230033${String(10_000 + seq++).padStart(5, '0')}`;
    const guardId = await createGuard(t.app, admin, org.id, {
      employeeNumber: `Z-${number.slice(-5)}`,
      displayName: 'Late',
      phone: number,
    });
    const phone = await enrollPhone(t.app, admin, org.id, guardId, number);
    const startsAt = new Date(t.clock.now().getTime() + 6 * H); // far in the future: outside the window
    const created = await call(t.app, {
      method: 'POST',
      url: '/api/v1/shifts',
      cookie: admin,
      org: org.id,
      body: {
        guardId,
        siteId,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 4 * H).toISOString(),
      },
    });
    const shiftId = created.json<{ id: string }>().id;
    const res = await send(phone, [
      item(
        'SHIFT_START',
        { shiftId, fix: { ...AT_SITE, fixAgeS: 1 }, permission: { location: 'ALWAYS', precise: true } },
        10 * 60_000,
      ),
    ]);
    expect(res.results[0]).toMatchObject({ status: 'REJECTED', code: 'SHIFT_OUTSIDE_START_WINDOW' });
    expect(res.shifts).toEqual([expect.objectContaining({ shiftId, status: 'SCHEDULED' })]);
  });

  it('ADV-X06 every offline item type: a duplicate has one effect and the same result', async () => {
    const { phone, shiftId } = await onShift();
    const items: Item[] = [
      item('LOCATION', { shiftId, fix: AT_SITE }),
      item('HEARTBEAT', { shiftId }),
      item('DEVICE_STATUS', {
        shiftId,
        status: {
          locationPermission: 'ALWAYS',
          preciseLocation: true,
          locationServicesEnabled: true,
          trackingServiceState: 'RUNNING',
          batteryPct: 64,
        },
      }),
      item('SHIFT_END', { shiftId, fix: AT_SITE }),
    ];
    const first = await send(phone, items);
    expect(first.results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
    const again = await send(phone, items);
    // Heartbeats carry no record of their own; every other type reports DUPLICATE on a resubmit.
    expect(again.results.map((r) => r.status)).toEqual(['DUPLICATE', 'ACCEPTED', 'DUPLICATE', 'DUPLICATE']);
    const counts = await asOwner(t.db, async (c) => ({
      points: (await c.query('select 1 from location_points where shift_id = $1', [shiftId])).rowCount,
      statuses: (await c.query('select 1 from device_status_events where shift_id = $1', [shiftId])).rowCount,
      ends: (await c.query(`select 1 from shift_events where shift_id = $1 and type = 'ENDED'`, [shiftId]))
        .rowCount,
    }));
    expect(counts).toEqual({ points: 1, statuses: 1, ends: 1 });
  });

  it('ADV-O09 one item that triggers a server error is quarantined; the rest of the batch is accepted', async () => {
    const { phone, shiftId } = await onShift();
    const poisoned = item('LOCATION', { shiftId, fix: { ...AT_SITE, lat: 31.47999 } });
    // A database fault for exactly this item, planted in the test database only.
    await asOwner(t.db, async (c) => {
      await c.query(`create function fail_one() returns trigger language plpgsql as $$
        begin if new.client_event_id = '${String(poisoned.clientEventId)}'::uuid then raise exception 'planted fault'; end if; return new; end $$`);
      await c.query(
        'create trigger fail_one before insert on location_points for each row execute function fail_one()',
      );
    });
    const items = [
      item('LOCATION', { shiftId, fix: AT_SITE }),
      poisoned,
      item('LOCATION', { shiftId, fix: { ...AT_SITE, lat: 31.4704 } }),
    ];
    const res = await send(phone, items);
    expect(res.results.map((r) => r.status)).toEqual(['ACCEPTED', 'QUARANTINED', 'ACCEPTED']);
    expect(await points(shiftId)).toHaveLength(2);
    const { rows } = await asOwner(t.db, (c) =>
      c.query(`select 1 from quarantined_items where client_event_id = $1`, [String(poisoned.clientEventId)]),
    );
    expect(rows).toHaveLength(1);
    await asOwner(t.db, (c) => c.query('drop trigger fail_one on location_points; drop function fail_one()'));
  });
});

describe('a replaced phone (ARCH §5.4)', () => {
  it('ADV-A08 a phone REPLACED by a new one uploads what it captured before, for 72 hours, and nothing else', async () => {
    const { phone, shiftId, guardId } = await onShift();
    const before = item('LOCATION', { shiftId, fix: AT_SITE });
    const number = (
      await asOwner(t.db, (c) =>
        c.query<{ phone: string }>('select phone from guards where id = $1', [guardId]),
      )
    ).rows[0]!.phone;
    await enrollPhone(t.app, admin, org.id, guardId, number); // the new phone
    t.clock.advance(60_000);
    mono += 60_000;
    const after = item('LOCATION', { shiftId, fix: AT_SITE });
    const res = await send(phone, [before, after]);
    expect(res.results.map((r) => [r.status, r.code])).toEqual([
      ['ACCEPTED', undefined],
      ['REJECTED', 'DEVICE_REVOKED'],
    ]);
    // Only the upload: every other route refuses the old phone.
    const config = await asPhone(t.app, phone, { method: 'GET', url: '/api/v1/mobile/config' });
    expect(errorCode(config)).toBe('DEVICE_REVOKED');
    // It may refresh while it drains; after 72 hours the upload is refused too.
    t.clock.advance(71 * H + 50 * 60_000);
    await refreshPhone(t.app, phone);
    t.clock.advance(10 * 60_000);
    const late = await asPhone(t.app, phone, {
      method: 'POST',
      url: '/api/v1/sync/batch',
      body: {
        batchId: randomUUID(),
        sentAt: t.clock.now().toISOString(),
        sentMonoMs: mono,
        bootId: BOOT,
        items: [before],
      },
    });
    expect(errorCode(late)).toBe('DEVICE_REVOKED');
    // Three days on, the admin's dashboard session has expired too (12 hours idle).
    admin = await signIn(t.app, 'admin@sync.test');
  });
});

describe('no coordinates outside a shift (INV-08)', () => {
  // Generated over the contract: every sync item type that can carry a fix needs a case here, so a
  // new coordinate-carrying item can't skip the check. Each is sent where no shift window is open.
  const SECRET = { lat: 33.123457, lon: 73.654321, accuracyM: 6 };
  const cases: Record<string, (shiftId: string) => Item> = {
    SHIFT_START: (shiftId) =>
      item('SHIFT_START', {
        shiftId,
        fix: { ...SECRET, fixAgeS: 1 },
        permission: { location: 'ALWAYS', precise: true },
      }),
    SHIFT_END: (shiftId) => item('SHIFT_END', { shiftId, fix: { ...SECRET, fixAgeS: 1 } }),
    LOCATION: (shiftId) => item('LOCATION', { shiftId, fix: SECRET }),
    CHECKPOINT_SCAN: () =>
      item('CHECKPOINT_SCAN', { shiftId: null, token: 'SG1:unknown', fix: { ...SECRET, fixAgeS: 1 } }),
    INCIDENT: () =>
      item('INCIDENT', {
        shiftId: null,
        incident: {
          type: 'OTHER',
          severity: 'LOW',
          title: 'Test',
          description: '',
          occurredAt: t.clock.now().toISOString(),
        },
        fix: { ...SECRET, fixAgeS: 1 },
      }),
  };

  it('ADV-P05 items with coordinates sent outside any shift window store no coordinates anywhere', async () => {
    const withFix = syncItemSchema.options
      .filter((o) => 'fix' in o.shape)
      .map((o) => o.shape.type.value)
      .sort();
    expect(Object.keys(cases).sort()).toEqual(withFix);

    const number = `+9230022${String(20_000 + seq++).padStart(5, '0')}`;
    const guardId = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'P05',
      displayName: 'Privacy',
      phone: number,
    });
    const phone = await enrollPhone(t.app, admin, org.id, guardId, number);
    // Scheduled three hours ahead: too early to start, so no window is open.
    const startsAt = new Date(t.clock.now().getTime() + 3 * H);
    const created = await call(t.app, {
      method: 'POST',
      url: '/api/v1/shifts',
      cookie: admin,
      org: org.id,
      body: {
        guardId,
        siteId,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 8 * H).toISOString(),
      },
    });
    const shiftId = created.json<{ id: string }>().id;
    const res = await send(
      phone,
      withFix.map((type) => cases[type]!(shiftId)),
    );
    expect(res.results.map((r) => r.status)).toEqual(withFix.map(() => 'REJECTED'));

    // Every tenant table, every column, as text: the coordinates appear nowhere.
    for (const table of tenantTables(TABLES)) {
      const column = table === 'organizations' ? 'id' : 'organization_id';
      const rows = await asOwner(t.db, (c) =>
        c.query<{ row: string }>(`select row_to_json(x)::text as row from ${table} x where ${column} = $1`, [
          org.id,
        ]),
      );
      for (const r of rows.rows) {
        expect(r.row, table).not.toContain('33.1234');
        expect(r.row, table).not.toContain('73.6543');
      }
    }
  });
});

describe('live snapshot (D-36)', () => {
  it('tracking health and location age are reported separately; dispatchers may read it', async () => {
    const { phone, shiftId } = await onShift();
    await send(phone, [item('LOCATION', { shiftId, fix: AT_SITE })]);
    const disp = await seedOrganization(t.db, 'unused', []);
    void disp;
    const res = await call(t.app, {
      method: 'GET',
      url: '/api/v1/dashboard/snapshot',
      cookie: admin,
      org: org.id,
    });
    const live = res
      .json<{ guards: { shiftId: string; trackingHealth: string; locationAge: string }[] }>()
      .guards.find((g) => g.shiftId === shiftId);
    expect(live).toMatchObject({ trackingHealth: 'LIVE', locationAge: 'CURRENT' });
    t.clock.advance(6 * 60_000);
    const later = await call(t.app, {
      method: 'GET',
      url: '/api/v1/dashboard/snapshot',
      cookie: admin,
      org: org.id,
    });
    const stale = later
      .json<{ guards: { shiftId: string; trackingHealth: string; locationAge: string }[] }>()
      .guards.find((g) => g.shiftId === shiftId);
    expect(stale).toMatchObject({ trackingHealth: 'OFFLINE', locationAge: 'LAST_KNOWN' });
  });
});
