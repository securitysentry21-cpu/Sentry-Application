import type { NextConfig } from 'next';

import { NOTHING_POLICY, NOTHING_POLICY_PATHS } from './lib/csp';

// SEC §10 baseline headers on every response. The Content-Security-Policy needs a nonce per
// response, so proxy.ts sets it (lib/csp.ts, review L-01); X-Frame-Options covers the files the
// proxy skips, and the skipped paths that can answer with a page get a policy that allows nothing
// (review L-30).
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

// Review A-07: the dashboard and the API share one origin. In development Next proxies /api/* to
// the local API; in AWS the load balancer routes /api/* to the API service (ARCH §2).
const API_DEV_ORIGIN = process.env.API_DEV_ORIGIN ?? 'http://127.0.0.1:4000';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` otherwise writes its own AGENTS.md into the app. Agent instructions for this
  // repository live in CLAUDE.md, under the owner's control.
  agentRules: false,
  transpilePackages: ['@sentryops/contracts', '@sentryops/domain'],
  headers() {
    return Promise.resolve([
      { source: '/:path*', headers: securityHeaders },
      ...NOTHING_POLICY_PATHS.map((source) => ({
        source,
        headers: [{ key: 'Content-Security-Policy', value: NOTHING_POLICY }],
      })),
    ]);
  },
  rewrites() {
    return Promise.resolve(
      process.env.NODE_ENV === 'development'
        ? [{ source: '/api/:path*', destination: `${API_DEV_ORIGIN}/api/:path*` }]
        : [],
    );
  },
};

export default config;
