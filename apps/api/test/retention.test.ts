// Retention (SEC §16.5, PROD Appendix B): the daily run as retention_worker, on a fake clock, against
// records of every age. Owner decisions 2026-11-02: operational records go 12 months after they
// closed and never while open; positions on records go with the location period, except evidence.
import { randomUUID } from 'node:crypto';

import { createKysely, createPool, type Pool } from '@sentryops/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { retentionIsDue, runRetention } from '../src/services/retention.ts';
import {
  rowCount,
  seedAlert,
  seedIncident,
  seedPlace,
  seedPoints,
  seedShift,
  seedSos,
  type Seeded,
} from './seed-records.ts';
import { asOwner, seedOrganization, startTestApp, type TestApp } from './support.ts';

let t: TestApp;
let retentionPool: Pool;
let p: Seeded;
let neighbour: Seeded;

const DAY = 86_400_000;
const MIN = 60_000;
// The test clock's "now" is 2026-10-08T19:57Z; location keeps 90 days, records 12 months.
const daysAgo = (d: number, plusMin = 0) => new Date(t.clock.now().getTime() - d * DAY + plusMin * MIN);
const retention = () => ({ retention: createKysely(retentionPool), objects: t.deps.objects, clock: t.clock });

async function seedDeviceStatus(at: Date): Promise<string> {
  const id = randomUUID();
  await asOwner(t.db, (c) =>
    c.query(
      `insert into device_status_events (id, organization_id, guard_id, device_id, client_event_id, recorded_at,
         received_at, location_permission, precise_location, location_services_enabled, tracking_service_state)
       values ($1, $2, $3, $4, $5, $6, $6, 'ALWAYS', true, true, 'RUNNING')`,
      [id, p.org, p.guard, p.device, randomUUID(), at],
    ),
  );
  return id;
}

async function seedAudit(at: Date): Promise<string> {
  const id = randomUUID();
  await asOwner(t.db, (c) =>
    c.query(
      `insert into audit_logs (id, organization_id, actor_type, action, resource_type, created_at)
       values ($1, $2, 'SYSTEM', 'SETTINGS_CHANGED', 'organization', $3)`,
      [id, p.org, at],
    ),
  );
  return id;
}

async function seedVisit(shiftId: string, at: Date): Promise<string> {
  const id = randomUUID();
  await asOwner(t.db, (c) =>
    c.query(
      `insert into checkpoint_visits (id, organization_id, guard_id, shift_id, device_id, client_event_id,
         scanned_at_recorded, scanned_at, received_at, clock_status, latitude, longitude, accuracy_m, distance_m,
         verification_status, counted)
       values ($1, $2, $3, $4, $5, $6, $7, $7, $7, 'VERIFIED_MONOTONIC', 31.47, 74.4, 8, 5, 'INVALID_QR', false)`,
      [id, p.org, p.guard, shiftId, p.device, randomUUID(), at],
    ),
  );
  return id;
}

async function seedPhoto(incidentId: string): Promise<{ original: string; view: string }> {
  const keys = {
    original: `org/${p.org}/incidents/${incidentId}/${randomUUID()}/original`,
    view: `org/${p.org}/incidents/${incidentId}/${randomUUID()}/view.jpg`,
  };
  await t.deps.objects.write(keys.original, Buffer.from('original'), 'image/jpeg');
  await t.deps.objects.write(keys.view, Buffer.from('view'), 'image/jpeg');
  await asOwner(t.db, (c) =>
    c.query(
      `insert into incident_attachments (id, organization_id, incident_id, client_event_id, capture_source,
         declared_type, declared_size, original_key, view_key, upload_expires_at, status, completed_at)
       values ($1, $2, $3, $4, 'IN_APP_CAMERA', 'image/jpeg', 8, $5, $6, now(), 'AVAILABLE', now())`,
      [randomUUID(), p.org, incidentId, randomUUID(), keys.original, keys.view],
    ),
  );
  return keys;
}

const exists = (table: string, id: string) => rowCount(t, `select 1 from ${table} where id = $1`, [id]);

beforeAll(async () => {
  t = await startTestApp();
  retentionPool = createPool(t.db.urls.retention_worker, { max: 2 });
  const org = await seedOrganization(t.db, 'Retention Co', [
    { email: 'owner@retention.test', role: 'OWNER' },
  ]);
  const other = await seedOrganization(t.db, 'Neighbour Co', [
    { email: 'owner@neighbour.test', role: 'OWNER' },
  ]);
  p = await seedPlace(t, org.id);
  neighbour = await seedPlace(t, other.id);
});

afterAll(async () => {
  await retentionPool?.end();
  await t?.close();
});

