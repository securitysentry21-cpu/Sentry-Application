// Incidents (PROD §10): filed by guards through the sync queue only during a shift or an open SOS
// (INV-08), recorded from the dashboard, never rewritten (INV-05), managed by status, severity and
// type with every change on the record, and alerting by severity (PROD §10.4).
import { randomUUID } from 'node:crypto';

import pg from 'pg';
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
const BOOT = 'incident-boot';
const AT_SITE = { lat: 31.4702, lon: 74.4001, accuracyM: 8 };

let t: TestApp;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let admin: string;
let supervisor: string;
let dispatcher: string;
let siteId: string;
let checkpointId: string;
let seq = 0;
let mono = 3_000_000;

type Result = { status: string; code?: string; incident?: { id: string; referenceNumber: string } };

function item(type: string, fields: Record<string, unknown>, agoMs = 1_000) {
  mono += 100;
  return {
    clientEventId: randomUUID(),
    type,
    recordedAt: new Date(t.clock.now().getTime() - agoMs).toISOString(),
    monoMs: mono - agoMs,
    bootId: BOOT,
    ...fields,
  };
}

async function send(phone: EnrolledPhone, items: Record<string, unknown>[]): Promise<Result[]> {
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
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ results: Result[] }>().results;
}

const report = (shiftId: string | null, fields: Record<string, unknown> = {}) =>
  item('INCIDENT', {
    shiftId,
    incident: {
      type: 'FIRE',
      severity: 'HIGH',
      description: 'Smoke from the generator room',
      occurredAt: t.clock.now().toISOString(),
      ...fields,
    },
    fix: { ...AT_SITE, fixAgeS: 2 },
  });

async function guard(
  onShift: boolean,
): Promise<{ phone: EnrolledPhone; shiftId: string | null; guardId: string }> {
  const number = `+9230055${String(10_000 + seq++).padStart(5, '0')}`;
  const guardId = await createGuard(t.app, admin, org.id, {
    employeeNumber: `I-${seq}`,
    displayName: `Guard ${seq}`,
    phone: number,
  });
  const phone = await enrollPhone(t.app, admin, org.id, guardId, number);
  if (!onShift) return { phone, shiftId: null, guardId };
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
  const [started] = await send(phone, [
    item('SHIFT_START', {
      shiftId,
      fix: { ...AT_SITE, fixAgeS: 2 },
      permission: { location: 'ALWAYS', precise: true },
    }),
  ]);
  expect(started?.status).toBe('ACCEPTED');
  return { phone, shiftId, guardId };
}

const detail = async (id: string, cookie = supervisor) => {
  const res = await call(t.app, { method: 'GET', url: `/api/v1/incidents/${id}`, cookie, org: org.id });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{
    incident: {
      referenceNumber: string;
      type: string;
      severity: string;
      status: string;
      version: number;
      location: { lat: number; lng: number } | null;
      original: { type: string; severity: string };
      events: {
        type: string;
        fromValue: string | null;
        toValue: string | null;
        body: string | null;
        actorType: string;
      }[];
    };
  }>().incident;
};

const alertsFor = async (incidentId: string) =>
  (
    await asOwner(t.db, (c) =>
      c.query<{ type: string; status: string; next_escalation_at: Date | null }>(
        'select type, status, next_escalation_at from alerts where incident_id = $1 order by created_at',
        [incidentId],
      ),
    )
  ).rows;

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'Incident Co', [
    { email: 'admin@inc.test', role: 'ADMIN' },
    { email: 'sup@inc.test', role: 'SUPERVISOR' },
    { email: 'disp@inc.test', role: 'DISPATCHER' },
  ]);
  admin = await signIn(t.app, 'admin@inc.test');
  supervisor = await signIn(t.app, 'sup@inc.test');
  dispatcher = await signIn(t.app, 'disp@inc.test');
  const site = await call(t.app, {
    method: 'POST',
    url: '/api/v1/sites',
    cookie: admin,
    org: org.id,
    body: {
      name: 'Generator yard',
      boundary: { kind: 'CIRCLE', center: { lat: 31.47, lng: 74.4 }, radiusM: 300 },
    },
  });
  siteId = site.json<{ id: string }>().id;
  const checkpoint = await call(t.app, {
    method: 'POST',
    url: `/api/v1/sites/${siteId}/checkpoints`,
    cookie: admin,
    org: org.id,
    body: { name: 'North door', location: { lat: 31.4702, lng: 74.4001 } },
  });
  checkpointId = checkpoint.json<{ id: string }>().id;
});

