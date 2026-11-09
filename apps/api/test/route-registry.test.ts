import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';

import { createPool } from '@sentryops/db';
import { FakeClock } from '@sentryops/domain';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildApp } from '../src/app.ts';
import { loggerOptions } from '../src/logger.ts';
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

  it('ADV-A09 each cross-tenant fixture names test files that exist and an ID or a test title they hold (review L-08)', () => {
    const problems: string[] = [];
    for (const [route, coverage] of Object.entries(CROSS_TENANT_FIXTURES)) {
      if (coverage.covered !== 'test') {
        if (coverage.reason.trim().length < 15) problems.push(`${route}: say why it holds no tenant data`);
        continue;
      }
      const files = [...new Set(coverage.test.match(/[\w-]+\.test\.ts/g) ?? [])];
      const ids = [...new Set(coverage.test.match(/\b(?:ADV|INV)-[A-Z]*\d+\b/g) ?? [])];
      const titles = [...coverage.test.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
      if (files.length === 0) problems.push(`${route}: names no test file`);
      if (ids.length === 0 && titles.length === 0)
        problems.push(`${route}: cites no INV/ADV ID and quotes no test title`);
      const sources = files.map((file) => {
        try {
          return readFileSync(new URL(file, import.meta.url), 'utf8');
        } catch {
          problems.push(`${route}: ${file} does not exist`);
          return '';
        }
      });
      for (const id of ids) {
        if (!sources.some((source) => new RegExp(`\\b${id}\\b`).test(source))) {
          problems.push(`${route}: ${id} is not cited in ${files.join(' or ')}`);
        }
      }
      for (const title of titles) {
        if (!sources.some((source) => source.includes(title))) {
          problems.push(`${route}: no test in ${files.join(' or ')} is titled "${title}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('ADV-X05 every route returning guard coordinates is live-only or audited; no coordinate is untagged', () => {
    // A latitude and a longitude in one object: `lat`/`lng`, or with a prefix (`startLatitude`,
    // `endLng`), which the first version of this test could not see (review L-07).
    const COORDINATE_KEYS = [
      /^(lat|latitude)$|[a-z0-9](Lat|Latitude)$/,
      /^(lng|lon|longitude)$|[a-z0-9](Lng|Lon|Longitude)$/,
    ];
    type Node = { [key: string]: unknown };
    const found = {
      guardLocation: [] as string[],
      incidentLocation: [] as string[],
      untagged: [] as string[],
    };
    const walk = (node: unknown, key: string, tags: { guard: boolean; incident: boolean }) => {
      if (!node || typeof node !== 'object') return;
      const n = node as Node;
      const props = n.properties && typeof n.properties === 'object' ? Object.keys(n.properties) : [];
      // GeoJSON carries positions as [lng, lat] arrays under `coordinates`.
      const hasCoordinates =
        COORDINATE_KEYS.every((pattern) => props.some((k) => pattern.test(k))) ||
        props.includes('coordinates');
      if (hasCoordinates) {
        if (n.guardLocation === true) tags.guard = true;
        else if (n.incidentLocation === true) tags.incident = true;
        else if (n.siteGeometry !== true) found.untagged.push(key);
      }
      for (const value of Object.values(n)) walk(value, key, tags);
    };
    // Where a guard filed an incident is shown to whoever may see the incident (owner decision
    // 2026-11-02), and nowhere else: every incident permission belongs to a role that sees incidents.
    const isIncidentPermission = (permission: string) => permission.startsWith('incidents.');
    const routes =
      process.env.NEGATIVE_CONTROL === 'untagged-coordinate'
        ? [
            ...ROUTES,
            // A new response with a position nobody tagged (review L-18).
            defineRoute({
              method: 'GET',
              url: '/api/v1/planted/untagged',
              summary: 'negative control',
              policy: { access: { kind: 'public' }, ownership: 'none', rateLimit: 'none', audit: null },
              responses: { 200: z.object({ startLatitude: z.number(), startLongitude: z.number() }) },
              handler: () => Promise.resolve({ startLatitude: 0, startLongitude: 0 }),
            }),
          ]
        : ROUTES;
    for (const route of routes) {
      const key = `${route.method} ${route.url}`;
      const tags = { guard: false, incident: false };
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
      if (tags.incident) {
        found.incidentLocation.push(key);
        const access = route.policy.access;
        expect(
          access.kind === 'permission' && isIncidentPermission(access.permission),
          `${key} returns an incident's location: only routes that need an incident permission may`,
        ).toBe(true);
      }
    }
    expect(
      found.untagged,
      'coordinates in responses must be tagged GUARD_LOCATION, INCIDENT_LOCATION or SITE_GEOMETRY',
    ).toEqual([]);
    // The live snapshot carries guard positions and incident detail an incident's, so the checks
    // can't pass by finding nothing.
    expect(found.guardLocation).toContain('GET /api/v1/dashboard/snapshot');
    expect(found.guardLocation).toContain('GET /api/v1/sos/:id');
    expect(found.incidentLocation).toContain('GET /api/v1/incidents/:id');
  });

  it('ADV-X05 a handler that sends a coordinate its schema does not declare fails outside production (review L-07)', async () => {
    // The hurried change: a handler spreads a database row into its answer.
    const row = { id: 'guard-1', name: 'A guard', latitude: 24.8607, longitude: 67.0011 };
    const spreadRow = defineRoute({
      method: 'GET',
      url: '/api/v1/test-only/spread-row',
      summary: 'test only',
      policy: { access: { kind: 'public' }, ownership: 'none', rateLimit: 'none', audit: null },
      responses: { 200: z.object({ id: z.string(), name: z.string() }) },
      handler: () => Promise.resolve({ ...row }),
    });
    const answer = async (nodeEnv: 'test' | 'production') => {
      const config = { ...testConfig(UNREACHABLE_DATABASE), NODE_ENV: nodeEnv };
      const app = buildApp(createDeps(config, pool, { clock: new FakeClock(NOW), oidc: null }), {
        logger: false,
        extraRoutes: [spreadRow],
      });
      try {
        return await app.inject({ method: 'GET', url: '/api/v1/test-only/spread-row' });
      } finally {
        await app.close();
      }
    };
    const checked = await answer('test');
    expect(checked.statusCode).toBe(500);
    expect(checked.body).not.toContain('24.8607');
    // Production never fails a response (an SOS must not turn into a 500), but since the owner's
    // decision Q6 it drops what the schema does not declare.
    const production = await answer('production');
    expect(production.statusCode).toBe(200);
    expect(production.json()).toEqual({ id: 'guard-1', name: 'A guard' });
  });

  it('ADV-X05 in production a response keeps only what its schema declares, strict or not, at any depth; a mismatch is sent as it is and logged, never a 500 (owner decision Q6)', async () => {
    const coordinates = { latitude: 24.8607, longitude: 67.0011 };
    const routes = [
      defineRoute({
        method: 'GET',
        url: '/api/v1/test-only/strict',
        summary: 'test only',
        policy: { access: { kind: 'public' }, ownership: 'none', rateLimit: 'none', audit: null },
        responses: {
          200: z.strictObject({
            id: z.string(),
            guards: z.array(z.strictObject({ id: z.string(), shift: z.object({ status: z.string() }) })),
          }),
        },
        handler: () =>
          Promise.resolve({
            id: 'site-1',
            ...coordinates,
            guards: [{ id: 'guard-1', phone: '+923001234567', shift: { status: 'ACTIVE', ...coordinates } }],
          }),
      }),
      defineRoute({
        method: 'GET',
        url: '/api/v1/test-only/wrong-type',
        summary: 'test only',
        policy: { access: { kind: 'public' }, ownership: 'none', rateLimit: 'none', audit: null },
        responses: { 200: z.object({ id: z.string(), count: z.int() }) },
        handler: () => Promise.resolve({ id: 'x', count: 'many' }),
      }),
    ];
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        done();
      },
    });
    const config = { ...testConfig(UNREACHABLE_DATABASE), NODE_ENV: 'production' as const };
    const app = buildApp(createDeps(config, pool, { clock: new FakeClock(NOW), oidc: null }), {
      logger: { ...loggerOptions('info'), stream: sink },
      extraRoutes: routes,
    });
    try {
      const strict = await app.inject({ method: 'GET', url: '/api/v1/test-only/strict' });
      expect(strict.statusCode).toBe(200);
      expect(strict.json()).toEqual({
        id: 'site-1',
        guards: [{ id: 'guard-1', shift: { status: 'ACTIVE' } }],
      });

      const wrong = await app.inject({ method: 'GET', url: '/api/v1/test-only/wrong-type' });
      expect(wrong.statusCode).toBe(200);
      expect(wrong.json()).toEqual({ id: 'x', count: 'many' });
    } finally {
      await app.close();
    }
    const mismatches = lines.filter((line) => line.includes('response-mismatch'));
    expect(
      mismatches.some((l) => l.includes('/api/v1/test-only/strict') && l.includes('undeclared keys dropped')),
    ).toBe(true);
    expect(mismatches.some((l) => l.includes('/api/v1/test-only/wrong-type') && l.includes('$.count'))).toBe(
      true,
    );
    // The log names paths, never a value.
    for (const line of mismatches) {
      for (const value of ['24.8607', '67.0011', '923001234567', 'many']) expect(line).not.toContain(value);
    }
  });

  it('INV-15 the WAF skips exactly the guard’s SOS routes: every policy.sos route, and nothing else (review L-28)', async () => {
    // infra/terraform/cell/edge.tf: the pattern every managed rule group's scope-down skips.
    const edge = readFileSync(new URL('../../../infra/terraform/cell/edge.tf', import.meta.url), 'utf8');
    const source = /sos_guard_paths\s*=\s*"([^"]+)"/.exec(edge)?.[1];
    expect(source, 'edge.tf defines sos_guard_paths').toBeDefined();
    const exempt = new RegExp(source ?? '(?!)');

    const app = buildApp(deps, { logger: false });
    try {
      await app.ready();
      const id = '0196f3a2-7c41-7d2e-9b1a-3f2e4d5c6b7a';
      let sosRoutes = 0;
      for (const route of app.routeCatalog) {
        for (const sample of [id, id.toUpperCase()]) {
          const path = route.url.replace(/:[A-Za-z]+/g, sample);
          if (route.policy?.sos) {
            expect(exempt.test(path), `${route.method} ${path} (an SOS route) must skip the WAF`).toBe(true);
          } else {
            expect(exempt.test(path), `${route.method} ${path} must stay behind the WAF`).toBe(false);
          }
        }
        if (route.policy?.sos) sosRoutes += 1;
      }
      expect(sosRoutes).toBeGreaterThanOrEqual(4);
      // Paths that are no route at all stay inspected too.
      for (const path of [
        '/api/v1/sos/',
        '/api/v1/sosx',
        `/api/v1/sos/${id}`,
        `/api/v1/sos/${id}/status/extra`,
        `/api/v1/sos/${id}/locations/../../../guards`,
        '/api/v1/sos-drills/current',
      ]) {
        expect(exempt.test(path), `${path} must stay behind the WAF`).toBe(false);
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
