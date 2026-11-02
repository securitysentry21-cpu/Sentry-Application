// Exports (PROD §15.2, SEC §8, §16.4, §16.6): queued, built by the worker, downloaded through a
// 15-minute link, deleted after 7 days. Anyone allowed to export may download the organization's
// exports (owner decision 2026-11-02), within each kind's own rule.
import { inflateRawSync } from 'node:zlib';

import { createKysely, createPool, type Pool } from '@sentryops/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runExportWork } from '../src/workers/retention.ts';
import { seedIncident, seedPlace, seedPoints, seedShift, type Seeded } from './seed-records.ts';
import { asOwner, call, errorCode, seedOrganization, signIn, startTestApp, type TestApp } from './support.ts';

let t: TestApp;
let sweepPool: Pool;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let other: Awaited<ReturnType<typeof seedOrganization>>;
let owner: string;
let admin: string;
let supervisor: string;
let dispatcher: string;
let a: Seeded;
let b: Seeded;
let shiftA: string;

const MIN = 60_000;
type Job = {
  id: string;
  status: string;
  kind: string;
  containsLocation: boolean;
  fileName: string | null;
  expiresAt: string | null;
};

const work = () => runExportWork({ ...t.deps, sweep: createKysely(sweepPool) });

async function requestExport(cookie: string, body: Record<string, unknown>) {
  return call(t.app, { method: 'POST', url: '/api/v1/exports', cookie, org: org.id, body });
}

async function exportReady(cookie: string, body: Record<string, unknown>): Promise<Job> {
  const res = await requestExport(cookie, body);
  expect(res.statusCode, res.body).toBe(202);
  const queued = res.json<{ export: Job }>().export;
  expect(queued.status).toBe('QUEUED');
  await work();
  const done = await call(t.app, { method: 'GET', url: `/api/v1/exports/${queued.id}`, cookie, org: org.id });
  const job = done.json<{ export: Job }>().export;
  expect(job.status, JSON.stringify(job)).toBe('READY');
  return job;
}

async function download(cookie: string, id: string, reason?: string): Promise<Buffer> {
  const link = await call(t.app, {
    method: 'POST',
    url: `/api/v1/exports/${id}/download`,
    cookie,
    org: org.id,
    body: reason ? { reason } : {},
  });
  expect(link.statusCode, link.body).toBe(200);
  const file = await t.app.inject({ method: 'GET', url: new URL(link.json<{ url: string }>().url).pathname });
  expect(file.statusCode).toBe(200);
  return file.rawPayload;
}

