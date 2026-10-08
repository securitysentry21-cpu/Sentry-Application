import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionOrganization } from '../src/provisioning.ts';
import { call, errorCode, seedOrganization, signIn, startTestApp, type TestApp } from './support.ts';

let t: TestApp;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let owner: string;

const tokenOf = (acceptUrl: string) => new URL(acceptUrl).hash.replace('#token=', '');
async function invite(email: string, role = 'SUPERVISOR') {
  const res = await call(t.app, {
    method: 'POST',
    url: '/api/v1/invitations',
    cookie: owner,
    org: org.id,
    body: { email, role },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ invitation: { id: string; status: string }; acceptUrl: string }>();
}

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'Invite Co', [{ email: 'owner@invite.test', role: 'OWNER' }]);
  owner = await signIn(t.app, 'owner@invite.test');
});

afterAll(async () => {
  await t?.close();
});

describe('member invitations (SEC §5)', () => {
  it('the link carries the token in the fragment, so it never reaches a server log', async () => {
    const { acceptUrl, invitation } = await invite('frag@invite.test');
    expect(acceptUrl).toMatch(/^http:\/\/127\.0\.0\.1:3000\/invite#token=[A-Za-z0-9_-]{43}$/);
    expect(invitation.status).toBe('PENDING');
  });

  it('the invited person accepts once; the link is single use', async () => {
    const { acceptUrl } = await invite('sup@invite.test');
    const invitee = await signIn(t.app, 'sup@invite.test');
    const accept = () =>
      call(t.app, {
        method: 'POST',
        url: '/api/v1/invitations/accept',
        cookie: invitee,
        body: { token: tokenOf(acceptUrl) },
      });
    const first = await accept();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ organizationId: org.id, role: 'SUPERVISOR' });
    const me = await call(t.app, { method: 'GET', url: '/api/v1/me', cookie: invitee });
    expect(
      me.json<{ memberships: { organizationId: string }[] }>().memberships.map((m) => m.organizationId),
    ).toContain(org.id);
    expect(errorCode(await accept())).toBe('INVITATION_EXPIRED');
  });

  it('someone else holding the link cannot use it', async () => {
    const { acceptUrl } = await invite('right@invite.test');
    const wrong = await signIn(t.app, 'wrong@invite.test');
    const res = await call(t.app, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      cookie: wrong,
      body: { token: tokenOf(acceptUrl) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a revoked or expired invitation cannot be accepted', async () => {
    const revoked = await invite('revoked@invite.test');
    expect(
      (
        await call(t.app, {
          method: 'POST',
          url: `/api/v1/invitations/${revoked.invitation.id}/revoke`,
          cookie: owner,
          org: org.id,
        })
      ).statusCode,
    ).toBe(200);
    const person = await signIn(t.app, 'revoked@invite.test');
    expect(
      errorCode(
        await call(t.app, {
          method: 'POST',
          url: '/api/v1/invitations/accept',
          cookie: person,
          body: { token: tokenOf(revoked.acceptUrl) },
        }),
      ),
    ).toBe('INVITATION_EXPIRED');

    const old = await invite('late@invite.test');
    t.clock.advance(8 * 24 * 60 * 60 * 1000);
    const late = await signIn(t.app, 'late@invite.test');
    expect(
      errorCode(
        await call(t.app, {
          method: 'POST',
          url: '/api/v1/invitations/accept',
          cookie: late,
          body: { token: tokenOf(old.acceptUrl) },
        }),
      ),
    ).toBe('INVITATION_EXPIRED');
  });

  it('operator provisioning (D-19): a new organization whose first owner joins through the link', async () => {
    const created = await provisionOrganization(t.deps, {
      name: 'Pilot Security',
      timezone: 'Asia/Karachi',
      ownerEmail: 'founder@pilot.test',
    });
    const founder = await signIn(t.app, 'founder@pilot.test');
    const accepted = await call(t.app, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      cookie: founder,
      body: { token: tokenOf(created.acceptUrl) },
    });
    expect(accepted.json()).toMatchObject({ organizationId: created.organizationId, role: 'OWNER' });
    const audit = await call(t.app, {
      method: 'GET',
      url: '/api/v1/audit-logs',
      cookie: founder,
      org: created.organizationId,
    });
    const actions = audit.json<{ entries: { action: string; actorType: string }[] }>().entries;
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'ORGANIZATION_CREATED', actorType: 'PLATFORM_OPERATOR' }),
        expect.objectContaining({ action: 'INVITATION_ACCEPTED', actorType: 'USER' }),
      ]),
    );
    await expect(
      provisionOrganization(t.deps, {
        name: 'Bad Zone',
        timezone: 'Mars/Olympus',
        ownerEmail: 'x@pilot.test',
      }),
    ).rejects.toThrow(/unknown timezone/);
  });

  it('an unknown token reveals nothing', async () => {
    const someone = await signIn(t.app, 'guess@invite.test');
    const res = await call(t.app, {
      method: 'POST',
      url: '/api/v1/invitations/accept',
      cookie: someone,
      body: { token: 'A'.repeat(43) },
    });
    expect(errorCode(res)).toBe('INVITATION_EXPIRED');
  });
});
