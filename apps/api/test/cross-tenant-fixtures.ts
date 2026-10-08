// ADV-A09: every mounted route must appear here, either naming the cross-tenant test that proves
// another organization's data cannot be reached through it, or stating why it holds no tenant
// data. Adding a route without an entry fails the meta-test.

type Coverage =
  | { readonly covered: 'test'; readonly test: string }
  | { readonly covered: 'no-tenant-data'; readonly reason: string };

export const CROSS_TENANT_FIXTURES: Readonly<Record<string, Coverage>> = {
  'GET /api/v1/health': { covered: 'no-tenant-data', reason: 'liveness probe; returns a constant' },
  'GET /api/v1/ready': { covered: 'no-tenant-data', reason: 'readiness probe; returns no data' },
};