afterAll(async () => {
  await t?.close();
});

describe('a guard files an incident (PROD §7.8, §10.1)', () => {
  it('during a shift: stored with its reference, the server-derived shift and site, and its location', async () => {
    const { phone, shiftId } = await guard(true);
    const [res] = await send(phone, [report(shiftId)]);
    expect(res?.status).toBe('ACCEPTED');
    expect(res?.incident?.referenceNumber).toMatch(/^INC-\d{6}$/);
    const incident = await detail(res?.incident?.id ?? '');
    expect(incident).toMatchObject({
      type: 'FIRE',
      severity: 'HIGH',
      status: 'OPEN',
      original: { type: 'FIRE', severity: 'HIGH' },
    });
    // Everyone who sees the incident sees where it was reported, dispatchers included (owner decision).
    expect((await detail(res?.incident?.id ?? '', dispatcher)).location?.lat).toBeCloseTo(AT_SITE.lat, 4);
    const { rows } = await asOwner(t.db, (c) =>
      c.query('select shift_id, site_id, title from incidents where id = $1', [res?.incident?.id]),
    );
    expect(rows).toEqual([{ shift_id: shiftId, site_id: siteId, title: 'Fire' }]);
  });

  it('ADV-P05 with no shift and no open SOS, nothing is stored (INV-08)', async () => {
    const { phone, guardId } = await guard(false);
    const [res] = await send(phone, [report(null)]);
    expect(res).toMatchObject({ status: 'REJECTED', code: 'SHIFT_NOT_ACTIVE' });
    const { rows } = await asOwner(t.db, (c) =>
      c.query('select 1 from incidents where guard_id = $1', [guardId]),
    );
    expect(rows).toHaveLength(0);
  });

  it('during an open SOS off shift: accepted with the SOS, coordinates kept (INV-08 exception)', async () => {
    const { phone } = await guard(false);
    mono += 100;
    const sos = await asPhone(t.app, phone, {
      method: 'POST',
      url: '/api/v1/sos',
      body: {
        clientEventId: randomUUID(),
        recordedAt: t.clock.now().toISOString(),
        monoMs: mono,
        bootId: BOOT,
        fix: null,
      },
    });
    const sosEventId = sos.json<{ sosEventId: string }>().sosEventId;
    t.clock.advance(30_000);
    const [res] = await send(phone, [report(null, { severity: 'CRITICAL' })]);
    expect(res?.status).toBe('ACCEPTED');
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ sos_event_id: string; latitude: number }>(
        'select sos_event_id, latitude from incidents where id = $1',
        [res?.incident?.id],
      ),
    );
    expect(rows[0]?.sos_event_id).toBe(sosEventId);
    expect(rows[0]?.latitude).toBeCloseTo(AT_SITE.lat, 4);
  });

  it('set back more than 24 hours, or into the future, the report is refused', async () => {
    const { phone, shiftId } = await guard(true);
    const results = await send(phone, [
      report(shiftId, { occurredAt: new Date(t.clock.now().getTime() - 25 * H).toISOString() }),
      report(shiftId, { occurredAt: new Date(t.clock.now().getTime() + 10 * 60_000).toISOString() }),
      report(shiftId, { occurredAt: new Date(t.clock.now().getTime() - 23 * H).toISOString() }),
    ]);
    expect(results.map((r) => [r.status, r.code])).toEqual([
      ['REJECTED', 'VALIDATION_FAILED'],
      ['REJECTED', 'VALIDATION_FAILED'],
      ['ACCEPTED', undefined],
    ]);
  });

  it('"Checkpoint problem" links the checkpoint of the shift\'s site, and only that (PROD §7.7)', async () => {
    const { phone, shiftId } = await guard(true);
    const [linked, unknown] = await send(phone, [
      report(shiftId, {
        type: 'OTHER',
        severity: 'LOW',
        title: 'Checkpoint problem: North door',
        checkpointId,
      }),
      report(shiftId, {
        type: 'OTHER',
        severity: 'LOW',
        title: 'Checkpoint problem',
        checkpointId: randomUUID(),
      }),
    ]);
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ id: string; checkpoint_id: string | null }>(
        'select id, checkpoint_id from incidents where id = any($1)',
        [[linked?.incident?.id, unknown?.incident?.id]],
      ),
    );
    const byId = new Map(rows.map((r) => [r.id, r.checkpoint_id]));
    expect(byId.get(linked?.incident?.id ?? '')).toBe(checkpointId);
    expect(byId.get(unknown?.incident?.id ?? '')).toBeNull();
  });

  it('more than 20 reports from one guard in an hour wait for later (SEC §9); nothing is lost', async () => {
    const { phone, shiftId } = await guard(true);
    const results = await send(
      phone,
      Array.from({ length: 21 }, () => report(shiftId, { severity: 'LOW' })),
    );
    expect(results.slice(0, 20).every((r) => r.status === 'ACCEPTED')).toBe(true);
    expect(results[20]?.status).toBe('RETRY');
  });
});

