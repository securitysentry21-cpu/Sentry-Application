// SEC §10, review L-01: the dashboard's Content-Security-Policy, and that every page gets it.
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import {
  contentSecurityPolicy,
  MAP_TILE_ORIGIN,
  NEVER_A_PAGE_PATHS,
  newNonce,
  NOTHING_POLICY,
  NOTHING_POLICY_PATHS,
} from '../lib/csp';
import { MAP_STYLE_URL } from '../lib/map-sources';
import nextConfig from '../next.config';
import { config, proxy } from '../proxy';

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );
}

describe('SEC §10 the dashboard Content-Security-Policy', () => {
  const production = directives(contentSecurityPolicy({ nonce: NONCE, development: false }));

  it('runs scripts only with the response nonce: nothing inline, no eval', () => {
    expect(production.get('script-src')).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
    expect(production.get('default-src')).toEqual(["'self'"]);
    for (const [name, values] of production) {
      if (name === 'style-src') continue; // inline styles cannot run code (lib/csp.ts)
      expect(values, name).not.toContain("'unsafe-inline'");
      expect(values, name).not.toContain("'unsafe-eval'");
    }
  });

  it('blocks plugins, <base>, framing and foreign form targets', () => {
    expect(production.get('object-src')).toEqual(["'none'"]);
    expect(production.get('base-uri')).toEqual(["'none'"]);
    expect(production.get('frame-ancestors')).toEqual(["'none'"]);
    expect(production.get('frame-src')).toEqual(["'none'"]);
    expect(production.get('form-action')).toEqual(["'self'"]);
    expect(production.has('upgrade-insecure-requests')).toBe(true);
  });

  it('reaches only its own origin and the map tile host it uses', () => {
    expect(MAP_TILE_ORIGIN).toBe(new URL(MAP_STYLE_URL).origin);
    expect(production.get('connect-src')).toEqual(["'self'", MAP_TILE_ORIGIN]);
    // MapLibre's worker and the push service worker are the dashboard's own files.
    expect(production.get('worker-src')).toEqual(["'self'"]);
    for (const [name, values] of production) {
      expect(
        values.some((v) => v.includes('*')),
        `${name} has a wildcard`,
      ).toBe(false);
      expect(values, name).not.toContain('https:');
    }
  });

  it('allows photos from the photo bucket, and only a plain https origin', () => {
    const bucket = 'https://sentry-test-attachments.s3.ap-southeast-2.amazonaws.com';
    const withBucket = directives(
      contentSecurityPolicy({ nonce: NONCE, development: false, photoOrigin: bucket }),
    );
    expect(withBucket.get('img-src')).toEqual(["'self'", 'data:', 'blob:', bucket]);
    for (const bad of [
      'https://*.amazonaws.com',
      'http://bucket.s3.amazonaws.com',
      "https://x.example; script-src 'unsafe-inline'",
      'https://x.example/path',
      '',
    ]) {
      const policy = contentSecurityPolicy({ nonce: NONCE, development: false, photoOrigin: bad });
      expect(directives(policy).get('img-src'), bad).toEqual(["'self'", 'data:', 'blob:']);
    }
  });

  it('adds eval only for `next dev`, and refuses a nonce that is not base64', () => {
    const dev = directives(contentSecurityPolicy({ nonce: NONCE, development: true }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    expect(dev.has('upgrade-insecure-requests')).toBe(false);
    expect(() => contentSecurityPolicy({ nonce: "x' 'unsafe-inline", development: false })).toThrow();
  });

  it('gives each response a new nonce', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe('SEC §10 proxy.ts puts the policy on every page', () => {
  it('sets it on the response and on the request Next renders from (where it reads the nonce)', () => {
    const first = proxy(new NextRequest('http://127.0.0.1:3000/dashboard'));
    const policy = first.headers.get('content-security-policy') ?? '';
    expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    const second = proxy(new NextRequest('http://127.0.0.1:3000/dashboard'));
    expect(second.headers.get('content-security-policy')).not.toBe(policy);
  });

  it('runs on pages and both workers, not on the API or hashed static files', () => {
    const [source] = config.matcher;
    const matches = (path: string) => new RegExp(`^${source}$`).test(path);
    for (const path of [
      '/',
      '/dashboard',
      '/sign-in',
      '/sos/0192',
      '/sw.js',
      '/maplibre/maplibre-gl-worker.mjs',
    ]) {
      expect(matches(path), path).toBe(true);
    }
    for (const path of ['/api/v1/me', '/_next/static/chunks/main.js', '/_next/image', '/favicon.ico']) {
      expect(matches(path), path).toBe(false);
    }
  });

  it('gives every path it skips a policy too, or a reason it never serves a page (review L-30)', async () => {
    // The matcher's exclusions, as written: /((?!a|b|c).*)
    const [source = ''] = config.matcher;
    const skipped = /\(\?!([^)]*)\)/.exec(source)?.[1]?.split('|') ?? [];
    expect(skipped.length).toBeGreaterThan(0);
    const covered = [...NOTHING_POLICY_PATHS, ...NEVER_A_PAGE_PATHS].map((p) => p.slice(1));
    expect([...skipped].sort()).toEqual([...covered].sort());

    // next.config.ts sends the policy that allows nothing on each path that can answer with a page.
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const path of NOTHING_POLICY_PATHS) {
      const rule = rules.find((r) => r.source === path);
      expect(rule?.headers.find((h) => h.key.toLowerCase() === 'content-security-policy')?.value, path).toBe(
        NOTHING_POLICY,
      );
    }
    expect(directives(NOTHING_POLICY).get('default-src')).toEqual(["'none'"]);
    expect(directives(NOTHING_POLICY).get('frame-ancestors')).toEqual(["'none'"]);
  });
});
