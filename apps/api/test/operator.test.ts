// The platform operator's commands into one organization (D-19, runbooks): delivery health and the
// replay of quarantined sync items. Each is audited as PLATFORM_ACCESS with a reason, stays inside
// the organization's own tenant transaction, and prints no coordinates, text or phone numbers.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseOperatorArgs } from '../src/cli/operator-args.ts';
import {
  assessDeliveryHealth,
  deliveryHealth,
  formatDeliveryHealth,
  formatQuarantine,
  listQuarantine,
  OperatorError,
  replayQuarantine,
} from '../src/services/operator.ts';
import {
  asOwner,
  call,
  createGuard,
  enrollPhone,
  seedOrganization,
  signIn,
  startTestApp,
  type EnrolledPhone,
  type TestApp,
} from './support.ts';

let t: TestApp;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let other: Awaited<ReturnType<typeof seedOrganization>>;
let admin: string;
let owner: string;
let siteId: string;
let seq = 0;

const H = 3_600_000;
const MIN = 60_000;
const AT_SITE = { lat: 31.4702, lon: 74.4001, accuracyM: 8, fixAgeS: 2 };
const REASON = 'support case 42';

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'Operator Co', [
    { email: 'admin@operator.test', role: 'ADMIN' },
    { email: 'owner@operator.test', role: 'OWNER' },
  ]);
  other = await seedOrganization(t.db, 'Other Co', [{ email: 'admin@other.test', role: 'ADMIN' }]);
  admin = await signIn(t.app, 'admin@operator.test');
  owner = await signIn(t.app, 'owner@operator.test');
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

/** A guard with an enrolled phone and a shift that starts in five minutes. */
async function guardWithShift(): Promise<{ phone: EnrolledPhone; shiftId: string }> {
  const number = `+9230033${String(10_000 + seq++).padStart(5, '0')}`;
  const guardId = await createGuard(t.app, admin, org.id, {
    employeeNumber: `Q-${number.slice(-5)}`,
    displayName: `Quarantine ${number.slice(-3)}`,
    phone: number,
  });
  const phone = await enrollPhone(t.app, admin, org.id, guardId, number);
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
  return { phone, shiftId: created.json<{ id: string }>().id };
}

const startItem = (shiftId: string, clientEventId = randomUUID()) => ({
  clientEventId,
  type: 'SHIFT_START',
  recordedAt: new Date(t.clock.now().getTime() - 1_000).toISOString(),
  monoMs: 5_000,
  bootId: 'old-boot',
  shiftId,
  fix: AT_SITE,
  permission: { location: 'ALWAYS', precise: true },
});

const endItem = (shiftId: string) => ({
  clientEventId: randomUUID(),
  type: 'SHIFT_END',
  recordedAt: new Date(t.clock.now().getTime() - 500).toISOString(),
  monoMs: 6_000,
  bootId: 'old-boot',
  shiftId,
  fix: { ...AT_SITE, fixAgeS: 1 },
});

/** What processBatch leaves behind when an item hits an unexpected error. */
async function quarantine(
  phone: EnrolledPhone,
  item: Record<string, unknown>,
  createdAgoMs = MIN,
): Promise<string> {
  const id = randomUUID();
  await asOwner(t.db, (c) =>
    c.query(
      `insert into quarantined_items (id, organization_id, device_id, batch_id, client_event_id, item, error_code, created_at)
       values ($1, $2, $3, $4, $5, $6, 'INTERNAL_ERROR', $7)`,
      [
        id,
        org.id,
        phone.deviceId,
        randomUUID(),
        item.clientEventId,
        JSON.stringify(item),
        new Date(t.clock.now().getTime() - createdAgoMs),
      ],
    ),
  );
  return id;
}

const shiftStatus = async (shiftId: string) =>
  (
    await asOwner(t.db, (c) =>
      c.query<{ status: string }>('select status from shifts where id = $1', [shiftId]),
    )
  ).rows[0]?.status;

const replayedAt = async (id: string) =>
  (
    await asOwner(t.db, (c) =>
      c.query<{ replayed_at: Date | null }>('select replayed_at from quarantined_items where id = $1', [id]),
    )
  ).rows[0]?.replayed_at;

