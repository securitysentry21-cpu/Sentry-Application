// The attendance report (PROD §6.8, §15): figures per shift, local dates, the 92-day limit, tenant
// scope, and the audited, formula-safe CSV export.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    const disp = await call(t.app, {
      method: 'GET',
      url: '/api/v1/reports/attendance?from=2026-10-05&to=2026-10-05',
      cookie: dispatcher,
      org: org.id,
    });
    expect(errorCode(disp)).toBe('FORBIDDEN');
  });

  it('the CSV export is audited, has a BOM, and neutralises formulas', async () => {
    const res = await call(t.app, {
      method: 'GET',
      url: '/api/v1/reports/attendance/export?from=2026-10-05&to=2026-10-07',
      cookie: admin,
      org: org.id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    expect(res.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(res.body).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(res.body).toContain('2026-10-05 20:12'); // local Karachi time
    const audits = await asOwner(t.db, (c) =>
      c.query(`select metadata from audit_logs where organization_id = $1 and action = 'EXPORT_REQUESTED'`, [
        org.id,
      ]),
    );
    expect(audits.rowCount).toBe(1);
  });
});
