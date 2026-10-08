import { createPool } from '@sentryops/db';
import { FakeClock } from '@sentryops/domain';
import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { defineRoute, type RouteDefinition } from '../src/routes/registry.ts';
import { createDeps } from '../src/server.ts';
import { CROSS_TENANT_FIXTURES } from './cross-tenant-fixtures.ts';
import { NOW, testConfig, UNREACHABLE_DATABASE } from './support.ts';

// No route is called here, so the pool never connects.
const pool = createPool(UNREACHABLE_DATABASE);
const deps = createDeps(testConfig(UNREACHABLE_DATABASE), pool, { clock: new FakeClock(NOW), oidc: null });

afterAll(async () => {
  await pool.end();
});

describe('route registry (ARCH §4.6)', () => {
  it('ADV-A09 every mounted route has a policy and an entry in the cross-tenant fixture list', async () => {
    const app = buildApp(deps, { logger: false });
    try {
      if (process.env.NEGATIVE_CONTROL === 'route-without-policy') {
        // A handler added outside the registry, the way a hurried change might.
        app.get('/api/v1/unguarded', () => Promise.resolve({ leaked: true }));
      }
      await app.ready();
      expect(app.routeCatalog.length).toBeGreaterThan(0);
      for (const route of app.routeCatalog) {
        const key = `${route.method} ${route.url}`;
        expect(route.policy, `${key} has no policy`).toBeDefined();
        expect(
          CROSS_TENANT_FIXTURES[key],
          `${key} is missing from the cross-tenant fixture list`,
        ).toBeDefined();
      }
    } finally {
      await app.close();
    }
  });

  it('INV-12 the API refuses to mount a route that has no policy', async () => {
    const app = buildApp(deps, { logger: false });
    const attempt = async () => {
      app.get('/api/v1/unguarded', () => Promise.resolve({}));
      await app.ready();
    };
    try {
      await expect(attempt()).rejects.toThrow(/no route policy/);
    } finally {
      await app.close().catch(() => {});
    }
  });

  it('INV-12 defineRoute refuses a definition without a policy', () => {
    const withoutPolicy = {
      method: 'GET',
      url: '/api/v1/x',
      summary: 'x',
      responses: {},
      handler: () => Promise.resolve({}),
    } as unknown as RouteDefinition;
    expect(() => defineRoute(withoutPolicy)).toThrow(TypeError);
  });
});