const audit = async () =>
  (
    await asOwner(t.db, (c) =>
      c.query<{ actor_type: string; reason: string | null; metadata: Record<string, unknown> }>(
        `select actor_type, reason, metadata from audit_logs
          where organization_id = $1 and action = 'PLATFORM_ACCESS' order by created_at, id`,
        [org.id],
      ),
    )
  ).rows;

describe('replaying quarantined sync items', () => {
  it('runs a quarantined start through the real pipeline as its own phone, marks it replayed, and is safe to repeat', async () => {
    const { phone, shiftId } = await guardWithShift();
    const id = await quarantine(phone, startItem(shiftId));
    expect(await shiftStatus(shiftId)).toBe('SCHEDULED');

    const listed = await listQuarantine(t.deps, org.id, {
      reason: REASON,
      includeReplayed: false,
      limit: 50,
    });
    expect(listed.map((r) => [r.id, r.itemType, r.errorCode])).toContainEqual([
      id,
      'SHIFT_START',
      'INTERNAL_ERROR',
    ]);
    // The list shows an item's type and ID, never what is in it.
    const text = formatQuarantine(listed, t.clock.now()).join('\n');
    expect(text).not.toContain('31.47');
    expect(text).not.toContain('permission');

    const outcomes = await replayQuarantine(t.deps, org.id, { reason: REASON, id, limit: 50 });
    expect(outcomes).toEqual([{ id, itemType: 'SHIFT_START', result: 'REPLAYED', detail: 'ACCEPTED' }]);
    expect(await shiftStatus(shiftId)).toBe('ACTIVE');
    expect(await replayedAt(id)).not.toBeNull();

    // Nothing open is left, and a second run changes nothing.
    await expect(replayQuarantine(t.deps, org.id, { reason: REASON, id, limit: 50 })).rejects.toThrow(
      OperatorError,
    );
    const events = await asOwner(t.db, (c) =>
      c.query('select 1 from shift_events where shift_id = $1', [shiftId]),
    );
    const again = await replayQuarantine(t.deps, org.id, { reason: REASON, limit: 50 });
    expect(again.find((o) => o.id === id)).toBeUndefined();
    expect(
      (await asOwner(t.db, (c) => c.query('select 1 from shift_events where shift_id = $1', [shiftId])))
        .rowCount,
    ).toBe(events.rowCount);
  });

  it('an item the phone already got through comes back DUPLICATE (INV-06): nothing is done twice', async () => {
    const { phone, shiftId } = await guardWithShift();
    const item = startItem(shiftId);
    const first = await quarantine(phone, item);
    expect((await replayQuarantine(t.deps, org.id, { reason: REASON, id: first, limit: 1 }))[0]?.detail).toBe(
      'ACCEPTED',
    );
    const second = await quarantine(phone, item); // the same client event, quarantined again
    const outcome = (await replayQuarantine(t.deps, org.id, { reason: REASON, id: second, limit: 1 }))[0];
    expect(outcome).toMatchObject({ result: 'REPLAYED', detail: 'DUPLICATE' });
    const starts = await asOwner(t.db, (c) =>
      c.query(`select 1 from shift_events where shift_id = $1 and type = 'STARTED'`, [shiftId]),
    );
    expect(starts.rowCount).toBe(1);
  });

  it('goes oldest first, so a start is in before its end; an end replayed alone waits for its start', async () => {
    const { phone, shiftId } = await guardWithShift();
    const start = await quarantine(phone, startItem(shiftId), 3 * MIN);
    const end = await quarantine(phone, endItem(shiftId), 2 * MIN);

    const alone = await replayQuarantine(t.deps, org.id, { reason: REASON, id: end, limit: 1 });
    expect(alone).toEqual([expect.objectContaining({ id: end, result: 'WAITING' })]);
    expect(await replayedAt(end)).toBeNull();

    const outcomes = await replayQuarantine(t.deps, org.id, { reason: REASON, limit: 50 });
    const mine = outcomes.filter((o) => o.id === start || o.id === end);
    expect(mine.map((o) => [o.id, o.result])).toEqual([
      [start, 'REPLAYED'],
      [end, 'REPLAYED'],
    ]);
    expect(await shiftStatus(shiftId)).toBe('COMPLETED');
  });

  it('does not replay what a lost or compromised phone sent, and holds a replaced phone to its replacement time (ADV-A08)', async () => {
    const lost = await guardWithShift();
    const lostItem = await quarantine(lost.phone, startItem(lost.shiftId));
    await asOwner(t.db, (c) =>
      c.query(
        `update guard_devices set status = 'REVOKED', revoked_reason = 'LOST', revoked_at = now() where id = $1`,
        [lost.phone.deviceId],
      ),
    );
    const refused = await replayQuarantine(t.deps, org.id, { reason: REASON, id: lostItem, limit: 1 });
    expect(refused).toEqual([
      { id: lostItem, itemType: 'SHIFT_START', result: 'SKIPPED', detail: 'the phone was revoked (LOST)' },
    ]);
    expect(await replayedAt(lostItem)).toBeNull();
    expect(await shiftStatus(lost.shiftId)).toBe('SCHEDULED');

    const replaced = await guardWithShift();
    const before = await quarantine(replaced.phone, startItem(replaced.shiftId));
    // The new phone took over a minute ago… the quarantined start was captured a second ago: after it.
    await asOwner(t.db, (c) =>
      c.query(
        `update guard_devices set status = 'REVOKED', revoked_reason = 'REPLACED', revoked_at = $2 where id = $1`,
        [replaced.phone.deviceId, new Date(t.clock.now().getTime() - 30_000)],
      ),
    );
    const late = await replayQuarantine(t.deps, org.id, { reason: REASON, id: before, limit: 1 });
    expect(late[0]).toMatchObject({ result: 'REPLAYED', detail: 'REJECTED DEVICE_REVOKED' });
    expect(await shiftStatus(replaced.shiftId)).toBe('SCHEDULED');
  });

  it('INV-05 the runtime role may mark an item replayed and nothing else about it', async () => {
    const { phone, shiftId } = await guardWithShift();
    const id = await quarantine(phone, startItem(shiftId));
    const client = new pg.Client({ connectionString: t.db.urls.app_runtime });
    await client.connect();
    try {
      for (const column of ['item', 'error_code', 'device_id']) {
        await client.query('begin');
        await client.query(`select set_config('app.org_id', $1, true)`, [org.id]);
        await expect(
          client.query(`update quarantined_items set ${column} = ${column} where id = $1`, [id]),
        ).rejects.toThrow(/permission denied/);
        await client.query('rollback');
      }
      await client.query('begin');
      await client.query(`select set_config('app.org_id', $1, true)`, [org.id]);
      const ok = await client.query(`update quarantined_items set replayed_at = now() where id = $1`, [id]);
      expect(ok.rowCount).toBe(1);
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });

  it('another organization cannot be reached with this one’s item ID, and a reason is required', async () => {
    const { phone, shiftId } = await guardWithShift();
    const id = await quarantine(phone, startItem(shiftId));
    await expect(replayQuarantine(t.deps, other.id, { reason: REASON, id, limit: 1 })).rejects.toThrow(
      /no open quarantined item/,
    );
    await expect(replayQuarantine(t.deps, org.id, { reason: '  ', id, limit: 1 })).rejects.toThrow(
      /--reason/,
    );
    await expect(replayQuarantine(t.deps, randomUUID(), { reason: REASON, id, limit: 1 })).rejects.toThrow(
      /no organization/,
    );
    expect(await replayedAt(id)).toBeNull();
  });
});

describe('delivery health', () => {
  const insertDelivery = (
    orgId: string,
    fields: { channel: string; status: string; errorCode?: string; createdAgoMs?: number; phone?: string },
  ) =>
    asOwner(t.db, (c) =>
      c.query(
        `insert into notification_deliveries
           (id, organization_id, topic, channel, status, dedupe_key, max_attempts, next_attempt_at,
            title, body, error_code, recipient_phone, created_at)
         values ($1, $2, 'TEST', $3, $4, $5, 3, now(), 'Test', 'Test', $6, $7, $8)`,
        [
          randomUUID(),
          orgId,
          fields.channel,
          fields.status,
          randomUUID(),
          fields.errorCode ?? null,
          fields.phone ?? (fields.channel === 'SMS' ? '+923009998877' : null),
          new Date(t.clock.now().getTime() - (fields.createdAgoMs ?? MIN)),
        ],
      ),
    );

  it('counts this organization’s deliveries by channel, status and error code, and prints no phone number', async () => {
    for (let i = 0; i < 3; i++)
      await insertDelivery(org.id, { channel: 'SMS', status: 'SENT', phone: '+923001112233' });
    await insertDelivery(org.id, {
      channel: 'SMS',
      status: 'FAILED',
      errorCode: 'PROVIDER_ERROR',
      phone: '+923001112233',
    });
    await insertDelivery(org.id, { channel: 'SMS', status: 'SUPPRESSED', errorCode: 'THROTTLED' });
    await insertDelivery(org.id, { channel: 'SMS', status: 'SENT', createdAgoMs: 30 * H }); // outside 24 h
    await insertDelivery(other.id, { channel: 'SMS', status: 'FAILED', errorCode: 'OTHER_ORG' });

    const health = await deliveryHealth(t.deps, org.id, { hours: 24, reason: REASON });
    const key = (c: { channel: string; status: string; errorCode: string | null }) =>
      `${c.channel} ${c.status} ${c.errorCode ?? ''}`;
    expect(Object.fromEntries(health.counts.map((c) => [key(c), c.count]))).toMatchObject({
      'SMS SENT ': 3,
      'SMS FAILED PROVIDER_ERROR': 1,
      'SMS SUPPRESSED THROTTLED': 1,
    });
    const text = formatDeliveryHealth(health).join('\n');
    expect(text).toContain('PROVIDER_ERROR');
    expect(text).not.toContain('OTHER_ORG');
    expect(text).not.toContain('923001112233');
    expect(text).not.toContain('923009998877');
  });

  it('flags a stuck queue, a provider failing more than 5 %, and an SOS nobody has acknowledged', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const concerns = assessDeliveryHealth({
      now,
      oldestQueuedAt: ago(5 * MIN),
      counts: [
        { channel: 'SMS', status: 'SENT', errorCode: null, count: 80, isDrill: false },
        { channel: 'SMS', status: 'FAILED', errorCode: 'PROVIDER_ERROR', count: 20, isDrill: false },
        { channel: 'WEB_PUSH', status: 'FAILED', errorCode: 'X', count: 3, isDrill: false }, // too few to judge
        { channel: 'PUSH', status: 'FAILED', errorCode: 'X', count: 50, isDrill: true }, // drills don't count
      ],
      openSos: [
        { status: 'ACTIVE', isDrill: false, activatedAt: ago(12 * MIN), alertSent: false, notified: false },
        {
          status: 'ACKNOWLEDGED',
          isDrill: false,
          activatedAt: ago(40 * MIN),
          alertSent: true,
          notified: true,
        },
        { status: 'ACTIVE', isDrill: true, activatedAt: ago(40 * MIN), alertSent: false, notified: false },
      ],
    });
    expect(concerns).toHaveLength(3);
    expect(concerns[0]).toMatch(/waited 5 min in the queue/);
    expect(concerns[1]).toMatch(/SMS: 20 of 100 sends failed/);
    expect(concerns[2]).toMatch(
      /SOS has been open 12 min without acknowledgement \(alert sent: NO, shown to a person: NO\)/,
    );
    expect(assessDeliveryHealth({ now, oldestQueuedAt: null, counts: [], openSos: [] })).toEqual([]);
  });

  it('an open SOS in the database shows up with how far its alerting got', async () => {
    const { phone } = await guardWithShift();
    const guard = await asOwner(t.db, (c) =>
      c.query<{ guard_id: string }>('select guard_id from guard_devices where id = $1', [phone.deviceId]),
    );
    const activated = new Date(t.clock.now().getTime() - 15 * MIN);
    await asOwner(t.db, (c) =>
      c.query(
        `insert into sos_events (id, organization_id, guard_id, device_id, client_event_id, activated_at_recorded,
           activated_at, received_at, clock_status, last_triggered_at)
         values ($1, $2, $3, $4, $5, $6, $6, $6, 'DEVICE_CLOCK_ONLY', $6)`,
        [randomUUID(), org.id, guard.rows[0]?.guard_id, phone.deviceId, randomUUID(), activated],
      ),
    );
    const health = await deliveryHealth(t.deps, org.id, { hours: 1, reason: REASON });
    expect(health.concerns.some((c) => /SOS has been open 15 min without acknowledgement/.test(c))).toBe(
      true,
    );
    expect(formatDeliveryHealth(health).join('\n')).toMatch(
      /ACTIVE for 15 min · alert sent: no · shown to a person: no/,
    );
  });
});