describe('the daily retention run (SEC §16.5)', () => {
  it('ADV-P03 deletes exactly what expired, clears old positions, audits the counts, and touches nothing else', async () => {
    // A shift 4 months ago: its track is past 90 days, the shift itself is kept (12 months).
    const recentish = await seedShift(t, p, {
      start: daysAgo(120),
      hours: 8,
      status: 'COMPLETED',
      startedAt: daysAgo(120),
      endedAt: daysAgo(120, 480),
      startFix: true,
    });
    const oldTrack = await seedPoints(t, p, { shiftId: recentish }, [
      { at: daysAgo(120, 60) },
      { at: daysAgo(120, 300) },
    ]);
    const oldScan = await seedVisit(recentish, daysAgo(120, 90));
    // Yesterday's shift: nothing of it goes.
    const yesterday = await seedShift(t, p, {
      start: daysAgo(1),
      hours: 8,
      status: 'COMPLETED',
      startedAt: daysAgo(1),
      endedAt: daysAgo(1, 480),
      startFix: true,
    });
    const freshTrack = await seedPoints(t, p, { shiftId: yesterday }, [{ at: daysAgo(1, 60) }]);
    const freshScan = await seedVisit(yesterday, daysAgo(1, 90));
    // A shift 14 months ago, its alert and its resolved incident with a photo: all of it goes.
    const ancient = await seedShift(t, p, {
      start: daysAgo(430),
      hours: 8,
      status: 'COMPLETED',
      startedAt: daysAgo(430),
      endedAt: daysAgo(430, 480),
    });
    const ancientTrack = await seedPoints(t, p, { shiftId: ancient }, [{ at: daysAgo(430, 30) }]);
    const ancientAlert = await seedAlert(t, p, {
      shiftId: ancient,
      openedAt: daysAgo(430, 60),
      resolvedAt: daysAgo(430, 90),
    });
    const ancientIncident = await seedIncident(t, p, {
      shiftId: ancient,
      occurredAt: daysAgo(430, 100),
      status: 'RESOLVED',
      resolvedAt: daysAgo(429),
    });
    const photo = await seedPhoto(ancientIncident);
    // An off-shift SOS resolved 16 months ago, with its trail: it goes, trail and all.
    const ancientSos = await seedSos(t, p, {
      shiftId: null,
      activatedAt: daysAgo(490),
      resolvedAt: daysAgo(490, 30),
    });
    const ancientTrail = await seedPoints(t, p, { sosEventId: ancientSos }, [{ at: daysAgo(490, 5) }]);
    // A shift 13 months ago with an alert still open: never deleted while open, so the shift stays.
    const heldShift = await seedShift(t, p, {
      start: daysAgo(400),
      hours: 8,
      status: 'MISSED',
    });
    const openAlert = await seedAlert(t, p, { shiftId: heldShift, openedAt: daysAgo(400, 120) });
    const oldStatus = await seedDeviceStatus(daysAgo(40));
    const newStatus = await seedDeviceStatus(daysAgo(5));
    const oldAudit = await seedAudit(daysAgo(800));
    const newAudit = await seedAudit(daysAgo(30));
    // The neighbour's equally old data: another organization's run never touches it.
    const neighbourShift = await seedShift(t, neighbour, {
      start: daysAgo(430),
      hours: 8,
      status: 'COMPLETED',
      startedAt: daysAgo(430),
      endedAt: daysAgo(430, 480),
    });
    const neighbourTrack = await seedPoints(t, neighbour, { shiftId: neighbourShift }, [
      { at: daysAgo(430, 30) },
    ]);
    const others = () =>
      rowCount(
        t,
        `select 1 from guards union all select 1 from sites union all select 1 from organization_members`,
        [],
      );
    const othersBefore = await others();

    // 19:57Z is 20:57 in London: past 03:00 there today, so the run is due.
    expect(await retentionIsDue(retention(), p.org, 'Europe/London')).toBe(true);
    const counts = await runRetention(retention(), p.org);

    // Gone.
    for (const id of oldTrack) expect(await exists('location_points', id), 'old track').toBe(0);
    for (const id of [...ancientTrack, ...ancientTrail]) expect(await exists('location_points', id)).toBe(0);
    expect(await exists('shifts', ancient)).toBe(0);
    expect(await exists('alerts', ancientAlert)).toBe(0);
    expect(await exists('incidents', ancientIncident)).toBe(0);
    expect(await exists('sos_events', ancientSos)).toBe(0);
    expect(await exists('device_status_events', oldStatus)).toBe(0);
    expect(await exists('audit_logs', oldAudit)).toBe(0);
    expect(await t.deps.objects.size(photo.original)).toBeNull();
    expect(await t.deps.objects.size(photo.view)).toBeNull();
    // Positions on records past 90 days are cleared; the records stay (owner decision 2).
    const shiftRow = await asOwner(t.db, (c) =>
      c.query('select start_latitude, end_latitude, status from shifts where id = $1', [recentish]),
    );
    expect(shiftRow.rows).toEqual([{ start_latitude: null, end_latitude: null, status: 'COMPLETED' }]);
    const scan = await asOwner(t.db, (c) =>
      c.query('select latitude, distance_m, verification_status from checkpoint_visits where id = $1', [
        oldScan,
      ]),
    );
    expect(scan.rows).toEqual([{ latitude: null, distance_m: 5, verification_status: 'INVALID_QR' }]);
    // Kept.
    for (const id of freshTrack) expect(await exists('location_points', id), 'fresh track').toBe(1);
    expect(await exists('shifts', yesterday)).toBe(1);
    expect(await exists('shifts', recentish)).toBe(1);
    expect(await exists('shifts', heldShift)).toBe(1);
    expect(await exists('alerts', openAlert)).toBe(1);
    expect(await exists('device_status_events', newStatus)).toBe(1);
    expect(await exists('audit_logs', newAudit)).toBe(1);
    const fresh = await asOwner(t.db, (c) =>
      c.query(
        `select (select start_latitude from shifts where id = $1) as shift, (select latitude from checkpoint_visits where id = $2) as scan`,
        [yesterday, freshScan],
      ),
    );
    expect(fresh.rows[0]).toEqual({ shift: 31.47, scan: 31.47 });
    expect(await exists('shifts', neighbourShift)).toBe(1);
    for (const id of neighbourTrack) expect(await exists('location_points', id)).toBe(1);
    expect(await others()).toBe(othersBefore);

    // One audit row with counts only.
    const audit = await asOwner(t.db, (c) =>
      c.query<{ metadata: Record<string, number>; actor_type: string }>(
        `select metadata, actor_type from audit_logs where organization_id = $1 and action = 'RETENTION_RUN'`,
        [p.org],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_type).toBe('SYSTEM');
    expect(audit.rows[0]?.metadata).toEqual(counts);
    expect(counts).toMatchObject({
      alerts: 1,
      incidents: 1,
      photos: 1,
      sos: 1,
      trail: 1,
      shifts: 1,
      deviceStatus: 1,
      auditLogs: 1,
      positionsClearedShifts: 1,
      positionsClearedScans: 1,
    });
    expect(counts.points).toBe(3); // the 4-month-old track (2) and the ancient shift's point (1)
    // Done for today; and a second run finds nothing more to delete.
    expect(await retentionIsDue(retention(), p.org, 'Europe/London')).toBe(false);
    const again = await runRetention(retention(), p.org);
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
  });

  it('ADV-P04 points around an incident or SOS still kept survive, and an SOS keeps its own trail', async () => {
    const shift = await seedShift(t, p, {
      start: daysAgo(200),
      hours: 8,
      status: 'COMPLETED',
      startedAt: daysAgo(200),
      endedAt: daysAgo(200, 480),
    });
    // An incident at minute 120, still open; the window is 30 minutes either side.
    await seedIncident(t, p, { shiftId: shift, occurredAt: daysAgo(200, 120) });
    const near = await seedPoints(t, p, { shiftId: shift }, [
      { at: daysAgo(200, 95) },
      { at: daysAgo(200, 145) },
    ]);
    const far = await seedPoints(t, p, { shiftId: shift }, [
      { at: daysAgo(200, 60) },
      { at: daysAgo(200, 200) },
    ]);
    // An SOS on the same shift, resolved 6 months ago (kept: 12 months): its window is press to
    // resolution, ±30 minutes.
    await seedSos(t, p, { shiftId: shift, activatedAt: daysAgo(200, 300), resolvedAt: daysAgo(200, 330) });
    const aroundSos = await seedPoints(t, p, { shiftId: shift }, [
      { at: daysAgo(200, 280) },
      { at: daysAgo(200, 355) },
    ]);
    // An off-shift SOS resolved 5 months ago: its whole trail is its evidence.
    const offShift = await seedSos(t, p, {
      shiftId: null,
      activatedAt: daysAgo(150),
      resolvedAt: daysAgo(150, 240),
    });
    const trail = await seedPoints(t, p, { sosEventId: offShift }, [
      { at: daysAgo(150, 10) },
      { at: daysAgo(150, 200) },
    ]);

    await runRetention(retention(), p.org);

    for (const id of [...near, ...aroundSos, ...trail])
      expect(await exists('location_points', id), 'evidence').toBe(1);
    for (const id of far) expect(await exists('location_points', id), 'outside the window').toBe(0);
  });

  it('the run is due once a day from 03:00 in the organization’s time zone', async () => {
    const other = await seedOrganization(t.db, 'Late Co', [{ email: 'owner@late.test', role: 'OWNER' }]);
    // 19:57Z is 00:57 the next day in Karachi: before 03:00, not yet due.
    expect(await retentionIsDue(retention(), other.id, 'Asia/Karachi')).toBe(false);
    // In London it is 20:57 local: due.
    expect(await retentionIsDue(retention(), other.id, 'Europe/London')).toBe(true);
  });
});