describe('alerts from incidents (PROD §10.4)', () => {
  it('CRITICAL opens INCIDENT_CRITICAL, which escalates; HIGH opens INCIDENT_HIGH; lower opens none', async () => {
    const { phone, shiftId } = await guard(true);
    const [critical, high, medium] = await send(phone, [
      report(shiftId, { severity: 'CRITICAL' }),
      report(shiftId, { severity: 'HIGH' }),
      report(shiftId, { severity: 'MEDIUM' }),
    ]);
    const criticalAlerts = await alertsFor(critical?.incident?.id ?? '');
    expect(criticalAlerts.map((a) => a.type)).toEqual(['INCIDENT_CRITICAL']);
    expect(criticalAlerts[0]?.next_escalation_at).not.toBeNull();
    expect((await alertsFor(high?.incident?.id ?? '')).map((a) => [a.type, a.next_escalation_at])).toEqual([
      ['INCIDENT_HIGH', null],
    ]);
    expect(await alertsFor(medium?.incident?.id ?? '')).toEqual([]);
    // Acknowledging the incident acknowledges its alert and stops escalation.
    await call(t.app, {
      method: 'POST',
      url: `/api/v1/incidents/${critical?.incident?.id}/acknowledge`,
      cookie: dispatcher,
      org: org.id,
    });
    expect((await alertsFor(critical?.incident?.id ?? ''))[0]).toMatchObject({
      status: 'ACKNOWLEDGED',
      next_escalation_at: null,
    });
  });
});