describe('what the organization can see', () => {
  it('every look into the organization is a PLATFORM_ACCESS audit row with the reason, by the platform operator, with no data in it', async () => {
    const before = (await audit()).length;
    t.clock.advance(1_000);
    await deliveryHealth(t.deps, org.id, { hours: 6, reason: 'looking at SOS delivery for case 77' });
    t.clock.advance(1_000);
    await listQuarantine(t.deps, org.id, { reason: 'case 77', includeReplayed: true, limit: 10 });
    const rows = (await audit()).slice(before);
    expect(rows.map((r) => [r.actor_type, r.reason, r.metadata.command])).toEqual([
      ['PLATFORM_OPERATOR', 'looking at SOS delivery for case 77', 'delivery-health'],
      ['PLATFORM_OPERATOR', 'case 77', 'quarantine-list'],
    ]);
    // The organization's owner reads it in the dashboard's audit log.
    const res = await call(t.app, { method: 'GET', url: '/api/v1/audit-logs', cookie: owner, org: org.id });
    expect(res.statusCode).toBe(200);
    const listed = res.json<{ entries: { action: string; actorType: string }[] }>().entries;
    expect(listed.filter((e) => e.action === 'PLATFORM_ACCESS').length).toBeGreaterThanOrEqual(2);
    expect(listed.find((e) => e.action === 'PLATFORM_ACCESS')?.actorType).toBe('PLATFORM_OPERATOR');
    // The rows are in this organization's log only: the other organization's count did not move.
    const count = async (id: string) =>
      (
        await asOwner(t.db, (c) =>
          c.query(`select 1 from audit_logs where organization_id = $1 and action = 'PLATFORM_ACCESS'`, [id]),
        )
      ).rowCount;
    const otherBefore = await count(other.id);
    t.clock.advance(1_000);
    await deliveryHealth(t.deps, org.id, { hours: 1, reason: 'case 78' });
    expect(await count(other.id)).toBe(otherBefore);
  });
});

