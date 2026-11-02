// Records written straight into the test database (as its owner), for the reports, exports and
// retention tests: they need exact times and positions, months in the past, which the API (rightly)
// would never accept from a phone.
import { randomUUID } from 'node:crypto';

import { asOwner, type TestApp } from './support.ts';

const H = 3_600_000;
let references = 1000;

export type Seeded = { org: string; guard: string; device: string; site: string };

export async function seedPlace(
  t: TestApp,
  org: string,
  options: { site?: string; timezone?: string; guardName?: string; employeeNumber?: string } = {},
): Promise<Seeded> {
  const guard = randomUUID();
  const device = randomUUID();
  const site = randomUUID();
  await asOwner(t.db, async (c) => {
    await c.query(
      `insert into guards (id, organization_id, employee_number, display_name, phone) values ($1, $2, $3, $4, $5)`,
      [
        guard,
        org,
        options.employeeNumber ?? `E-${guard.slice(0, 8)}`,
        options.guardName ?? 'Seeded guard',
        `+9230${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      ],
    );
    await c.query(
      `insert into guard_devices (id, organization_id, guard_id, installation_id, public_key, key_algorithm, platform)
       values ($1, $2, $3, $4, decode(repeat('ab', 70), 'hex'), 'ECDSA_P256_SHA256', 'ANDROID')`,
      [device, org, guard, randomUUID()],
    );
    await c.query(
      `insert into sites (id, organization_id, name, timezone, boundary_kind, latitude, longitude, geofence_radius_meters)
       values ($1, $2, $3, $4, 'CIRCLE', 31.47, 74.4, 150)`,
      [site, org, options.site ?? 'Seeded site', options.timezone ?? 'Asia/Karachi'],
    );
  });
  return { org, guard, device, site };
}

export async function seedShift(
  t: TestApp,
  p: Seeded,
  s: {
    start: Date;
    hours: number;
    status: string;
    startedAt?: Date | null;
    endedAt?: Date | null;
    startFix?: boolean;
  },
): Promise<string> {
  const id = randomUUID();
  const ends = new Date(s.start.getTime() + s.hours * H);
  await asOwner(t.db, (c) =>
    c.query(
      `insert into shifts (id, organization_id, guard_id, site_id, starts_at, ends_at, start_deadline_at, status,
         actual_started_at, actual_ended_at, start_source, end_reason, start_latitude, start_longitude,
         end_latitude, end_longitude)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id,
        p.org,
        p.guard,
        p.site,
        s.start,
        ends,
        new Date(s.start.getTime() + 2 * H),
        s.status,
        s.startedAt ?? null,
        s.endedAt ?? null,
        s.startedAt ? 'APP_ONLINE' : null,
        s.endedAt ? 'GUARD' : null,
        s.startFix ? 31.47 : null,
        s.startFix ? 74.4 : null,
        s.startFix && s.endedAt ? 31.4701 : null,
        s.startFix && s.endedAt ? 74.4001 : null,
      ],
    ),
  );
  return id;
}

/** Points `northM` metres north of the site, one per entry. */
export async function seedPoints(
  t: TestApp,
  p: Seeded,
  where: { shiftId?: string | null; sosEventId?: string | null },
  points: readonly { at: Date; northM?: number; accuracyM?: number; receivedAt?: Date }[],
): Promise<string[]> {
  const ids: string[] = [];
  await asOwner(t.db, async (c) => {
    for (const pt of points) {
      const id = randomUUID();
      ids.push(id);
      await c.query(
        `insert into location_points (id, organization_id, guard_id, device_id, shift_id, sos_event_id, client_event_id,
           latitude, longitude, accuracy_m, recorded_at, captured_at, received_at, clock_status, source)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 74.4, $9, $10, $10, $11, 'VERIFIED_MONOTONIC', $12)`,
        [
          id,
          p.org,
          p.guard,
          p.device,
          where.shiftId ?? null,
          where.sosEventId ?? null,
          randomUUID(),
          31.47 + (pt.northM ?? 0) / 111_195,
          pt.accuracyM ?? 10,
          pt.at,
          pt.receivedAt ?? pt.at,
          where.sosEventId ? 'SOS' : 'TRACKING',
        ],
      );
    }
  });
  return ids;
}

export async function seedIncident(
  t: TestApp,
  p: Seeded,
  i: {
    shiftId: string | null;
    sosEventId?: string | null;
    occurredAt: Date;
    status?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
    acknowledgedAt?: Date;
    resolvedAt?: Date;
    severity?: string;
    title?: string;
    isDrill?: boolean;
  },
): Promise<string> {
  const id = randomUUID();
  const status = i.status ?? 'OPEN';
  await asOwner(t.db, (c) =>
    c.query(
      `insert into incidents (id, organization_id, reference_number, guard_id, shift_id, sos_event_id, site_id, type,
         severity, title, latitude, longitude, occurred_at, reported_at, received_at, status, acknowledged_at,
         resolved_at, resolution_note, is_drill)
       values ($1, $2, $3, $4, $5, $6, $7, 'THEFT', $8, $9, 31.47, 74.4, $10, $10, $10, $11, $12, $13, $14, $15)`,
      [
        id,
        p.org,
        ++references,
        p.guard,
        i.shiftId,
        i.sosEventId ?? null,
        p.site,
        i.severity ?? 'HIGH',
        i.title ?? 'Cable stolen',
        i.occurredAt,
        status,
        status === 'OPEN' ? null : (i.acknowledgedAt ?? i.resolvedAt ?? i.occurredAt),
        status === 'RESOLVED' ? (i.resolvedAt ?? i.occurredAt) : null,
        status === 'RESOLVED' ? 'Closed' : null,
        i.isDrill ?? false,
      ],
    ),
  );
  return id;
}

export async function seedSos(
  t: TestApp,
  p: Seeded,
  s: { shiftId: string | null; activatedAt: Date; resolvedAt?: Date },
): Promise<string> {
  const id = randomUUID();
  await asOwner(t.db, (c) =>
    c.query(
      `insert into sos_events (id, organization_id, guard_id, shift_id, site_id, device_id, client_event_id,
         activated_at_recorded, activated_at, received_at, clock_status, last_triggered_at, status, acknowledged_at,
         resolved_at, resolution, resolution_note, latitude, longitude, accuracy_m, location_captured_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, 'VERIFIED_MONOTONIC', $8, $9, $10, $11, $12, $13, 31.47, 74.4, 9, $8)`,
      [
        id,
        p.org,
        p.guard,
        s.shiftId,
        s.shiftId ? p.site : null,
        p.device,
        randomUUID(),
        s.activatedAt,
        s.resolvedAt ? 'RESOLVED' : 'ACTIVE',
        s.resolvedAt ?? null,
        s.resolvedAt ?? null,
        s.resolvedAt ? 'GENUINE' : null,
        s.resolvedAt ? 'Handled' : null,
      ],
    ),
  );
  return id;
}

export async function seedAlert(
  t: TestApp,
  p: Seeded,
  a: { shiftId: string | null; openedAt: Date; resolvedAt?: Date; incidentId?: string; sosEventId?: string },
): Promise<string> {
  const id = randomUUID();
  await asOwner(t.db, (c) =>
    c.query(
      `insert into alerts (id, organization_id, type, severity, status, dedupe_key, summary, guard_id, site_id, shift_id,
         opened_at, last_triggered_at, resolved_at, resolution_type, incident_id, sos_event_id)
       values ($1, $2, 'LOW_BATTERY', 'LOW', $3, $4, 'Low battery', $5, $6, $7, $8, $8, $9, $10, $11, $12)`,
      [
        id,
        p.org,
        a.resolvedAt ? 'RESOLVED' : 'OPEN',
        `seed:${id}`,
        p.guard,
        p.site,
        a.shiftId,
        a.openedAt,
        a.resolvedAt ?? null,
        a.resolvedAt ? 'MANUAL' : null,
        a.incidentId ?? null,
        a.sosEventId ?? null,
      ],
    ),
  );
  return id;
}

/** A route at the site and one closed round of it in the shift, with `counted` of `required` done. */
export async function seedRun(
  t: TestApp,
  p: Seeded,
  r: {
    shiftId: string;
    dueAt: Date;
    status: string;
    required: number;
    counted: number;
    unconfirmed?: number;
  },
): Promise<string> {
  const route = randomUUID();
  const run = randomUUID();
  await asOwner(t.db, async (c) => {
    await c.query(
      `insert into patrol_routes (id, organization_id, site_id, name) values ($1, $2, $3, 'Beat round')`,
      [route, p.org, p.site],
    );
    await c.query(
      `insert into patrol_runs (id, organization_id, shift_id, guard_id, site_id, patrol_route_id, sequence_no, due_at,
         window_ends_at, status, required_count, counted_count, unconfirmed_count, completed_at, closed_at)
       values ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12, $13, $8)`,
      [
        run,
        p.org,
        r.shiftId,
        p.guard,
        p.site,
        route,
        r.dueAt,
        new Date(r.dueAt.getTime() + 15 * 60_000),
        r.status,
        r.required,
        r.counted,
        r.unconfirmed ?? 0,
        r.status === 'COMPLETED' ? new Date(r.dueAt.getTime() + 10 * 60_000) : null,
      ],
    );
  });
  return run;
}

export async function rowCount(t: TestApp, sqlText: string, params: unknown[]): Promise<number> {
  const { rows } = await asOwner(t.db, (c) =>
    c.query<{ n: string }>(`select count(*) as n from (${sqlText}) x`, params),
  );
  return Number(rows[0]?.n ?? 0);
}
