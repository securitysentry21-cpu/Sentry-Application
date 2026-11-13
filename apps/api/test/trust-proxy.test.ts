// Review L-06, SEC §9 and §17.2: the client's address is the one the load balancer saw, not one the
// client wrote into X-Forwarded-For. Per-IP limits (sign-in, enrollment) and the IP kept in sessions
// and audit rows depend on it.
import { createPool } from '@sentryops/db';
import { FakeClock } from '@sentryops/domain';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createDeps } from '../src/server.ts';
import { NOW, testConfig, UNREACHABLE_DATABASE } from './support.ts';

const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x', CELL_REGION: 'eu-central-1' };

describe('TRUST_PROXY', () => {
  it('takes proxy addresses or ranges, or "false", and never "true"', () => {
    expect(loadConfig(base).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.20.0.0/16' }).TRUST_PROXY).toBe('10.20.0.0/16');
    expect(loadConfig({ ...base, TRUST_PROXY: ' 10.20.0.0/16 , fd00::/8 ' }).TRUST_PROXY).toBe(
      '10.20.0.0/16,fd00::/8',
    );
    for (const bad of ['true', '1', '*', '10.20.0.0/16,true', 'loadbalancer']) {
      expect(() => loadConfig({ ...base, TRUST_PROXY: bad }), bad).toThrow(/TRUST_PROXY/);
    }
  });
});

async function seenIp(
  trustProxy: false | string,
  remoteAddress: string,
  forwardedFor: string,
): Promise<string> {
  const pool = createPool(UNREACHABLE_DATABASE);
  const app = buildApp(
    createDeps(testConfig(UNREACHABLE_DATABASE, { TRUST_PROXY: trustProxy }), pool, {
      clock: new FakeClock(NOW),
      oidc: null,
    }),
  );
  let ip = '';
  app.addHook('onRequest', (request, _reply, done) => {
    ip = request.ip;
    done();
  });
  try {
    await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      remoteAddress,
      headers: { 'x-forwarded-for': forwardedFor },
    });
  } finally {
    await app.close();
    await pool.end();
  }
  return ip;
}

describe('the client address behind the load balancer (review L-06)', () => {
  // The client wrote 198.51.100.7; the load balancer appended the address it saw, 203.0.113.9.
  const forwarded = '198.51.100.7, 203.0.113.9';

  it('is the address the load balancer saw, whatever the client wrote before it', async () => {
    expect(await seenIp('10.20.0.0/16', '10.20.5.6', forwarded)).toBe('203.0.113.9');
    expect(
      await seenIp('10.20.0.0/16', '10.20.5.6', `192.0.2.${Math.floor(Math.random() * 200)}, 203.0.113.9`),
    ).toBe('203.0.113.9');
  });

  it('passes through CloudFront in front of the load balancer (both in the VPC range)', async () => {
    // Viewer → CloudFront (adds the viewer) → VPC origin ENI → load balancer (adds the ENI) → API.
    expect(await seenIp('10.20.0.0/16', '10.20.5.6', '198.51.100.7, 203.0.113.9, 10.20.9.9')).toBe(
      '203.0.113.9',
    );
  });

  it('believes no header from a connection that is not a trusted proxy', async () => {
    expect(await seenIp('10.20.0.0/16', '203.0.113.50', forwarded)).toBe('203.0.113.50');
    expect(await seenIp(false, '10.20.5.6', forwarded)).toBe('10.20.5.6');
  });
});