describe('the command line', () => {
  const ok = randomUUID();

  it('a look into an organization needs a valid organization ID and a reason; other commands need their own options', () => {
    for (const args of [
      ['delivery-health'],
      ['delivery-health', '--org', ok],
      ['delivery-health', '--reason', 'case 1'],
      ['delivery-health', '--org', ok, '--reason', '   '],
      ['quarantine-replay', '--org', 'not-a-uuid', '--reason', 'case 1'],
      ['quarantine-replay', '--org', ok, '--reason', 'case 1', '--id', 'nope'],
      ['create-organization', '--name', 'Alpha'],
      ['create-canary'],
      ['unknown-command'],
      [],
    ]) {
      expect(parseOperatorArgs(args), args.join(' ')).toBeNull();
    }
    expect(parseOperatorArgs(['delivery-health', '--org', ok, '--reason', 'case 1'])?.command).toBe(
      'delivery-health',
    );
    expect(
      parseOperatorArgs(['quarantine-replay', '--org', ok, '--reason', 'case 1', '--id', randomUUID()]),
    ).not.toBeNull();
    expect(
      parseOperatorArgs(['create-organization', '--name', 'Alpha', '--owner-email', 'o@alpha.test']),
    ).not.toBeNull();
  });

  it('the command prints its usage and exits 2 when the arguments are wrong, before any database is opened', () => {
    const cli = fileURLToPath(new URL('../src/cli/operator.ts', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'delivery-health'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: operator');
  }, 60_000);
});