describe('managing an incident (PROD §10.2)', () => {
  it('severity and type change with their old and new values; the original submission stays', async () => {
    const { phone, shiftId } = await guard(true);
    const [res] = await send(phone, [report(shiftId)]);
    const id = res?.incident?.id ?? '';
    const before = await detail(id);
    const changed = await call(t.app, {
      method: 'PATCH',
      url: `/api/v1/incidents/${id}`,
      cookie: supervisor,
      org: org.id,
      body: { version: before.version, severity: 'CRITICAL', type: 'INTRUSION' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const after = await detail(id);
    expect(after).toMatchObject({
      type: 'INTRUSION',
      severity: 'CRITICAL',
      original: { type: 'FIRE', severity: 'HIGH' },
    });
    // Two changes in the same request: compared as a set (the same millisecond has no order).
    expect(
      after.events
        .filter((e) => e.type.endsWith('_CHANGED'))
        .map((e) => [e.type, e.fromValue, e.toValue])
        .sort(),
    ).toEqual([
      ['SEVERITY_CHANGED', 'HIGH', 'CRITICAL'],
      ['TYPE_CHANGED', 'FIRE', 'INTRUSION'],
    ]);
    // Raised to CRITICAL: the critical alert opens now.
    expect((await alertsFor(id)).map((a) => a.type)).toContain('INCIDENT_CRITICAL');
    const stale = await call(t.app, {
      method: 'PATCH',
      url: `/api/v1/incidents/${id}`,
      cookie: supervisor,
      org: org.id,
      body: { version: before.version, severity: 'LOW' },
    });
    expect(errorCode(stale)).toBe('VERSION_CONFLICT');
    // A dispatcher acknowledges and adds notes, but doesn't change severity (PROD §3.2).
    const notAllowed = await call(t.app, {
      method: 'PATCH',
      url: `/api/v1/incidents/${id}`,
      cookie: dispatcher,
      org: org.id,
      body: { version: after.version, severity: 'LOW' },
    });
    expect(errorCode(notAllowed)).toBe('FORBIDDEN');
    const audited = await asOwner(t.db, (c) =>
      c.query(`select 1 from audit_logs where action = 'INCIDENT_UPDATED' and resource_id = $1`, [id]),
    );
    expect(audited.rowCount).toBe(1);
  });

  it('INV-05 the database refuses to rewrite the submission itself, even to the runtime role', async () => {
    const { phone, shiftId } = await guard(true);
    const [res] = await send(phone, [report(shiftId)]);
    const client = new pg.Client({ connectionString: t.db.urls.app_runtime });
    await client.connect();
    try {
      for (const column of ['description', 'title']) {
        await client.query('begin');
        await client.query(`select set_config('app.org_id', $1, true)`, [org.id]);
        await expect(
          client.query(`update incidents set ${column} = 'rewritten' where id = $1`, [res?.incident?.id]),
        ).rejects.toThrow(/permission denied/);
        await client.query('rollback');
      }
      // What a supervisor may change, the grant allows.
      await client.query('begin');
      await client.query(`select set_config('app.org_id', $1, true)`, [org.id]);
      const ok = await client.query(`update incidents set severity = 'LOW' where id = $1`, [
        res?.incident?.id,
      ]);
      expect(ok.rowCount).toBe(1);
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });

  it('notes from the dashboard and from the guard on their own report; never on another guard’s', async () => {
    const mine = await guard(true);
    const other = await guard(true);
    const filed = report(mine.shiftId);
    const [res] = await send(mine.phone, [filed]);
    const id = res?.incident?.id ?? '';
    await call(t.app, {
      method: 'POST',
      url: `/api/v1/incidents/${id}/notes`,
      cookie: dispatcher,
      org: org.id,
      body: { body: 'Fire service called' },
    });
    t.clock.advance(1_000);
    const [own] = await send(mine.phone, [
      item('INCIDENT_NOTE', {
        shiftId: mine.shiftId,
        incidentClientEventId: filed.clientEventId,
        body: 'Out now',
      }),
    ]);
    expect(own?.status).toBe('ACCEPTED');
    const [foreign] = await send(other.phone, [
      item('INCIDENT_NOTE', { shiftId: other.shiftId, incidentId: id, body: 'Not mine' }),
    ]);
    expect(foreign).toMatchObject({ status: 'REJECTED', code: 'NOT_FOUND' });
    const notes = (await detail(id)).events.filter((e) => e.type === 'NOTE_ADDED');
    expect(notes.map((n) => [n.actorType, n.body])).toEqual([
      ['USER', 'Fire service called'],
      ['GUARD', 'Out now'],
    ]);
    // On the phone the guard reads back their own notes only; the control room's stay in the dashboard.
    const mineList = await asPhone(t.app, mine.phone, { method: 'GET', url: '/api/v1/me/incidents' });
    const onPhone = mineList
      .json<{ incidents: { id: string; notes: { body: string }[] }[] }>()
      .incidents.find((i) => i.id === id);
    expect(onPhone?.notes.map((n) => n.body)).toEqual(['Out now']);
  });

  it('OPEN → ACKNOWLEDGED → RESOLVED (note required), reopened with a reason; each change audited', async () => {
    const { phone, shiftId } = await guard(true);
    const [res] = await send(phone, [report(shiftId, { severity: 'CRITICAL' })]);
    const id = res?.incident?.id ?? '';
    const post = (cookie: string, action: string, body?: Record<string, unknown>) =>
      call(t.app, {
        method: 'POST',
        url: `/api/v1/incidents/${id}/${action}`,
        cookie,
        org: org.id,
        body: body ?? {},
      });
    expect((await post(dispatcher, 'acknowledge')).statusCode).toBe(200);
    expect((await post(supervisor, 'acknowledge')).statusCode).toBe(200);
    expect(errorCode(await post(dispatcher, 'resolve', { note: 'Done' }))).toBe('FORBIDDEN');
    expect(errorCode(await post(supervisor, 'resolve', {}))).toBe('VALIDATION_FAILED');
    expect((await post(supervisor, 'resolve', { note: 'Extinguished; no injuries' })).statusCode).toBe(200);
    expect((await detail(id)).status).toBe('RESOLVED');
    expect((await alertsFor(id)).every((a) => a.status === 'RESOLVED')).toBe(true);
    expect(errorCode(await post(supervisor, 'resolve', { note: 'Again' }))).toBe(
      'INCIDENT_INVALID_TRANSITION',
    );
    expect((await post(supervisor, 'reopen', { reason: 'Smoke again' })).statusCode).toBe(200);
    expect((await detail(id)).status).toBe('OPEN');
    const { rows } = await asOwner(t.db, (c) =>
      c.query(`select 1 from audit_logs where action = 'INCIDENT_STATUS_CHANGED' and resource_id = $1`, [id]),
    );
    expect(rows).toHaveLength(3);
  });

  it('a supervisor records an incident from the dashboard; a dispatcher cannot', async () => {
    const created = await call(t.app, {
      method: 'POST',
      url: '/api/v1/incidents',
      cookie: supervisor,
      org: org.id,
      body: {
        type: 'THEFT',
        severity: 'MEDIUM',
        title: 'Copper cable stolen',
        description: 'Reported by the client',
        siteId,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const incident = created.json<{
      incident: { id: string; location: unknown; reportedBy: { name: string } };
    }>().incident;
    expect(incident.location).toBeNull();
    expect(incident.reportedBy.name).toBe('sup');
    const audited = await asOwner(t.db, (c) =>
      c.query(`select 1 from audit_logs where action = 'INCIDENT_CREATED' and resource_id = $1`, [
        incident.id,
      ]),
    );
    expect(audited.rowCount).toBe(1);
    const refused = await call(t.app, {
      method: 'POST',
      url: '/api/v1/incidents',
      cookie: dispatcher,
      org: org.id,
      body: { type: 'THEFT', severity: 'LOW', title: 'x' },
    });
    expect(errorCode(refused)).toBe('FORBIDDEN');
  });
});

describe('who sees what', () => {
  it('ADV-A03 the guard sees their own reports only', async () => {
    const mine = await guard(true);
    const other = await guard(true);
    const [a] = await send(mine.phone, [report(mine.shiftId)]);
    const [b] = await send(other.phone, [report(other.shiftId)]);
    const res = await asPhone(t.app, mine.phone, { method: 'GET', url: '/api/v1/me/incidents' });
    const ids = res.json<{ incidents: { id: string }[] }>().incidents.map((i) => i.id);
    expect(ids).toContain(a?.incident?.id);
    expect(ids).not.toContain(b?.incident?.id);
  });

  it("the list never holds another organization's incidents; the home page counts open ones", async () => {
    const other = await seedOrganization(t.db, 'Other incident Co', [
      { email: 'sup@other-inc.test', role: 'SUPERVISOR' },
    ]);
    const otherSup = await signIn(t.app, 'sup@other-inc.test');
    const theirs = await call(t.app, {
      method: 'POST',
      url: '/api/v1/incidents',
      cookie: otherSup,
      org: other.id,
      body: { type: 'OTHER', severity: 'LOW', title: 'Theirs' },
    });
    const theirId = theirs.json<{ incident: { id: string } }>().incident.id;
    for (const status of ['open', 'all']) {
      const list = await call(t.app, {
        method: 'GET',
        url: `/api/v1/incidents?status=${status}`,
        cookie: supervisor,
        org: org.id,
      });
      expect(list.json<{ incidents: { id: string }[] }>().incidents.map((i) => i.id)).not.toContain(theirId);
    }
    const snapshot = await call(t.app, {
      method: 'GET',
      url: '/api/v1/dashboard/snapshot',
      cookie: supervisor,
      org: org.id,
    });
    const open = (
      await asOwner(t.db, (c) =>
        c.query<{ n: string }>(
          `select count(*) as n from incidents where organization_id = $1 and status <> 'RESOLVED'`,
          [org.id],
        ),
      )
    ).rows[0]?.n;
    expect(snapshot.json<{ openIncidents: number }>().openIncidents).toBe(Number(open));
  });
});
