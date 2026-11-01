// Location history (PROD §14.5, SEC §16.4) and a guard's live location (PROD §14.4): who may see
// history, the audit written before any point is read (INV-14), the reason rule (D-21), thinning
// and gaps, and range limits.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asOwner,
  asPhone,
  call,
  createGuard,
  enrollPhone,
  errorCode,
  seedOrganization,
  signIn,
  startTestApp,
  type EnrolledPhone,
  type TestApp,
} from './support.ts';

const H = 3_600_000;
const MIN = 60_000;
const CENTER = { lat: 31.47, lng: 74.4 };

let t: TestApp;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let admin: string;
let supervisor: string;
let dispatcher: string;
let siteId: string;
let guardId: string;
let phone: EnrolledPhone;
let shiftId: string;
let startedAt: Date;

type History = {
  totalPoints: number;
  points: { capturedAt: string; flags: string[]; gapBefore: boolean; lat: number }[];
  shifts: { id: string; site: { boundary: { kind: string } } }[];
  events: { type: string }[];
};

const historyUrl = (query: string, guard = guardId) => `/api/v1/guards/${guard}/location-history?${query}`;

async function auditRows(action: string) {
  const { rows } = await asOwner(t.db, (c) =>
    c.query<{ actor_user_id: string; reason: string | null; resource_id: string; metadata: unknown }>(
      `select actor_user_id, reason, resource_id, metadata from audit_logs
        where organization_id = $1 and action = $2 order by created_at, id`,
      [org.id, action],
    ),
  );
  return rows;
}

/** Points every `everyMs` from `from`, stored the way sync stores them. */
async function insertPoints(count: number, from: Date, everyMs: number, flags: string[] = []): Promise<void> {
  await asOwner(t.db, (c) =>
    c.query(
      `insert into location_points (id, organization_id, guard_id, shift_id, device_id, client_event_id, latitude,
         longitude, accuracy_m, recorded_at, captured_at, received_at, clock_status, source, flags)
       select gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), $5 + g * 0.00001, $6, 9,
              $7::timestamptz + g * ($8 || ' milliseconds')::interval,
              $7::timestamptz + g * ($8 || ' milliseconds')::interval,
              $7::timestamptz + g * ($8 || ' milliseconds')::interval,
              'VERIFIED_MONOTONIC', 'TRACKING', $9
         from generate_series(0, $10 - 1) g`,
      [org.id, guardId, shiftId, phone.deviceId, CENTER.lat, CENTER.lng, from, String(everyMs), flags, count],
    ),
  );
}

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'History Co', [
    { email: 'admin@history.test', role: 'ADMIN' },
    { email: 'sup@history.test', role: 'SUPERVISOR' },
    { email: 'disp@history.test', role: 'DISPATCHER' },
  ]);
  admin = await signIn(t.app, 'admin@history.test');
  supervisor = await signIn(t.app, 'sup@history.test');
  dispatcher = await signIn(t.app, 'disp@history.test');
  const site = await call(t.app, {
    method: 'POST',
    url: '/api/v1/sites',
    cookie: admin,
    org: org.id,
    body: { name: 'Yard', boundary: { kind: 'CIRCLE', center: CENTER, radiusM: 200 } },
  });
  siteId = site.json<{ id: string }>().id;
  guardId = await createGuard(t.app, admin, org.id, {
    employeeNumber: 'H-1',
    displayName: 'History guard',
    phone: '+923004440001',
  });
  phone = await enrollPhone(t.app, admin, org.id, guardId, '+923004440001');
  const startsAt = new Date(t.clock.now().getTime() + 5 * MIN);
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
  shiftId = created.json<{ id: string }>().id;
  const started = await asPhone(t.app, phone, {
    method: 'POST',
    url: '/api/v1/sync/batch',
    body: {
      batchId: randomUUID(),
      sentAt: t.clock.now().toISOString(),
      sentMonoMs: 1_000_000,
      bootId: 'boot-h',
      items: [
        {
          clientEventId: randomUUID(),
          type: 'SHIFT_START',
          recordedAt: t.clock.now().toISOString(),
          monoMs: 999_000,
          bootId: 'boot-h',
          shiftId,
          fix: { lat: CENTER.lat, lon: CENTER.lng, accuracyM: 8, fixAgeS: 2 },
          permission: { location: 'ALWAYS', precise: true },
        },
      ],
    },
  });
  expect(started.json<{ results: { status: string }[] }>().results[0]?.status).toBe('ACCEPTED');
  startedAt = t.clock.now();
  // The phone's first tracked fix, through sync: it becomes the live state's last fix.
  t.clock.advance(5_000);
  const tracked = await asPhone(t.app, phone, {
    method: 'POST',
    url: '/api/v1/sync/batch',
    body: {
      batchId: randomUUID(),
      sentAt: t.clock.now().toISOString(),
      sentMonoMs: 1_005_000,
      bootId: 'boot-h',
      items: [
        {
          clientEventId: randomUUID(),
          type: 'LOCATION',
          recordedAt: new Date(t.clock.now().getTime() - 1000).toISOString(),
          monoMs: 1_004_000,
          bootId: 'boot-h',
          shiftId,
          fix: { lat: CENTER.lat, lon: CENTER.lng, accuracyM: 8 },
        },
      ],
    },
  });
  expect(tracked.json<{ results: { status: string }[] }>().results[0]?.status).toBe('ACCEPTED');
  // Two hours of points every 30 s, a 20-minute hole after the first hour, and one mock location.
  await insertPoints(120, new Date(startedAt.getTime() + 10_000), 30_000);
  await insertPoints(1, new Date(startedAt.getTime() + 10_000 + 120 * 30_000 + 20 * MIN), 1, [
    'MOCK_LOCATION',
  ]);
  await insertPoints(119, new Date(startedAt.getTime() + 10_000 + 121 * 30_000 + 20 * MIN), 30_000);
  t.clock.advance(3 * H);
});

