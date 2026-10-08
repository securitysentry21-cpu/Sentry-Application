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

  // Phase 2
  'GET /api/v1/guards': T01,
  'POST /api/v1/guards': T09,
  'POST /api/v1/guards/import': T09,
  'GET /api/v1/guards/:id': T01,
  'PATCH /api/v1/guards/:id': T01,
  'POST /api/v1/guards/:id/terminate': T01,
  'POST /api/v1/guards/:id/enrollment-codes': T01,
  'GET /api/v1/guards/:id/devices': T01,
  'POST /api/v1/devices/:id/revoke': T01,
  'POST /api/v1/enrollments/redeem': {
    covered: 'test',
    test: 'enrollment.test.ts › ADV-A11/A12: the code and phone number decide the organization and guard',
  },
  'POST /api/v1/sessions/refresh': {
    covered: 'test',
    test: 'enrollment.test.ts › the refresh token decides the session; reuse revokes the family',
  },
  'GET /api/v1/mobile/config': {
    covered: 'test',
    test: "enrollment.test.ts › ADV-A01 (the guard's own data only)",
  },
  'POST /api/v1/tracking-consents': {
    covered: 'test',
    test: 'enrollment.test.ts › consent is tied to the session',
  },
  'GET /api/v1/sites': T01,
  'POST /api/v1/sites': T09,
  'GET /api/v1/sites/:id': T01,
  'PATCH /api/v1/sites/:id': T01,
  'GET /api/v1/sites/:id/checkpoints': T01,
  'POST /api/v1/sites/:id/checkpoints': {
    covered: 'test',
    test: 'sites.test.ts › ADV-T04 and tenancy.test.ts › ADV-T01',
  },
  'GET /api/v1/sites/:id/checkpoints/print-sheet': {
    covered: 'test',
    test: 'sites.test.ts › ADV-T05 and tenancy.test.ts › ADV-T01',
  },
  'PATCH /api/v1/checkpoints/:id': T01,

  // Phase 3
  'GET /api/v1/shifts': T09,
  'POST /api/v1/shifts': {
    covered: 'test',
    test: "tenancy.test.ts › ADV-T01 and shifts: another organization's guard or site is not found",
  },
  'POST /api/v1/shifts/bulk': T09,
  'GET /api/v1/shifts/:id': T01,
  'PATCH /api/v1/shifts/:id': T01,
  'POST /api/v1/shifts/:id/cancel': T01,
  'POST /api/v1/shifts/:id/manual-start': T01,
  'POST /api/v1/shifts/:id/force-end': T01,
  'POST /api/v1/shifts/:id/extend': T01,
  'POST /api/v1/shifts/:id/reopen': T01,
  'POST /api/v1/shifts/:id/start': {
    covered: 'test',
    test: "shifts.test.ts › ADV-A03 (another guard's shift is not found)",
  },
  'POST /api/v1/shifts/:id/end': {
    covered: 'test',
    test: "shifts.test.ts › ADV-A03 (another guard's shift is not found)",
  },
  'POST /api/v1/sync/batch': {
    covered: 'test',
    test: "sync.test.ts › ADV-L02 (another guard's shift is rejected, nothing stored)",
  },
  'GET /api/v1/dashboard/snapshot': T09,
  'GET /api/v1/me/shifts': {
    covered: 'test',
    test: "shifts.test.ts › ADV-A03 (only the guard's own shifts)",
  },
  'POST /api/v1/checkpoints/:id/rotate-qr': {
    covered: 'test',
    test: 'sites.test.ts › ADV-T05 and tenancy.test.ts › ADV-T01',
  },
};
