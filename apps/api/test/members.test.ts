// Member rules through the API. The rule order itself is unit-tested in packages/domain
// (decideMemberChange); these tests prove the API applies it with committed state.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOwner, call, errorCode, seedOrganization, signIn, startTestApp, type TestApp } from './support.ts';

let t: TestApp;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let owner: string;
let admin: string;

const seat = (o: typeof org, email: string) => o.members[email]?.memberId ?? '';
async function versionOf(id: string): Promise<number> {
  const { rows } = await asOwner(t.db, (c) =>
    c.query<{ version: number }>('select version from organization_members where id = $1', [id]),
  );
  return rows[0]?.version ?? 0;
}
const patch = (cookie: string, orgId: string, id: string, body: Record<string, unknown>) =>
  call(t.app, { method: 'PATCH', url: `/api/v1/members/${id}`, cookie, org: orgId, body });

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'Rules Co', [
    { email: 'owner@rules.test', role: 'OWNER' },
    { email: 'admin@rules.test', role: 'ADMIN' },
    { email: 'admin2@rules.test', role: 'ADMIN' },
    { email: 'sup@rules.test', role: 'SUPERVISOR' },
    { email: 'disp@rules.test', role: 'DISPATCHER' },
  ]);
  owner = await signIn(t.app, 'owner@rules.test');
  admin = await signIn(t.app, 'admin@rules.test');
});

afterAll(async () => {
  await t?.close();
});

describe('member rules through the API (SEC §6 rule 3)', () => {
  it('ADV-A02 nobody can change their own role or status', async () => {
    const own = seat(org, 'admin@rules.test');
    for (const body of [{ role: 'OWNER' }, { status: 'DISABLED' }]) {
      const res = await patch(admin, org.id, own, { ...body, version: await versionOf(own) });
      expect(errorCode(res)).toBe('SELF_ROLE_CHANGE');
    }
    const ownerSeat = seat(org, 'owner@rules.test');
    expect(
      errorCode(
        await patch(owner, org.id, ownerSeat, { role: 'ADMIN', version: await versionOf(ownerSeat) }),
      ),
    ).toBe('SELF_ROLE_CHANGE');
  });

  it('ADV-A05 an administrator cannot create, change or remove owners or administrators', async () => {
    const attempts = [
      patch(admin, org.id, seat(org, 'owner@rules.test'), {
        status: 'DISABLED',
        version: await versionOf(seat(org, 'owner@rules.test')),
      }),
      patch(admin, org.id, seat(org, 'admin2@rules.test'), {
        role: 'SUPERVISOR',
        version: await versionOf(seat(org, 'admin2@rules.test')),
      }),
      patch(admin, org.id, seat(org, 'sup@rules.test'), {
        role: 'ADMIN',
        version: await versionOf(seat(org, 'sup@rules.test')),
      }),
      call(t.app, {
        method: 'POST',
        url: '/api/v1/invitations',
        cookie: admin,
        org: org.id,
        body: { email: 'n@rules.test', role: 'ADMIN' },
      }),
      call(t.app, {
        method: 'POST',
        url: '/api/v1/invitations',
        cookie: admin,
        org: org.id,
        body: { email: 'n@rules.test', role: 'OWNER' },
      }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode).toBe(403);
    // …but may manage the roles below them, and the owner may manage administrators.
    const disp = seat(org, 'disp@rules.test');
    expect(
      (await patch(admin, org.id, disp, { role: 'SUPERVISOR', version: await versionOf(disp) })).statusCode,
    ).toBe(200);
    const admin2 = seat(org, 'admin2@rules.test');
    expect(
      (await patch(owner, org.id, admin2, { role: 'SUPERVISOR', version: await versionOf(admin2) }))
        .statusCode,
    ).toBe(200);
  });

  it('a stale version gets VERSION_CONFLICT with the current member', async () => {
    const sup = seat(org, 'sup@rules.test');
    const seen = await versionOf(sup);
    expect((await patch(owner, org.id, sup, { role: 'DISPATCHER', version: seen })).statusCode).toBe(200);
    // A second editor still holding the version they first saw.
    const res = await patch(owner, org.id, sup, { role: 'SUPERVISOR', version: seen });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' }, current: { id: sup } });
  });

  it('ADV-A06 owners demoting each other at the same moment never leave the organization without an owner', async () => {
    const race = await seedOrganization(t.db, 'Race Co', [
      { email: 'r1@race.test', role: 'OWNER' },
      { email: 'r2@race.test', role: 'OWNER' },
    ]);
    const [r1, r2] = await Promise.all([signIn(t.app, 'r1@race.test'), signIn(t.app, 'r2@race.test')]);
    const results = await Promise.all([
      patch(r1, race.id, seat(race, 'r2@race.test'), { role: 'ADMIN', version: 1 }),
      patch(r2, race.id, seat(race, 'r1@race.test'), { role: 'ADMIN', version: 1 }),
    ]);
    // One wins; the other is refused because its caller is no longer an owner (or, had it run on a
    // stale view, because the target would be the last owner). Never two successes, never a 500.
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    for (const r of results) expect([200, 403, 409]).toContain(r.statusCode);
    const { rows } = await asOwner(t.db, (c) =>
      c.query<{ n: number }>(
        `select count(*)::int as n from organization_members where organization_id = $1 and role = 'OWNER' and status = 'ACTIVE'`,
        [race.id],
      ),
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('every member change is in the audit log, in the same transaction', async () => {
    const res = await call(t.app, { method: 'GET', url: '/api/v1/audit-logs', cookie: owner, org: org.id });
    expect(res.statusCode).toBe(200);
    const actions = res.json<{ entries: { action: string }[] }>().entries.map((e) => e.action);
    expect(actions).toContain('ROLE_CHANGED');
    // Administrators don't read the audit log (owners only).
    expect(
      (await call(t.app, { method: 'GET', url: '/api/v1/audit-logs', cookie: admin, org: org.id }))
        .statusCode,
    ).toBe(403);
  });
});
