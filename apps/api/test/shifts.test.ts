// Shifts through the API and the detectors (PROD §6, ARCH §7, §16).
import { randomUUID } from 'node:crypto';

import { createKysely, createPool, type Pool } from '@sentryops/db';
import { withTenantTransaction } from '@sentryops/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guardStart } from '../src/services/shifts.ts';
import { applyForOrganization, runShiftDetectors } from '../src/workers/detectors.ts';
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
let admin: string;
let supervisor: string;
let dispatcher: string;
let siteId: string;
let seq = 0;

const H = 3_600_000;
const SITE_CENTER = { lat: 31.47, lng: 74.4 };
const AT_SITE = { lat: 31.4702, lon: 74.4001, accuracyM: 8, fixAgeS: 3 };
const FAR_AWAY = { lat: 31.5, lon: 74.45, accuracyM: 8, fixAgeS: 3 };
const ALWAYS = { location: 'ALWAYS', precise: true };

async function guardWithPhone(): Promise<{ guardId: string; phone: EnrolledPhone }> {
  const number = `+9230011${String(10_000 + seq++).padStart(5, '0')}`;
  const guardId = await createGuard(t.app, admin, org.id, {
    employeeNumber: `S-${number.slice(-5)}`,
    displayName: `Guard ${number.slice(-3)}`,
    phone: number,
  });
  return { guardId, phone: await enrollPhone(t.app, supervisor, org.id, guardId, number) };
}

/** A shift starting `inMinutes` from the test clock's now, `hours` long. */
async function shiftFor(guardId: string, inMinutes: number, hours = 8): Promise<string> {
  const startsAt = new Date(t.clock.now().getTime() + inMinutes * 60_000);
  const res = await call(t.app, {
    method: 'POST',
    url: '/api/v1/shifts',
    cookie: admin,
    org: org.id,
    body: {
      guardId,
      siteId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + hours * H).toISOString(),
    },
  });
  if (res.statusCode !== 201) throw new Error(`create shift failed: ${res.statusCode} ${res.body}`);
  return res.json<{ id: string }>().id;
}

const start = (phone: EnrolledPhone, shiftId: string, body: Record<string, unknown> = {}) =>
  asPhone(t.app, phone, {
    method: 'POST',
    url: `/api/v1/shifts/${shiftId}/start`,
    body: {
      clientEventId: randomUUID(),
      recordedAt: t.clock.now().toISOString(),
      fix: AT_SITE,
      permission: ALWAYS,
      ...body,
    },
  });

const shiftRow = async (id: string) =>
  (
    await asOwner(t.db, (c) =>
      c.query<{
        status: string;
        actual_started_at: Date | null;
        start_flags: string[];
        end_reason: string | null;
      }>('select status, actual_started_at, start_flags, end_reason from shifts where id = $1', [id]),
    )
  ).rows[0];

beforeAll(async () => {
  t = await startTestApp();
  sweepPool = createPool(t.db.urls.system_worker, { max: 2 });
  org = await seedOrganization(t.db, 'Shift Co', [
    { email: 'admin@shift.test', role: 'ADMIN' },
    { email: 'sup@shift.test', role: 'SUPERVISOR' },
    { email: 'disp@shift.test', role: 'DISPATCHER' },
  ]);
  admin = await signIn(t.app, 'admin@shift.test');
  supervisor = await signIn(t.app, 'sup@shift.test');
  dispatcher = await signIn(t.app, 'disp@shift.test');
  const site = await call(t.app, {
    method: 'POST',
    url: '/api/v1/sites',
    cookie: admin,
    org: org.id,
    body: { name: 'Gate 1', boundary: { kind: 'CIRCLE', center: SITE_CENTER, radiusM: 200 } },
  });
  siteId = site.json<{ id: string }>().id;
});

afterAll(async () => {
  await sweepPool?.end();
  await t?.close();
});

