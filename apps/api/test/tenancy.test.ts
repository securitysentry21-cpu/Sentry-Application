// Tenant isolation through the API (SEC §4, ARCH §4.1). ADV-T01 is generated: every mounted route
// with an `:id` must have a resource factory below, so a new route can't skip the check.
import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asOwner, call, errorCode, seedOrganization, signIn, startTestApp, type TestApp } from './support.ts';

let t: TestApp;
let orgA: Awaited<ReturnType<typeof seedOrganization>>;
let orgB: Awaited<ReturnType<typeof seedOrganization>>;
let ownerA: string;
let both: string;

/**
 * For each `:id` route: a resource in organization B and a body that passes validation, so the
 * request reaches the ownership check (a malformed body would answer 400 before it).
 */
type Probe = { id: () => Promise<string>; body?: Record<string, unknown> };

async function seedB(sql: string, params: unknown[]): Promise<void> {
  await asOwner(t.db, (c) => c.query(sql, params));
}

const B: { guard: string; device: string; site: string; checkpoint: string } = {
  guard: randomUUID(),
  device: randomUUID(),
  site: randomUUID(),
  checkpoint: randomUUID(),
};

async function seedBResources(): Promise<void> {
  await seedB(
    `insert into guards (id, organization_id, employee_number, display_name, phone) values ($1, $2, 'B-1', 'Bravo guard', '+923009990001')`,
    [B.guard, orgB.id],
  );
  await seedB(
    `insert into guard_devices (id, organization_id, guard_id, installation_id, public_key, key_algorithm, platform)
     values ($1, $2, $3, $4, gen_random_bytes(91), 'ECDSA_P256_SHA256', 'ANDROID')`,
    [B.device, orgB.id, B.guard, randomUUID()],
  );
  await seedB(
    `insert into sites (id, organization_id, name, timezone, boundary_kind, latitude, longitude, geofence_radius_meters)
     values ($1, $2, 'Bravo gate', 'Asia/Karachi', 'CIRCLE', 31.5, 74.3, 100)`,
    [B.site, orgB.id],
  );
  await seedB(
    `insert into checkpoints (id, organization_id, site_id, name, qr_token_hash) values ($1, $2, $3, 'B door', $4)`,
    [B.checkpoint, orgB.id, B.site, randomBytes(32)],
  );
}

const fixed =
  (value: () => string): (() => Promise<string>) =>
  () =>
    Promise.resolve(value());

const CROSS_TENANT_RESOURCES: Record<string, Probe> = {
  'PATCH /api/v1/members/:id': {
    id: fixed(() => orgB.members['admin@b.test']?.memberId ?? ''),
    body: { role: 'SUPERVISOR', version: 1 },
  },
  'POST /api/v1/invitations/:id/revoke': {
    id: async () => {
      const id = randomUUID();
      await seedB(
        `insert into invitations (id, organization_id, purpose, role, email, token_hash, expires_at)
         values ($1, $2, 'MEMBER', 'SUPERVISOR', 'x@b.test', $3, now() + interval '7 days')`,
        [id, orgB.id, randomBytes(32)],
      );
      return id;
    },
  },
  'GET /api/v1/guards/:id': { id: fixed(() => B.guard) },
  'PATCH /api/v1/guards/:id': { id: fixed(() => B.guard), body: { displayName: 'Changed', version: 1 } },
  'POST /api/v1/guards/:id/terminate': { id: fixed(() => B.guard) },
  'POST /api/v1/guards/:id/enrollment-codes': { id: fixed(() => B.guard) },
  'GET /api/v1/guards/:id/devices': { id: fixed(() => B.guard) },
  'POST /api/v1/devices/:id/revoke': { id: fixed(() => B.device), body: { reason: 'LOST' } },
  'GET /api/v1/sites/:id': { id: fixed(() => B.site) },
  'PATCH /api/v1/sites/:id': { id: fixed(() => B.site), body: { name: 'Changed', version: 1 } },
  'GET /api/v1/sites/:id/checkpoints': { id: fixed(() => B.site) },
  'POST /api/v1/sites/:id/checkpoints': { id: fixed(() => B.site), body: { name: 'Sneaky' } },
  'GET /api/v1/sites/:id/checkpoints/print-sheet': { id: fixed(() => B.site) },
  'PATCH /api/v1/checkpoints/:id': { id: fixed(() => B.checkpoint), body: { name: 'Changed', version: 1 } },
  'POST /api/v1/checkpoints/:id/rotate-qr': { id: fixed(() => B.checkpoint) },
};
beforeAll(async () => {
  t = await startTestApp();
  orgA = await seedOrganization(t.db, 'Alpha Security', [
    { email: 'owner@a.test', role: 'OWNER' },
    { email: 'both@example.test', role: 'ADMIN' },
  ]);
  orgB = await seedOrganization(t.db, 'Bravo Security', [
    { email: 'owner@b.test', role: 'OWNER' },
    { email: 'admin@b.test', role: 'ADMIN' },
    { email: 'both@example.test', role: 'DISPATCHER' },
  ]);
  await seedBResources();
  ownerA = await signIn(t.app, 'owner@a.test');
  both = await signIn(t.app, 'both@example.test');
});

