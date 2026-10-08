// ADV-A09: every mounted route must appear here, either naming the cross-tenant test that proves
// another organization's data cannot be reached through it, or stating why it holds no tenant
// data. Adding a route without an entry fails the meta-test.

type Coverage =
  | { readonly covered: 'test'; readonly test: string }
  | { readonly covered: 'no-tenant-data'; readonly reason: string };

const T01 = {
  covered: 'test',
  test: 'tenancy.test.ts › ADV-T01 (generated over :id routes and lists)',
} as const;
const T09 = { covered: 'test', test: 'tenancy.test.ts › ADV-T09 (organization context)' } as const;

export const CROSS_TENANT_FIXTURES: Readonly<Record<string, Coverage>> = {
  'GET /api/v1/health': { covered: 'no-tenant-data', reason: 'liveness probe; returns a constant' },
  'GET /api/v1/ready': { covered: 'no-tenant-data', reason: 'readiness probe; returns no data' },

  'GET /api/v1/auth/login': { covered: 'no-tenant-data', reason: 'redirect to the identity provider' },
  'GET /api/v1/auth/callback': {
    covered: 'no-tenant-data',
    reason: 'creates a user session; no organization data',
  },
  'POST /api/v1/auth/dev-login': {
    covered: 'no-tenant-data',
    reason: 'development sign-in; no organization data',
  },
  'POST /api/v1/auth/logout': { covered: 'no-tenant-data', reason: "revokes the caller's own session" },
  'GET /api/v1/auth/session': { covered: 'no-tenant-data', reason: 'reports whether a session exists' },
  'GET /api/v1/me': {
    covered: 'test',
    test: "invitations.test.ts and tenancy.test.ts: only the caller's own memberships are listed",
  },

  'GET /api/v1/members': T01,
  'PATCH /api/v1/members/:id': T01,
  'GET /api/v1/invitations': T01,
  'POST /api/v1/invitations': T09,
  'POST /api/v1/invitations/:id/revoke': T01,
  'POST /api/v1/invitations/accept': {
    covered: 'test',
    test: 'invitations.test.ts: the token decides the organization; another person cannot use it',
  },
  'GET /api/v1/settings': T09,
  'PATCH /api/v1/settings': T09,
  'GET /api/v1/audit-logs': T09,
};