afterAll(async () => {
  await t?.close();
});

describe('who may see location history (PROD §3.2, SEC §16.4)', () => {
  it('ADV-A04 a dispatcher is refused location history', async () => {
    const res = await call(t.app, {
      method: 'GET',
      url: historyUrl(`shiftId=${shiftId}`),
      cookie: dispatcher,
      org: org.id,
    });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });
});

describe('the audit comes first (INV-14)', () => {
  it('ADV-P02 viewing history writes the audit record, with the reason, before returning data', async () => {
    const before = (await auditRows('LOCATION_HISTORY_VIEWED')).length;
    const res = await call(t.app, {
      method: 'GET',
      url: historyUrl(`shiftId=${shiftId}&reason=${encodeURIComponent('Client complaint #12')}`),
      cookie: supervisor,
      org: org.id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<History>().points.length).toBeGreaterThan(0);
    const rows = await auditRows('LOCATION_HISTORY_VIEWED');
    expect(rows.length).toBe(before + 1);
    const row = rows.at(-1)!;
    expect(row.actor_user_id).toBe(org.members['sup@history.test']!.userId);
    expect(row.resource_id).toBe(guardId);
    expect(row.reason).toBe('Client complaint #12');
    // Metadata names the range, never a coordinate (SEC §17.2).
    expect(JSON.stringify(row.metadata)).not.toMatch(/31\.4|74\.4|lat|lng/);
  });

  it('ADV-P02 if the audit record cannot be written, no point is returned', async () => {
    await asOwner(t.db, async (c) => {
      await c.query(`create function fail_history_audit() returns trigger language plpgsql as $$
        begin
          if new.action = 'LOCATION_HISTORY_VIEWED' then raise exception 'planted audit failure'; end if;
          return new;
        end $$`);
      await c.query(`create trigger fail_history_audit before insert on audit_logs
        for each row execute function fail_history_audit()`);
    });
    try {
      const res = await call(t.app, {
        method: 'GET',
        url: historyUrl(`shiftId=${shiftId}`),
        cookie: admin,
        org: org.id,
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('points');
      expect(res.body).not.toContain(String(CENTER.lat));
    } finally {
      await asOwner(t.db, async (c) => {
        await c.query('drop trigger fail_history_audit on audit_logs');
        await c.query('drop function fail_history_audit()');
      });
    }
  });

  it('D-21 asks for a reason only when the organization requires one', async () => {
    await asOwner(t.db, (c) =>
      c.query(
        `update organization_settings set overrides = overrides || '{"privacy.require_history_access_reason": true}'
          where organization_id = $1`,
        [org.id],
      ),
    );
    try {
      const before = (await auditRows('LOCATION_HISTORY_VIEWED')).length;
      const missing = await call(t.app, {
        method: 'GET',
        url: historyUrl(`shiftId=${shiftId}`),
        cookie: admin,
        org: org.id,
      });
      expect(missing.statusCode).toBe(400);
      expect(errorCode(missing)).toBe('VALIDATION_FAILED');
      const blank = await call(t.app, {
        method: 'GET',
        url: historyUrl(`shiftId=${shiftId}&reason=%20%20`),
        cookie: admin,
        org: org.id,
      });
      expect(blank.statusCode).toBe(400);
      expect((await auditRows('LOCATION_HISTORY_VIEWED')).length).toBe(before);
      const given = await call(t.app, {
        method: 'GET',
        url: historyUrl(`shiftId=${shiftId}&reason=Incident%20review`),
        cookie: admin,
        org: org.id,
      });
      expect(given.statusCode).toBe(200);
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

describe('what the viewer draws (PROD §14.5)', () => {
  it('returns the shift in capture order, marks the gap as a break, and keeps flagged points', async () => {
    const res = await call(t.app, {
      method: 'GET',
      url: historyUrl(`shiftId=${shiftId}`),
      cookie: admin,
      org: org.id,
    });
    expect(res.statusCode).toBe(200);
    const h = res.json<History>();
    // One point through sync and 240 stored ones; all fit, so none is dropped.
    expect(h.totalPoints).toBe(241);
    expect(h.points.length).toBe(241);
    const times = h.points.map((p) => p.capturedAt);
    expect([...times].sort()).toEqual(times);
    const breaks = h.points.filter((p) => p.gapBefore);
    expect(breaks.length).toBe(1);
    expect(breaks[0]!.flags).toEqual(['MOCK_LOCATION']);
    expect(h.shifts.map((s) => s.id)).toEqual([shiftId]);
    expect(h.shifts[0]!.site.boundary.kind).toBe('CIRCLE');
    expect(h.events.map((e) => e.type)).toContain('STARTED');
  });

  it('thins a long track to at most 2,000 points, keeping the first and last', async () => {
    // A dense stretch after the first track ends: 4,000 points half a second apart.
    const from = new Date(startedAt.getTime() + 2 * H + 25 * MIN);
    await insertPoints(4000, from, 500);
    const res = await call(t.app, {
      method: 'GET',
      url: historyUrl(`from=${from.toISOString()}&to=${t.clock.now().toISOString()}`),
      cookie: admin,
      org: org.id,
    });
    expect(res.statusCode).toBe(200);
    const h = res.json<History>();
    expect(h.totalPoints).toBe(4000);
    expect(h.points.length).toBe(2000);
    expect(h.points[0]!.capturedAt).toBe(from.toISOString());
    expect(h.points.at(-1)!.capturedAt).toBe(new Date(from.getTime() + 3999 * 500).toISOString());
    expect(h.points.some((p) => p.gapBefore)).toBe(false);
  });

  it('refuses ranges over 24 hours, ranges without an end, and another guard’s shift', async () => {
    const now = t.clock.now();
    const long = await call(t.app, {
      method: 'GET',
      url: historyUrl(`from=${new Date(now.getTime() - 25 * H).toISOString()}&to=${now.toISOString()}`),
      cookie: admin,
      org: org.id,
    });
    expect(long.statusCode).toBe(400);
    const open = await call(t.app, {
      method: 'GET',
      url: historyUrl(`from=${now.toISOString()}`),
      cookie: admin,
      org: org.id,
    });
    expect(open.statusCode).toBe(400);
    const other = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'H-2',
      displayName: 'Other guard',
      phone: '+923004440002',
    });
    const wrong = await call(t.app, {
      method: 'GET',
      url: historyUrl(`shiftId=${shiftId}`, other),
      cookie: admin,
      org: org.id,
    });
    expect(wrong.statusCode).toBe(404);
  });
});

describe("a guard's live location (PROD §14.4)", () => {
  it('shows the active shift with separate freshness signals, and the accepted disclosure', async () => {
    const res = await call(t.app, {
      method: 'GET',
      url: `/api/v1/guards/${guardId}/location`,
      cookie: dispatcher,
      org: org.id,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      live: { shiftId: string; trackingHealth: string; locationAge: string } | null;
      consent: { version: string } | null;
    }>();
    expect(body.live?.shiftId).toBe(shiftId);
    // Three hours of silence since the start: offline, and the position is only last known.
    expect(body.live?.trackingHealth).toBe('OFFLINE');
    expect(body.live?.locationAge).toBe('LAST_KNOWN');
  });

  it('is empty for a guard who is off duty', async () => {
    const offDuty = await createGuard(t.app, admin, org.id, {
      employeeNumber: 'H-3',
      displayName: 'Off duty',
      phone: '+923004440003',
    });
    const res = await call(t.app, {
      method: 'GET',
      url: `/api/v1/guards/${offDuty}/location`,
      cookie: admin,
      org: org.id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ live: unknown; consent: unknown }>()).toMatchObject({ live: null, consent: null });
  });
});
