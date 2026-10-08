import { createPool } from '@sentryops/db';
import { FakeClock } from '@sentryops/domain';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildApp } from '../src/app.ts';
import { ROUTES } from '../src/routes/index.ts';
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

  it('ADV-X05 every route returning guard coordinates is live-only or audited; no coordinate is untagged', () => {
    const COORDINATE_KEYS = [
      ['lat', 'latitude'],
      ['lng', 'lon', 'longitude'],
    ];
    type Node = { [key: string]: unknown };
    const found = { guardLocation: [] as string[], untagged: [] as string[] };
    const walk = (node: unknown, key: string, tags: { guard: boolean }) => {
      if (!node || typeof node !== 'object') return;
      const n = node as Node;
      const props = n.properties && typeof n.properties === 'object' ? Object.keys(n.properties) : [];
      const hasCoordinates = COORDINATE_KEYS.every((names) => names.some((k) => props.includes(k)));
      if (hasCoordinates) {
        if (n.guardLocation === true) tags.guard = true;
        else if (n.siteGeometry !== true) found.untagged.push(key);
      }
      for (const value of Object.values(n)) walk(value, key, tags);
    };
    for (const route of ROUTES) {
      const key = `${route.method} ${route.url}`;
      const tags = { guard: false };
      for (const schema of Object.values(route.responses)) {
        walk(z.toJSONSchema(schema, { unrepresentable: 'any' }), key, tags);
      }
      if (tags.guard) {
        found.guardLocation.push(key);
        expect(
          route.policy.locationScope === 'live' || route.policy.audit !== null,
          `${key} returns guard coordinates: declare locationScope 'live' or an audit action`,
        ).toBe(true);
      }
    }
    expect(found.untagged, 'coordinates in responses must be tagged GUARD_LOCATION or SITE_GEOMETRY').toEqual(
      [],
    );
    // The live snapshot carries guard positions, so the check can't pass by finding nothing.
    expect(found.guardLocation).toContain('GET /api/v1/dashboard/snapshot');
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