afterAll(async () => {
  await t?.close();
});

describe('organization context (INV-01, INV-17)', () => {
  it('ADV-T09 X-Organization-Id naming an organization without a membership is refused', async () => {
    for (const org of [orgB.id, randomUUID(), 'not-a-uuid']) {
      const res = await call(t.app, { method: 'GET', url: '/api/v1/members', cookie: ownerA, org });
      expect(res.statusCode, org).toBe(403);
      expect(errorCode(res)).toBe('FORBIDDEN');
    }
  });

  it('a user in two organizations must choose one; each choice sees only its own data', async () => {
    const none = await call(t.app, { method: 'GET', url: '/api/v1/members', cookie: both });
    expect(errorCode(none)).toBe('ORG_CONTEXT_REQUIRED');
    // ADMIN in A may list members; DISPATCHER in B may not — the role follows the organization.
    const inA = await call(t.app, { method: 'GET', url: '/api/v1/members', cookie: both, org: orgA.id });
    expect(inA.statusCode).toBe(200);
    const emails = inA.json<{ members: { email: string }[] }>().members.map((m) => m.email);
    expect(emails).not.toContain('owner@b.test');
    const inB = await call(t.app, { method: 'GET', url: '/api/v1/members', cookie: both, org: orgB.id });
    expect(inB.statusCode).toBe(403);
  });

  it('a suspended organization is closed to the dashboard', async () => {
    const org = await seedOrganization(t.db, 'Suspended Co', [{ email: 'owner@susp.test', role: 'OWNER' }]);
    await asOwner(t.db, (c) =>
      c.query(`update organizations set status = 'SUSPENDED' where id = $1`, [org.id]),
    );
    const cookie = await signIn(t.app, 'owner@susp.test');
    expect(errorCode(await call(t.app, { method: 'GET', url: '/api/v1/members', cookie, org: org.id }))).toBe(
      'ORG_SUSPENDED',
    );
  });
});

describe('cross-tenant resources (SEC §4.2 rule 4)', () => {
  it("ADV-T01 every route with an :id answers 404 for another organization's resource", async () => {
    const idRoutes = t.app.routeCatalog.filter((r) => r.url.includes(':id'));
    expect(idRoutes.length).toBeGreaterThan(0);
    for (const route of idRoutes) {
      const key = `${route.method} ${route.url}`;
      const probe = CROSS_TENANT_RESOURCES[key];
      expect(probe, `${key} needs a cross-tenant probe in tenancy.test.ts`).toBeDefined();
      if (!probe) continue;
      const id = await probe.id();
      const res = await call(t.app, {
        method: route.method as 'GET',
        url: route.url.replace(':id', id),
        cookie: ownerA,
        org: orgA.id,
        body: probe.body,
      });
      expect(res.statusCode, key).toBe(404);
      expect(errorCode(res), key).toBe('NOT_FOUND');
    }
  });

  it("ADV-T01 lists never contain another organization's rows", async () => {
    const members = await call(t.app, {
      method: 'GET',
      url: '/api/v1/members',
      cookie: ownerA,
      org: orgA.id,
    });
    const memberIds = members.json<{ members: { id: string }[] }>().members.map((m) => m.id);
    for (const b of Object.values(orgB.members)) expect(memberIds).not.toContain(b.memberId);
    const invitations = await call(t.app, {
      method: 'GET',
      url: '/api/v1/invitations',
      cookie: ownerA,
      org: orgA.id,
    });
    expect(
      invitations.json<{ invitations: { email: string }[] }>().invitations.map((i) => i.email),
    ).not.toContain('x@b.test');
  });

  it('ADV-A10 identity fields in a body are rejected, never applied', async () => {
    const target = orgA.members['both@example.test']?.memberId ?? '';
    const res = await call(t.app, {
      method: 'PATCH',
      url: `/api/v1/members/${target}`,
      cookie: ownerA,
      org: orgA.id,
      body: { role: 'SUPERVISOR', version: 1, organizationId: orgB.id },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
  });
});