/** Cells of a CSV (RFC 4180 quoting), enough to inspect what a spreadsheet would read. */
function cells(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && csv[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return rows;
}

/** ADV-W02: no cell a spreadsheet would run as a formula. */
function expectFormulaSafe(csv: string, label: string) {
  for (const row of cells(csv.replace(/^\uFEFF/, ''))) {
    for (const cell of row) expect(/^[=+\-@\t\r]/.test(cell), `${label}: ${cell}`).toBe(false);
  }
}

/** The files of a ZIP, by name (local headers; every entry deflated). */
function unzip(archive: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let at = 0;
  while (archive.readUInt32LE(at) === 0x04034b50) {
    const size = archive.readUInt32LE(at + 18);
    const nameLength = archive.readUInt16LE(at + 26);
    const extra = archive.readUInt16LE(at + 28);
    const name = archive.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    files.set(name, inflateRawSync(archive.subarray(start, start + size)).toString('utf8'));
    at = start + size;
  }
  return files;
}

const audits = (action: string) =>
  asOwner(t.db, (c) =>
    c.query<{ reason: string | null; actor_user_id: string | null; metadata: Record<string, unknown> }>(
      `select reason, actor_user_id, metadata from audit_logs where organization_id = $1 and action = $2 order by created_at`,
      [org.id, action],
    ),
  ).then((r) => r.rows);

beforeAll(async () => {
  t = await startTestApp();
  sweepPool = createPool(t.db.urls.system_worker, { max: 2 });
  org = await seedOrganization(t.db, 'Export Co', [
    { email: 'owner@export.test', role: 'OWNER' },
    { email: 'admin@export.test', role: 'ADMIN' },
    { email: 'sup@export.test', role: 'SUPERVISOR' },
    { email: 'disp@export.test', role: 'DISPATCHER' },
  ]);
  other = await seedOrganization(t.db, 'Other Export Co', [
    { email: 'owner@other-export.test', role: 'OWNER' },
  ]);
  owner = await signIn(t.app, 'owner@export.test');
  admin = await signIn(t.app, 'admin@export.test');
  supervisor = await signIn(t.app, 'sup@export.test');
  dispatcher = await signIn(t.app, 'disp@export.test');
  // Names that a spreadsheet would run as formulas (ADV-W02).
  a = await seedPlace(t, org.id, { site: '+cmd|calc', guardName: '=HYPERLINK("x")', employeeNumber: '@E-1' });
  b = await seedPlace(t, other.id, { site: 'Their site', guardName: 'Their guard' });
  // 20:00–04:00 Karachi on 2026-10-05, started 12 minutes late.
  shiftA = await seedShift(t, a, {
    start: new Date('2026-10-05T15:00:00Z'),
    hours: 8,
    status: 'COMPLETED',
    startedAt: new Date('2026-10-05T15:12:00Z'),
    endedAt: new Date('2026-10-05T22:30:00Z'),
  });
  await seedPoints(t, a, { shiftId: shiftA }, [
    { at: new Date('2026-10-05T15:20:00Z') },
    { at: new Date('2026-10-05T15:22:00Z'), northM: 20 },
  ]);
  await seedIncident(t, a, {
    shiftId: shiftA,
    occurredAt: new Date('2026-10-05T16:00:00Z'),
    title: '@SUM(A1:A9)',
  });
  const shiftB = await seedShift(t, b, {
    start: new Date('2026-10-05T15:00:00Z'),
    hours: 8,
    status: 'COMPLETED',
    startedAt: new Date('2026-10-05T15:00:00Z'),
    endedAt: new Date('2026-10-05T23:00:00Z'),
  });
  await seedPoints(t, b, { shiftId: shiftB }, [{ at: new Date('2026-10-05T15:30:00Z') }]);
});

afterAll(async () => {
  await sweepPool?.end();
  await t?.close();
});

describe('building and downloading an export (PROD §15.2)', () => {
  it('the attendance CSV: built in the background, audited, UTF-8 with a BOM, local times, formula-safe', async () => {
    const job = await exportReady(admin, { kind: 'ATTENDANCE', from: '2026-10-05', to: '2026-10-07' });
    expect(job.fileName).toBe('attendance-2026-10-05-to-2026-10-07.csv');
    const csv = (await download(admin, job.id)).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('2026-10-05 20:12'); // local Karachi time
    expectFormulaSafe(csv, 'attendance');
    expect((await audits('EXPORT_REQUESTED')).length).toBeGreaterThanOrEqual(1);
    expect((await audits('EXPORT_DOWNLOADED')).length).toBeGreaterThanOrEqual(1);
  });

  it('ADV-W02 every kind of export neutralises formulas in names, titles and notes', async () => {
    const range = { from: '2026-10-05', to: '2026-10-07' };
    for (const body of [
      { kind: 'PATROLS', ...range },
      { kind: 'INCIDENTS', ...range },
      { kind: 'SITE_ACTIVITY', ...range },
      { kind: 'LOCATION_REPORT', ...range, reason: 'Audit' },
      { kind: 'LOCATION_HISTORY', guardId: a.guard, shiftId: shiftA, reason: 'Audit' },
    ]) {
      const job = await exportReady(owner, body);
      const csv = (await download(owner, job.id, 'Audit')).toString('utf8');
      expect(csv.charCodeAt(0), body.kind).toBe(0xfeff);
      expectFormulaSafe(csv, body.kind);
    }
    const zipped = await exportReady(owner, {
      kind: 'GUARD_DATA',
      guardId: a.guard,
      reason: 'Request from the guard',
    });
    for (const [name, csv] of unzip(await download(owner, zipped.id, 'Request from the guard'))) {
      expectFormulaSafe(csv, `GUARD_DATA/${name}`);
    }
  });

  it("ADV-T03 an export naming another organization's site, guard or shift is refused, and an export holds none of its data", async () => {
    const range = { from: '2026-10-05', to: '2026-10-07' };
    const before = (
      await asOwner(t.db, (c) =>
        c.query<{ n: number }>('select count(*)::int as n from export_jobs where organization_id = $1', [
          org.id,
        ]),
      )
    ).rows[0];
    for (const body of [
      { kind: 'ATTENDANCE', ...range, siteId: b.site },
      { kind: 'PATROLS', ...range, guardId: b.guard },
      { kind: 'INCIDENTS', ...range, siteId: b.site },
      { kind: 'SITE_ACTIVITY', ...range, guardId: b.guard },
      { kind: 'LOCATION_REPORT', ...range, siteId: b.site },
      { kind: 'LOCATION_HISTORY', guardId: b.guard, ...range },
      {
        kind: 'LOCATION_HISTORY',
        guardId: a.guard,
        shiftId: (
          await asOwner(t.db, (c) =>
            c.query<{ id: string }>('select id from shifts where organization_id = $1 limit 1', [other.id]),
          )
        ).rows[0]?.id,
      },
      { kind: 'GUARD_DATA', guardId: b.guard },
    ]) {
      const res = await requestExport(owner, body);
      expect(errorCode(res), JSON.stringify(body)).toBe('NOT_FOUND');
    }
    const after = (
      await asOwner(t.db, (c) =>
        c.query<{ n: number }>('select count(*)::int as n from export_jobs where organization_id = $1', [
          org.id,
        ]),
      )
    ).rows[0];
    expect(after).toEqual(before);
    // The organization's own export of the same days holds nothing of the other's.
    const job = await exportReady(owner, { kind: 'LOCATION_REPORT', ...range, reason: 'Audit' });
    const csv = (await download(owner, job.id, 'Audit')).toString('utf8');
    expect(csv).not.toContain('Their guard');
    expect(csv).not.toContain('Their site');
  });
});

describe('who may export and download what', () => {
  it('one export at a time per person; someone else can still queue theirs', async () => {
    const first = await requestExport(supervisor, {
      kind: 'ATTENDANCE',
      from: '2026-10-01',
      to: '2026-10-07',
    });
    expect(first.statusCode).toBe(202);
    const second = await requestExport(supervisor, {
      kind: 'INCIDENTS',
      from: '2026-10-01',
      to: '2026-10-07',
    });
    expect(errorCode(second)).toBe('EXPORT_ALREADY_RUNNING');
    const theirs = await requestExport(admin, { kind: 'INCIDENTS', from: '2026-10-01', to: '2026-10-07' });
    expect(theirs.statusCode).toBe(202);
    await work();
    const again = await requestExport(supervisor, {
      kind: 'INCIDENTS',
      from: '2026-10-01',
      to: '2026-10-07',
    });
    expect(again.statusCode).toBe(202);
    await work();
  });

  it("anyone allowed to export downloads the organization's exports; a guard's data stays with owners and administrators", async () => {
    const attendance = await exportReady(admin, { kind: 'ATTENDANCE', from: '2026-10-05', to: '2026-10-05' });
    const guardData = await exportReady(admin, {
      kind: 'GUARD_DATA',
      guardId: a.guard,
      reason: 'Request from the guard',
    });
    const listed = await call(t.app, {
      method: 'GET',
      url: '/api/v1/exports',
      cookie: supervisor,
      org: org.id,
    });
    const ids = listed.json<{ exports: { id: string }[] }>().exports.map((e) => e.id);
    expect(ids).toContain(attendance.id);
    expect(ids).not.toContain(guardData.id);
    await download(supervisor, attendance.id);
    const supUser = org.members['sup@export.test']?.userId;
    expect((await audits('EXPORT_DOWNLOADED')).some((r) => r.actor_user_id === supUser)).toBe(true);
    for (const res of [
      await call(t.app, {
        method: 'GET',
        url: `/api/v1/exports/${guardData.id}`,
        cookie: supervisor,
        org: org.id,
      }),
      await call(t.app, {
        method: 'POST',
        url: `/api/v1/exports/${guardData.id}/download`,
        cookie: supervisor,
        org: org.id,
        body: {},
      }),
      await requestExport(supervisor, { kind: 'GUARD_DATA', guardId: a.guard }),
    ]) {
      expect([403, 404]).toContain(res.statusCode);
    }
    const dispList = await call(t.app, {
      method: 'GET',
      url: '/api/v1/exports',
      cookie: dispatcher,
      org: org.id,
    });
    expect(errorCode(dispList)).toBe('FORBIDDEN');
  });

  it('a location export is location-history access: audited with the reason, asked for again at download when required', async () => {
    await asOwner(t.db, (c) =>
      c.query(
        `update organization_settings set overrides = overrides || '{"privacy.require_history_access_reason": true}'
          where organization_id = $1`,
        [org.id],
      ),
    );
    try {
      const without = await requestExport(owner, {
        kind: 'LOCATION_HISTORY',
        guardId: a.guard,
        shiftId: shiftA,
      });
      expect(errorCode(without)).toBe('VALIDATION_FAILED');
      const job = await exportReady(owner, {
        kind: 'LOCATION_HISTORY',
        guardId: a.guard,
        shiftId: shiftA,
        reason: 'Client complaint 17',
      });
      expect(job.containsLocation).toBe(true);
      // Rows written at the same instant of the test clock: found by their reason, not their order.
      const exported = await audits('LOCATION_HISTORY_EXPORTED');
      expect(exported.some((r) => r.reason === 'Client complaint 17')).toBe(true);
      const noReason = await call(t.app, {
        method: 'POST',
        url: `/api/v1/exports/${job.id}/download`,
        cookie: owner,
        org: org.id,
        body: {},
      });
      expect(errorCode(noReason)).toBe('VALIDATION_FAILED');
      const csv = (await download(owner, job.id, 'Client complaint 17')).toString('utf8');
      // The guard's own points, with coordinates, in the organization's local time.
      expect(csv).toContain('31.47');
      expect(csv).toContain('2026-10-05 20:20');
      expect((await audits('EXPORT_DOWNLOADED')).some((r) => r.reason === 'Client complaint 17')).toBe(true);
    } finally {
      await asOwner(t.db, (c) =>
        c.query(
          `update organization_settings set overrides = overrides - 'privacy.require_history_access_reason'
            where organization_id = $1`,
          [org.id],
        ),
      );
    }
  });
});

describe('links and files expire (PROD §15.2)', () => {
  it('a download link lasts 15 minutes; the file is deleted after 7 days and then the export says so', async () => {
    const job = await exportReady(owner, { kind: 'ATTENDANCE', from: '2026-10-05', to: '2026-10-06' });
    const link = await call(t.app, {
      method: 'POST',
      url: `/api/v1/exports/${job.id}/download`,
      cookie: owner,
      org: org.id,
      body: {},
    });
    const { url, expiresAt } = link.json<{ url: string; expiresAt: string }>();
    expect(Date.parse(expiresAt) - t.clock.now().getTime()).toBe(15 * MIN);
    t.clock.advance(15 * MIN + 1000);
    expect((await t.app.inject({ method: 'GET', url: new URL(url).pathname })).statusCode).toBe(404);
    t.clock.advance(7 * 24 * 60 * MIN);
    // A week on, the dashboard sessions have run out as well: sign in again.
    owner = await signIn(t.app, 'owner@export.test');
    admin = await signIn(t.app, 'admin@export.test');
    supervisor = await signIn(t.app, 'sup@export.test');
    await work();
    const expired = await call(t.app, {
      method: 'GET',
      url: `/api/v1/exports/${job.id}`,
      cookie: owner,
      org: org.id,
    });
    expect(expired.json<{ export: Job }>().export.status).toBe('EXPIRED');
    const late = await call(t.app, {
      method: 'POST',
      url: `/api/v1/exports/${job.id}/download`,
      cookie: owner,
      org: org.id,
      body: {},
    });
    expect(errorCode(late)).toBe('EXPORT_EXPIRED');
    expect(await t.deps.objects.size(`exports/${org.id}/${job.id}.csv`)).toBeNull();
  });
});

describe("a guard's data (SEC §16.6)", () => {
  it('one ZIP with their profile, shifts, location and the incidents they reported', async () => {
    const job = await exportReady(admin, {
      kind: 'GUARD_DATA',
      guardId: a.guard,
      reason: 'Request from the guard',
    });
    expect(job.fileName).toMatch(/^guard-data-E-1-\d{4}-\d{2}-\d{2}\.zip$/);
    const files = unzip(await download(admin, job.id, 'Request from the guard'));
    expect([...files.keys()]).toEqual(['profile.csv', 'shifts.csv', 'location.csv', 'incidents.csv']);
    expect(files.get('profile.csv')).toContain(`"'=HYPERLINK(""x"")"`);
    expect(cells(files.get('location.csv') ?? '').length).toBe(3); // header and 2 points
    expect(files.get('incidents.csv')).toContain(`"'@SUM(A1:A9)"`);
    expect(files.get('shifts.csv')).toContain('2026-10-05 20:00');
  });
});