describe('creating shifts (PROD §6.1–§6.2)', () => {
  it('ADV-SH03 overlapping shifts for one guard are refused by the API and by the database', async () => {
    const { guardId } = await guardWithPhone();
    const first = await shiftFor(guardId, 60);
    const clash = await call(t.app, {
      method: 'POST',
      url: '/api/v1/shifts',
      cookie: admin,
      org: org.id,
      body: {
        guardId,
        siteId,
        startsAt: new Date(t.clock.now().getTime() + 2 * H).toISOString(),
        endsAt: new Date(t.clock.now().getTime() + 5 * H).toISOString(),
      },
    });
    expect(errorCode(clash)).toBe('SHIFT_OVERLAP');
    await expect(
      asOwner(t.db, (c) =>
        c.query(
          `insert into shifts (id, organization_id, guard_id, site_id, starts_at, ends_at, start_deadline_at)
           values ($1, $2, $3, $4, $5, $6, $6)`,
          [
            randomUUID(),
            org.id,
            guardId,
            siteId,
            new Date(t.clock.now().getTime() + 2 * H),
            new Date(t.clock.now().getTime() + 3 * H),
          ],
        ),
      ),
    ).rejects.toThrow(/conflicting key value violates exclusion constraint/);
    // A cancelled shift frees the slot.
    expect(
      (
        await call(t.app, {
          method: 'POST',
          url: `/api/v1/shifts/${first}/cancel`,
          cookie: supervisor,
          org: org.id,
          body: { reason: 'swap' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(t.app, {
          method: 'POST',
          url: '/api/v1/shifts',
          cookie: admin,
          org: org.id,
          body: {
            guardId,
            siteId,
            startsAt: new Date(t.clock.now().getTime() + 2 * H).toISOString(),
            endsAt: new Date(t.clock.now().getTime() + 5 * H).toISOString(),
          },
        })
      ).statusCode,
    ).toBe(201);
  });

  it('a shift is at most 24 hours and ends after it starts', async () => {
    const { guardId } = await guardWithPhone();
    const startsAt = new Date(t.clock.now().getTime() + H);
    for (const endsAt of [new Date(startsAt.getTime() + 25 * H), startsAt]) {
      const res = await call(t.app, {
        method: 'POST',
        url: '/api/v1/shifts',
        cookie: admin,
        org: org.id,
        body: { guardId, siteId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      });
      expect(errorCode(res)).toBe('VALIDATION_FAILED');
    }
  });

  it('ADV-TM01 bulk create: Mon–Sat 20:00–08:00 in the site time zone, preview first, all or nothing', async () => {
    const { guardId } = await guardWithPhone();
    const body = {
      guardId,
      siteId,
      weekdays: [1, 2, 3, 4, 5, 6],
      startTime: '20:00',
      endTime: '08:00',
      fromDate: '2026-11-02',
      toDate: '2026-11-15',
    };
    const preview = await call(t.app, {
      method: 'POST',
      url: '/api/v1/shifts/bulk?preview=true',
      cookie: admin,
      org: org.id,
      body,
    });
    const planned = preview.json<{
      shifts: { startsAt: string; endsAt: string; conflict: string | null }[];
      created: number;
    }>();
    expect(planned.created).toBe(0);
    expect(planned.shifts).toHaveLength(12);
    // Monday 2 Nov 20:00 in Karachi (UTC+5) is 15:00Z; it ends Tuesday 08:00 local, 03:00Z.
    expect(planned.shifts[0]).toEqual({
      startsAt: '2026-11-02T15:00:00.000Z',
      endsAt: '2026-11-03T03:00:00.000Z',
      conflict: null,
    });
    const created = await call(t.app, {
      method: 'POST',
      url: '/api/v1/shifts/bulk?preview=false',
      cookie: admin,
      org: org.id,
      body,
    });
    expect(created.json()).toMatchObject({ created: 12 });
    // Running it again conflicts everywhere and creates nothing.
    const again = await call(t.app, {
      method: 'POST',
      url: '/api/v1/shifts/bulk?preview=false',
      cookie: admin,
      org: org.id,
      body,
    });
    expect(again.json<{ created: number; shifts: { conflict: string | null }[] }>()).toMatchObject({
      created: 0,
    });
    expect(again.json<{ shifts: { conflict: string | null }[] }>().shifts.every((s) => s.conflict)).toBe(
      true,
    );
  });

  it('dispatchers see shifts but cannot create or supervise them', async () => {
    const { guardId } = await guardWithPhone();
    const id = await shiftFor(guardId, 30);
    expect(
      (await call(t.app, { method: 'GET', url: `/api/v1/shifts/${id}`, cookie: dispatcher, org: org.id }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call(t.app, {
          method: 'POST',
          url: `/api/v1/shifts/${id}/cancel`,
          cookie: dispatcher,
          org: org.id,
          body: { reason: 'x' },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('starting and ending (PROD §6.4, §6.6)', () => {
  it('the guard starts inside the window with a fresh fix; the server records its own time', async () => {
    const { guardId, phone } = await guardWithPhone();
    const id = await shiftFor(guardId, 10);
    const res = await start(phone, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: 'ACTIVE' });
    const row = await shiftRow(id);
    expect(row?.actual_started_at?.toISOString()).toBe(t.clock.now().toISOString());
    const end = await asPhone(t.app, phone, {
      method: 'POST',
      url: `/api/v1/shifts/${id}/end`,
      body: { clientEventId: randomUUID(), recordedAt: t.clock.now().toISOString(), fix: AT_SITE },
    });
    expect(end.json()).toMatchObject({ status: 'COMPLETED' });
  });

  it('ADV-SH02 a double-tapped start is one transition; the repeat returns the same result', async () => {
    const { guardId, phone } = await guardWithPhone();
    const id = await shiftFor(guardId, 5);
    const clientEventId = randomUUID();
    const [a, b] = await Promise.all([
      start(phone, id, { clientEventId }),
      start(phone, id, { clientEventId }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const { rows } = await asOwner(t.db, (c) =>
      c.query(`select 1 from shift_events where shift_id = $1 and type = 'STARTED'`, [id]),
    );
    expect(rows).toHaveLength(1);
    // A second start with a new client event ID is a different command, and refused.
    expect(errorCode(await start(phone, id))).toBe('SHIFT_INVALID_TRANSITION');
  });

  it("ADV-A03 a guard cannot start, end or see another guard's shift", async () => {
    const owner = await guardWithPhone();
    const other = await guardWithPhone();
    const id = await shiftFor(owner.guardId, 5);
    expect((await start(other.phone, id)).statusCode).toBe(404);
    expect(
      (
        await asPhone(t.app, other.phone, {
          method: 'POST',
          url: `/api/v1/shifts/${id}/end`,
          body: { clientEventId: randomUUID(), recordedAt: t.clock.now().toISOString(), fix: null },
        })
      ).statusCode,
    ).toBe(404);
    const mine = (await asPhone(t.app, other.phone, { method: 'GET', url: '/api/v1/me/shifts' })).json<{
      shifts: { id: string }[];
    }>();
    expect(mine.shifts.map((s) => s.id)).not.toContain(id);
    expect((await shiftRow(id))?.status).toBe('SCHEDULED');
  });

  it('ADV-TM03 a phone clock set to make a start look early or on time changes nothing: server time decides', async () => {
    const { guardId, phone } = await guardWithPhone();
    const id = await shiftFor(guardId, 3 * 60); // starts in 3 hours; the window opens 30 min before
    const forged = new Date(t.clock.now().getTime() + 3 * H).toISOString(); // "it's start time already"
    expect(errorCode(await start(phone, id, { recordedAt: forged }))).toBe('SHIFT_OUTSIDE_START_WINDOW');
    // Inside the window by server time, a forged phone time is kept as evidence only.
    t.clock.advance(2 * H + 45 * 60_000);
    await refreshPhone(t.app, phone); // the 15-minute access token ran out meanwhile
    expect((await start(phone, id, { recordedAt: '2020-01-01T00:00:00.000Z' })).statusCode).toBe(200);
    expect((await shiftRow(id))?.actual_started_at?.toISOString()).toBe(t.clock.now().toISOString());
  });

  it('PROD §6.4: no fresh fix, or permission short of "always", blocks the start; off-site is allowed and flagged', async () => {
    const { guardId, phone } = await guardWithPhone();
    const id = await shiftFor(guardId, 5);
    expect(errorCode(await start(phone, id, { fix: null }))).toBe('LOCATION_FIX_REQUIRED');
    expect(errorCode(await start(phone, id, { fix: { ...AT_SITE, fixAgeS: 600 } }))).toBe(
      'LOCATION_FIX_REQUIRED',
    );
    expect(
      errorCode(await start(phone, id, { permission: { location: 'WHEN_IN_USE', precise: true } })),
    ).toBe('TRACKING_PERMISSION_REQUIRED');
    // Rejected attempts are history without coordinates (INV-08).
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ payload: Record<string, unknown> }>(
        `select payload from shift_events where shift_id = $1 and type = 'START_REJECTED'`,
        [id],
      ),
    );
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toMatch(/31\.4|74\.4/);
    expect((await start(phone, id, { fix: FAR_AWAY })).statusCode).toBe(200);
    expect((await shiftRow(id))?.start_flags).toContain('OFF_SITE_START');
  });

  it('ADV-SH06 an offline start captured in the window, synced after the shift was marked MISSED, makes it ACTIVE', async () => {
    const { guardId, phone } = await guardWithPhone();
    const id = await shiftFor(guardId, 0);
    const capturedAt = new Date(t.clock.now().getTime() + 30 * 60_000);
    t.clock.advance(2 * H + 60_000); // past the start deadline
    await runShiftDetectors({ ...t.deps, sweep: createKysely(sweepPool) });
    expect((await shiftRow(id))?.status).toBe('MISSED');
    const outcome = await withTenantTransaction(t.deps.db, org.id, (trx) =>
      guardStart(
        trx,
        t.deps,
        { organizationId: org.id, guardId, deviceId: phone.deviceId, userId: null },
        {
          shiftId: id,
          clientEventId: randomUUID(),
          recordedAt: capturedAt,
          capturedAt,
          offline: true,
          fix: AT_SITE,
          permission: ALWAYS,
        },
      ),
    );
    expect(outcome.status).toBe('ACCEPTED');
    const row = await shiftRow(id);
    expect(row?.status).toBe('ACTIVE');
    expect(row?.start_flags).toEqual(expect.arrayContaining(['LATE_SYNC', 'OFFLINE_START']));
    expect(row?.actual_started_at?.toISOString()).toBe(capturedAt.toISOString());
  });
});

describe('detectors (ARCH §16.2)', () => {
  it('ADV-SH04 a shift nobody ended is auto-ended at end + auto_end_after; an unstarted one becomes MISSED', async () => {
    const a = await guardWithPhone();
    const b = await guardWithPhone();
    const active = await shiftFor(a.guardId, 5, 2);
    expect((await start(a.phone, active)).statusCode).toBe(200);
    const unstarted = await shiftFor(b.guardId, 5, 4);
    const sweep = { ...t.deps, sweep: createKysely(sweepPool) };
    t.clock.advance(2 * H + 5 * 60_000 + 59 * 60_000); // end + 59 min: not yet
    await runShiftDetectors(sweep);
    expect((await shiftRow(active))?.status).toBe('ACTIVE');
    expect((await shiftRow(unstarted))?.status).toBe('MISSED');
    t.clock.advance(2 * 60_000);
    await runShiftDetectors(sweep);
    expect(await shiftRow(active)).toMatchObject({ status: 'COMPLETED', end_reason: 'AUTO_TIMEOUT' });
  });

  it("ADV-T07 a detector job running for organization A cannot touch B's shifts", async () => {
    const other = await seedOrganization(t.db, 'Other Co', [
      { email: 'admin@other-shift.test', role: 'ADMIN' },
    ]);
    const bGuard = randomUUID();
    const bSite = randomUUID();
    const bShift = randomUUID();
    await asOwner(t.db, async (c) => {
      await c.query(
        `insert into guards (id, organization_id, employee_number, display_name, phone) values ($1, $2, 'B', 'B', '+923119990000')`,
        [bGuard, other.id],
      );
      await c.query(
        `insert into sites (id, organization_id, name, timezone, boundary_kind, latitude, longitude, geofence_radius_meters) values ($1, $2, 'B', 'Asia/Karachi', 'CIRCLE', 31, 74, 100)`,
        [bSite, other.id],
      );
      await c.query(
        `insert into shifts (id, organization_id, guard_id, site_id, starts_at, ends_at, start_deadline_at)
         values ($1, $2, $3, $4, now() - interval '10 hours', now() - interval '6 hours', now() - interval '8 hours')`,
        [bShift, other.id, bGuard, bSite],
      );
    });
    const changed = await applyForOrganization(t.deps, org.id, [
      { id: bShift, organization_id: other.id, kind: 'MARK_MISSED' },
    ]);
    expect(changed).toBe(0);
    expect((await shiftRow(bShift))?.status).toBe('SCHEDULED');
  });

  it("ADV-SH05 the phone's own failsafe deadline (end + auto_end_after) comes from the server", async () => {
    const { guardId, phone } = await guardWithPhone();
    const id = await shiftFor(guardId, 5);
    const mine = (await asPhone(t.app, phone, { method: 'GET', url: '/api/v1/me/shifts' })).json<{
      shifts: { id: string; endsAt: string }[];
    }>();
    const config = (await asPhone(t.app, phone, { method: 'GET', url: '/api/v1/mobile/config' })).json<{
      shift: { autoEndAfterMinutes: number };
    }>();
    const shift = mine.shifts.find((s) => s.id === id);
    expect(shift).toBeDefined();
    expect(config.shift.autoEndAfterMinutes).toBe(60);
    // The phone stops tracking at this instant without any server contact; the server ends the
    // shift at the same instant (ADV-SH04). The phone side is tested in apps/mobile.
    const deadline = new Date(
      new Date(shift?.endsAt ?? 0).getTime() + config.shift.autoEndAfterMinutes * 60_000,
    );
    expect(deadline.getTime() - new Date(shift?.endsAt ?? 0).getTime()).toBe(H);
  });
});

describe('supervisor actions (PROD §6.3)', () => {
  it('manual start, extend and force-end each need a reason and are audited', async () => {
    const { guardId } = await guardWithPhone();
    const id = await shiftFor(guardId, 5);
    const act = (path: string, body: Record<string, unknown>) =>
      call(t.app, {
        method: 'POST',
        url: `/api/v1/shifts/${id}/${path}`,
        cookie: supervisor,
        org: org.id,
        body,
      });
    expect(errorCode(await act('manual-start', { reason: '' }))).toBe('VALIDATION_FAILED');
    expect((await act('manual-start', { reason: 'phone broken' })).json()).toMatchObject({
      status: 'ACTIVE',
      startSource: 'SUPERVISOR_MANUAL',
    });
    const later = new Date(t.clock.now().getTime() + 10 * H).toISOString();
    expect((await act('extend', { endsAt: later })).json()).toMatchObject({ endsAt: later });
    expect((await act('force-end', { reason: 'relief arrived' })).json()).toMatchObject({
      status: 'COMPLETED',
      endReason: 'SUPERVISOR_FORCE_END',
    });
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ action: string; reason: string | null }>(
        `select action, reason from audit_logs where resource_id = $1 order by created_at`,
        [id],
      ),
    );
    expect(rows.map((r) => r.action)).toEqual([
      'SHIFT_CREATED',
      'SHIFT_MANUAL_START',
      'SHIFT_EXTENDED',
      'SHIFT_FORCE_ENDED',
    ]);
    expect(rows.find((r) => r.action === 'SHIFT_FORCE_ENDED')?.reason).toBe('relief arrived');
  });

  it('disabling a guard during a shift force-ends it with the reason recorded (SEC §5)', async () => {
    const { guardId, phone } = await guardWithPhone();
    const id = await shiftFor(guardId, 5);
    expect((await start(phone, id)).statusCode).toBe(200);
    const g = (
      await call(t.app, { method: 'GET', url: `/api/v1/guards/${guardId}`, cookie: admin, org: org.id })
    ).json<{ version: number }>();
    expect(
      (
        await call(t.app, {
          method: 'PATCH',
          url: `/api/v1/guards/${guardId}`,
          cookie: admin,
          org: org.id,
          body: { status: 'SUSPENDED', version: g.version },
        })
      ).statusCode,
    ).toBe(200);
    expect(await shiftRow(id)).toMatchObject({ status: 'COMPLETED', end_reason: 'GUARD_DISABLED' });
  });
});
