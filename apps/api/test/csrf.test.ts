import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorCode, seedOrganization, signIn, startTestApp, type TestApp } from './support.ts';

let t: TestApp;
let cookie: string;
let orgId: string;

beforeAll(async () => {
  t = await startTestApp();
  const org = await seedOrganization(t.db, 'CSRF Co', [{ email: 'owner@csrf.test', role: 'OWNER' }]);
  orgId = org.id;
  cookie = await signIn(t.app, 'owner@csrf.test');
});

afterAll(async () => {
  await t?.close();
});

const invite = (headers: Record<string, string>) =>
  t.app.inject({
    method: 'POST',
    url: '/api/v1/invitations',
    headers: { cookie, 'x-organization-id': orgId, 'content-type': 'application/json', ...headers },
    payload: { email: 'new@csrf.test', role: 'SUPERVISOR' },
  });

describe('cross-site request forgery (SEC §10)', () => {
  it('ADV-W03 a cross-site state-changing request is blocked', async () => {
    // A forged form post or image carries the cookie but cannot add the custom header.
    const forged = await invite({});
    expect(forged.statusCode).toBe(403);
    expect(errorCode(forged)).toBe('FORBIDDEN');
    // A page on another origin, even with the header (which would need a CORS preflight we never grant).
    expect((await invite({ 'x-sentry-csrf': '1', origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await invite({ 'x-sentry-csrf': '1', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
  });

  it('ADV-W03 the dashboard itself, same origin with the header, gets through', async () => {
    const res = await invite({
      'x-sentry-csrf': '1',
      origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'same-origin',
    });
    expect(res.statusCode).toBe(201);
  });

  it('the API never grants a CORS preflight', async () => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/invitations',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
