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

/** Creates a resource in organization B for each `:id` route; returns its id. */
const CROSS_TENANT_RESOURCES: Record<string, () => Promise<string>> = {
  'PATCH /api/v1/members/:id': () => Promise.resolve(orgB.members['admin@b.test']?.memberId ?? ''),
  'POST /api/v1/invitations/:id/revoke': async () => {
    const id = randomUUID();
    await asOwner(t.db, (c) =>
      c.query(
        `insert into invitations (id, organization_id, purpose, role, email, token_hash, expires_at)
         values ($1, $2, 'MEMBER', 'SUPERVISOR', 'x@b.test', $3, now() + interval '7 days')`,
        [id, orgB.id, randomBytes(32)],
      ),
    );
    return id;
  },
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
      const factory = CROSS_TENANT_RESOURCES[key];
      expect(factory, `${key} needs a cross-tenant resource factory in tenancy.test.ts`).toBeDefined();
      const id = await factory!();
      const res = await call(t.app, {
        method: route.method as 'GET',
        url: route.url.replace(':id', id),
        cookie: ownerA,
        org: orgA.id,
        body: route.method === 'GET' ? undefined : { role: 'SUPERVISOR', status: 'DISABLED', version: 1 },
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
