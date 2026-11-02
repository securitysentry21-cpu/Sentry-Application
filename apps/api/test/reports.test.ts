// Reports (PROD §6.8, §15.1): figures per shift, round, incident and site; local dates in the site's
// zone (ADV-TM02); the 92-day limit; tenant scope (ADV-T03); the location report's audit and reason.
// Their CSVs are exports (exports.test.ts).
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  seedAlert,
  seedIncident,
  seedPlace,
  seedPoints,
  seedRun,
  seedShift,
  type Seeded,
} from './seed-records.ts';
import { asOwner, call, errorCode, seedOrganization, signIn, startTestApp, type TestApp } from './support.ts';

let t: TestApp;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let other: Awaited<ReturnType<typeof seedOrganization>>;
let admin: string;
let dispatcher: string;
let siteId: string;
let guardId: string;

const H = 3_600_000;

async function insertShift(input: {
  organizationId: string;
  guard: string;
  site: string;
  startsAt: string;
  hours: number;
  status: string;
  startedAt?: string;
  endedAt?: string;
  startSource?: string;
  endReason?: string;
}) {
  const id = randomUUID();
  const starts = new Date(input.startsAt);
  await asOwner(t.db, (c) =>
    c.query(
      `insert into shifts (id, organization_id, guard_id, site_id, starts_at, ends_at, start_deadline_at, status,
         actual_started_at, actual_ended_at, start_source, end_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        input.organizationId,
        input.guard,
        input.site,
        starts,
        new Date(starts.getTime() + input.hours * H),
        new Date(starts.getTime() + 2 * H),
        input.status,
        input.startedAt ?? null,
        input.endedAt ?? null,
        input.startSource ?? null,
        input.endReason ?? null,
      ],
    ),
  );
  return id;
}

async function seedGuardAndSite(organizationId: string, suffix: string) {
  const guard = randomUUID();
  const site = randomUUID();
  await asOwner(t.db, async (c) => {
    await c.query(
      `insert into guards (id, organization_id, employee_number, display_name, phone) values ($1, $2, $3, $4, $5)`,
      [
        guard,
        organizationId,
        `R-${suffix}`,
        suffix === 'a' ? '=HYPERLINK("x")' : 'Other guard',
        `+9230055500${suffix === 'a' ? '1' : '2'}`,
      ],
    );
    await c.query(
      `insert into sites (id, organization_id, name, timezone, boundary_kind, latitude, longitude, geofence_radius_meters)
       values ($1, $2, $3, 'Asia/Karachi', 'CIRCLE', 31.5, 74.3, 100)`,
      [site, organizationId, `Site ${suffix}`],
    );
  });
  return { guard, site };
}

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'Report Co', [
    { email: 'admin@report.test', role: 'ADMIN' },
    { email: 'disp@report.test', role: 'DISPATCHER' },
  ]);
  other = await seedOrganization(t.db, 'Other Report Co', [
    { email: 'admin@other-report.test', role: 'ADMIN' },
  ]);
  admin = await signIn(t.app, 'admin@report.test');
  dispatcher = await signIn(t.app, 'disp@report.test');
  const a = await seedGuardAndSite(org.id, 'a');
  guardId = a.guard;
  siteId = a.site;
  // 20:00–04:00 Karachi on 2026-10-05 (15:00Z), started 12 min late, ended 30 min early.
  await insertShift({
    organizationId: org.id,
    guard: guardId,
    site: siteId,
    startsAt: '2026-10-05T15:00:00Z',
    hours: 8,
    status: 'COMPLETED',
    startedAt: '2026-10-05T15:12:00Z',
    endedAt: '2026-10-05T22:30:00Z',
    startSource: 'APP_OFFLINE_SYNCED',
    endReason: 'GUARD',
  });
  // Missed, the next local day (20:00–00:00).
  await insertShift({
    organizationId: org.id,
    guard: guardId,
    site: siteId,
    startsAt: '2026-10-06T15:00:00Z',
    hours: 4,
    status: 'MISSED',
  });
  // 2026-10-07 00:30 Karachi is still 2026-10-06 in UTC (19:30Z): it belongs to the 7th.
  await insertShift({
    organizationId: org.id,
    guard: guardId,
    site: siteId,
    startsAt: '2026-10-06T19:30:00Z',
    hours: 4,
    status: 'SCHEDULED',
  });
  const b = await seedGuardAndSite(other.id, 'b');
  await insertShift({
    organizationId: other.id,
    guard: b.guard,
    site: b.site,
    startsAt: '2026-10-05T15:00:00Z',
    hours: 8,
    status: 'SCHEDULED',
  });
});

afterAll(async () => {
  await t?.close();
});

type Report = {
  timezone: string;
  rows: {
    status: string;
    lateMinutes: number | null;
    earlyLeaveMinutes: number | null;
    workedMinutes: number | null;
    flags: string[];
    site: { id: string };
  }[];
  truncated: boolean;
};

describe('attendance report (PROD §6.8)', () => {
  it('computes late, early leave and worked minutes, with flags, by local date', async () => {
    const res = await call(t.app, {
      method: 'GET',
      url: '/api/v1/reports/attendance?from=2026-10-05&to=2026-10-05',
      cookie: admin,
      org: org.id,
    });
    expect(res.statusCode).toBe(200);
    const report = res.json<Report>();
    expect(report.timezone).toBe('Asia/Karachi');
    expect(report.rows).toEqual([
      expect.objectContaining({
        status: 'COMPLETED',
        lateMinutes: 12,
        earlyLeaveMinutes: 30,
        workedMinutes: 438,
        flags: ['OFFLINE_START'],
      }),
    ]);
    const week = await call(t.app, {
      method: 'GET',
      url: `/api/v1/reports/attendance?from=2026-10-05&to=2026-10-07&siteId=${siteId}`,
      cookie: admin,
      org: org.id,
    });
    expect(week.json<Report>().rows.map((r) => r.status)).toEqual(['COMPLETED', 'MISSED', 'SCHEDULED']);
    const seventh = await call(t.app, {
      method: 'GET',
      url: '/api/v1/reports/attendance?from=2026-10-07&to=2026-10-07',
      cookie: admin,
      org: org.id,
    });
    expect(seventh.json<Report>().rows.map((r) => r.status)).toEqual(['SCHEDULED']);
  });

  it("never includes another organization's shifts, and another organization's site is not found", async () => {
    const res = await call(t.app, {
      method: 'GET',
      url: '/api/v1/reports/attendance?from=2026-10-01&to=2026-10-31',
      cookie: admin,
      org: org.id,
    });
    for (const row of res.json<Report>().rows) expect(row.site.id).toBe(siteId);
    const foreignSite = (
      await asOwner(t.db, (c) =>
        c.query<{ id: string }>('select id from sites where organization_id = $1', [other.id]),
      )
    ).rows[0]?.id;
    const foreign = await call(t.app, {
      method: 'GET',
      url: `/api/v1/reports/attendance?from=2026-10-01&to=2026-10-31&siteId=${foreignSite}`,
      cookie: admin,
      org: org.id,
    });
    expect(errorCode(foreign)).toBe('NOT_FOUND');
  });

  it('refuses more than 92 days, and dispatchers, who have no reports permission', async () => {
    const long = await call(t.app, {
      method: 'GET',
      url: '/api/v1/reports/attendance?from=2026-01-01&to=2026-04-03',
      cookie: admin,
      org: org.id,
    });
    expect(errorCode(long)).toBe('EXPORT_RANGE_TOO_LARGE');
    // Impossible dates can't slip past the limit by rolling into later months.
    for (const to of ['2026-13-45', '2026-02-30', '2026-04-31']) {
      const bad = await call(t.app, {
        method: 'GET',
        url: `/api/v1/reports/attendance?from=2026-01-01&to=${to}`,
        cookie: admin,
        org: org.id,
      });
      expect(errorCode(bad), to).toBe('VALIDATION_FAILED');
    }
    const backwards = await call(t.app, {
      method: 'GET',
      url: '/api/v1/reports/attendance?from=2026-10-07&to=2026-10-05',
      cookie: admin,
      org: org.id,
    });
    expect(errorCode(backwards)).toBe('VALIDATION_FAILED');
    const disp = await call(t.app, {
      method: 'GET',
      url: '/api/v1/reports/attendance?from=2026-10-05&to=2026-10-05',
      cookie: dispatcher,
      org: org.id,
    });
    expect(errorCode(disp)).toBe('FORBIDDEN');
  });
});

// ── Phase 9 ─────────────────────────────────────────────────────────────────────────────────

describe('patrol, incident, location and site activity reports (PROD §15.1)', () => {
  let p: Seeded;
  let foreign: Seeded;
  let shift: string;
  const get = (url: string, cookie = admin) => call(t.app, { method: 'GET', url, cookie, org: org.id });

  beforeAll(async () => {
    p = await seedPlace(t, org.id, { site: 'Gate', guardName: 'Ali Raza', employeeNumber: 'E-7' });
    foreign = await seedPlace(t, other.id, { site: 'Their gate', guardName: 'Their guard' });
    // 09:00–10:00 Karachi on 2026-10-03, worked in full.
    shift = await seedShift(t, p, {
      start: new Date('2026-10-03T04:00:00Z'),
      hours: 1,
      status: 'COMPLETED',
      startedAt: new Date('2026-10-03T04:00:00Z'),
      endedAt: new Date('2026-10-03T05:00:00Z'),
    });
    const at = (min: number) => new Date(Date.parse('2026-10-03T04:00:00Z') + min * 60_000);
    const fixes: { at: Date; northM: number }[] = [];
    for (let m = 0; m <= 10; m += 2) fixes.push({ at: at(m), northM: 10 });
    for (let m = 12; m <= 30; m += 2) fixes.push({ at: at(m), northM: 800 });
    for (let m = 32; m <= 40; m += 2) fixes.push({ at: at(m), northM: 10 });
    await seedPoints(t, p, { shiftId: shift }, fixes);
    await seedRun(t, p, {
      shiftId: shift,
      dueAt: at(5),
      status: 'INCOMPLETE',
      required: 4,
      counted: 3,
      unconfirmed: 1,
    });
    // Reported at 09:20, acknowledged 3 minutes later, resolved after 45.
    await seedIncident(t, p, {
      shiftId: shift,
      occurredAt: at(20),
      status: 'RESOLVED',
      acknowledgedAt: at(23),
      resolvedAt: at(65),
      severity: 'CRITICAL',
    });
    await seedIncident(t, p, { shiftId: shift, occurredAt: at(25), isDrill: true, severity: 'LOW' });
    await seedAlert(t, p, { shiftId: shift, openedAt: at(20) });
  });

  it('ADV-TM02 every report counts by the local date in the site zone, not UTC', async () => {
    // 2026-10-03 00:30 Karachi is still 2 October in UTC (19:30Z): it belongs to the 3rd.
    const late = await seedShift(t, p, {
      start: new Date('2026-10-02T19:30:00Z'),
      hours: 4,
      status: 'MISSED',
    });
    const third = await get(`/api/v1/reports/attendance?from=2026-10-03&to=2026-10-03&siteId=${p.site}`);
    expect(third.json<{ rows: { shiftId: string }[] }>().rows.map((r) => r.shiftId)).toContain(late);
    const second = await get(`/api/v1/reports/attendance?from=2026-10-02&to=2026-10-02&siteId=${p.site}`);
    expect(second.json<{ rows: { shiftId: string }[] }>().rows.map((r) => r.shiftId)).not.toContain(late);
    const activity = await get(
      `/api/v1/reports/site-activity?from=2026-10-02&to=2026-10-04&siteId=${p.site}`,
    );
    const days = activity.json<{ rows: { date: string; shiftsScheduled: number; shiftsMissed: number }[] }>()
      .rows;
    expect(days).toEqual([
      expect.objectContaining({ date: '2026-10-03', shiftsScheduled: 2, shiftsMissed: 1 }),
    ]);
  });

  it("ADV-T03 every report refuses another organization's site or guard, and never lists its rows", async () => {
    for (const path of ['attendance', 'patrols', 'incidents', 'locations', 'site-activity']) {
      for (const filter of [`siteId=${foreign.site}`, `guardId=${foreign.guard}`]) {
        const res = await get(`/api/v1/reports/${path}?from=2026-10-01&to=2026-10-07&${filter}`);
        expect(errorCode(res), `${path} ${filter}`).toBe('NOT_FOUND');
      }
      const all = await get(`/api/v1/reports/${path}?from=2026-10-01&to=2026-10-07`);
      expect(all.statusCode, path).toBe(200);
      expect(all.body, path).not.toContain('Their guard');
      expect(all.body, path).not.toContain('Their gate');
    }
  });

  it('patrols: required, missed and completion of each closed round', async () => {
    const res = await get(`/api/v1/reports/patrols?from=2026-10-03&to=2026-10-03&siteId=${p.site}`);
    expect(res.json<{ rows: unknown[] }>().rows).toEqual([
      expect.objectContaining({
        status: 'INCOMPLETE',
        required: 4,
        missed: 1,
        completionPct: 75,
        sequenceNo: 1,
      }),
    ]);
  });

  it('incidents: times to acknowledge and resolve; drills only when asked for', async () => {
    type Row = {
      severity: string;
      secondsToAcknowledge: number | null;
      secondsToResolve: number | null;
      isDrill: boolean;
    };
    const res = await get(`/api/v1/reports/incidents?from=2026-10-03&to=2026-10-03&siteId=${p.site}`);
    expect(res.json<{ rows: Row[] }>().rows).toEqual([
      expect.objectContaining({
        severity: 'CRITICAL',
        secondsToAcknowledge: 180,
        secondsToResolve: 2700,
        isDrill: false,
      }),
    ]);
    const withDrills = await get(
      `/api/v1/reports/incidents?from=2026-10-03&to=2026-10-03&siteId=${p.site}&drills=include`,
    );
    expect(withDrills.json<{ rows: Row[] }>().rows.map((r) => r.isDrill)).toEqual([false, true]);
  });

  it('location: inside, outside and unknown time, the excursion, gaps; audited first, with the reason', async () => {
    type Row = {
      insideSeconds: number;
      outsideSeconds: number;
      unknownSeconds: number;
      excursions: { seconds: number }[];
      longestGapSeconds: number;
      points: number;
      trackDeleted: boolean;
    };
    const res = await get(
      `/api/v1/reports/locations?from=2026-10-03&to=2026-10-03&siteId=${p.site}&reason=${encodeURIComponent('Client asked')}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const row = res.json<{ rows: Row[] }>().rows.find((r) => r.points > 0);
    expect(row).toMatchObject({
      outsideSeconds: 1200,
      unknownSeconds: 1200,
      insideSeconds: 1200,
      longestGapSeconds: 1200,
      points: 21,
      trackDeleted: false,
    });
    expect(row?.excursions.map((e) => e.seconds)).toEqual([1200]);
    const audit = await asOwner(t.db, (c) =>
      c.query(
        `select reason from audit_logs where organization_id = $1 and action = 'LOCATION_REPORT_VIEWED'`,
        [org.id],
      ),
    );
    expect(audit.rows).toContainEqual({ reason: 'Client asked' });
    // The organization may require the reason (D-21).
    await asOwner(t.db, (c) =>
      c.query(
        `update organization_settings set overrides = overrides || '{"privacy.require_history_access_reason": true}'
          where organization_id = $1`,
        [org.id],
      ),
    );
    try {
      const without = await get(`/api/v1/reports/locations?from=2026-10-03&to=2026-10-03&siteId=${p.site}`);
      expect(errorCode(without)).toBe('VALIDATION_FAILED');
    } finally {
      await asOwner(t.db, (c) =>
        c.query(
          `update organization_settings set overrides = overrides - 'privacy.require_history_access_reason'
            where organization_id = $1`,
          [org.id],
        ),
      );
    }
    const disp = await get('/api/v1/reports/locations?from=2026-10-03&to=2026-10-03', dispatcher);
    expect(errorCode(disp)).toBe('FORBIDDEN');
  });
});
