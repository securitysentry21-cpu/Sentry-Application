import type { NextConfig } from 'next';

// SEC §10 baseline headers. A strict Content-Security-Policy with nonces arrives with the first
// real screens (Phase 1); until then this blocks framing, sniffing and referrer leaks.
const securityHeaders = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
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
    return Promise.resolve([{ source: '/:path*', headers: securityHeaders }]);
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
