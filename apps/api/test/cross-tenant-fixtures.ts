// ADV-A09: every mounted route must appear here, either naming the cross-tenant test that proves
// another organization's data cannot be reached through it, or stating why it holds no tenant
// data. Adding a route without an entry fails the meta-test. A test reference names its file and
// either an INV/ADV ID that file cites or a test title in double quotes, word for word; the
// meta-test checks both (review L-08).

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
    test: 'tenancy.test.ts › "a user in two organizations must choose one; each choice sees only its own data"',
  },

  'GET /api/v1/members': T01,
  'PATCH /api/v1/members/:id': T01,
  'GET /api/v1/invitations': T01,
  'POST /api/v1/invitations': T09,
  'POST /api/v1/invitations/:id/revoke': T01,
  'POST /api/v1/invitations/accept': {
    covered: 'test',
    test: 'invitations.test.ts › "someone else holding the link cannot use it"',
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
    test: 'enrollment.test.ts › "refresh tokens rotate; a reused one revokes the whole family"',
  },
  'GET /api/v1/mobile/config': {
    covered: 'test',
    test: "enrollment.test.ts › ADV-A01 (the guard's own data only)",
  },
  'POST /api/v1/tracking-consents': {
    covered: 'test',
    test: 'enrollment.test.ts › "the tracking consent is recorded, append-only and audited"',
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

  // Phase 6
  'GET /api/v1/stream': {
    covered: 'test',
    test: "realtime.test.ts › ADV-T02: refused for another organization's ID; never carries its events; closed when membership ends",
  },
  'GET /api/v1/guards/:id/location': T01,
  'GET /api/v1/guards/:id/location-history': T01,
  'GET /api/v1/me/shifts': {
    covered: 'test',
    test: "shifts.test.ts › ADV-A03 (only the guard's own shifts)",
  },
  'POST /api/v1/checkpoints/:id/rotate-qr': {
    covered: 'test',
    test: 'sites.test.ts › ADV-T05 and tenancy.test.ts › ADV-T01',
  },

  // Phase 7
  'GET /api/v1/sites/:id/patrol-routes': T01,
  'POST /api/v1/sites/:id/patrol-routes': T01,
  'PATCH /api/v1/patrol-routes/:id': T01,
  'GET /api/v1/patrol-runs': {
    covered: 'test',
    test: "tenancy.test.ts › ADV-T01 lists (another organization's runs are never listed)",
  },
  'GET /api/v1/patrol-runs/:id': T01,
  'GET /api/v1/checkpoint-visits': {
    covered: 'test',
    test: "tenancy.test.ts › ADV-T01 (another organization's shift is not found)",
  },
  'GET /api/v1/me/patrols': {
    covered: 'test',
    test: "patrols.test.ts › ADV-A03 (another guard's shift is not found)",
  },

  // Phase 5
  'GET /api/v1/alerts': {
    covered: 'test',
    test: `alerts.test.ts › "the list never holds another organization's alerts"`,
  },
  'GET /api/v1/alerts/:id': T01,
  'POST /api/v1/alerts/:id/acknowledge': T01,
  'POST /api/v1/alerts/:id/resolve': T01,
  'POST /api/v1/alerts/:id/dismiss': T01,
  'GET /api/v1/reports/attendance': {
    covered: 'test',
    test: `reports.test.ts › "never includes another organization's shifts, and another organization's site is not found"`,
  },

  // Phase 9
  'GET /api/v1/reports/patrols': {
    covered: 'test',
    test: "reports.test.ts › ADV-T03 (every report: another organization's site or guard is not found)",
  },
  'GET /api/v1/reports/incidents': {
    covered: 'test',
    test: "reports.test.ts › ADV-T03 (every report: another organization's site or guard is not found)",
  },
  'GET /api/v1/reports/locations': {
    covered: 'test',
    test: "reports.test.ts › ADV-T03 (every report: another organization's site or guard is not found)",
  },
  'GET /api/v1/reports/site-activity': {
    covered: 'test',
    test: "reports.test.ts › ADV-T03 (every report: another organization's site or guard is not found)",
  },
  'POST /api/v1/exports': {
    covered: 'test',
    test: "exports.test.ts › ADV-T03 (an export naming another organization's IDs is refused and holds none of its data)",
  },
  'GET /api/v1/exports': T01,
  'GET /api/v1/exports/:id': T01,
  'POST /api/v1/exports/:id/download': T01,

  // Phase 8
  'PUT /api/v1/members/:id/alert-phone': T01,
  'GET /api/v1/incidents': {
    covered: 'test',
    test: `incidents.test.ts › "the list never holds another organization's incidents; the home page counts open ones"`,
  },
  'POST /api/v1/incidents': T09,
  'GET /api/v1/incidents/:id': T01,
  'PATCH /api/v1/incidents/:id': T01,
  'POST /api/v1/incidents/:id/notes': T01,
  'POST /api/v1/incidents/:id/acknowledge': T01,
  'POST /api/v1/incidents/:id/resolve': T01,
  'POST /api/v1/incidents/:id/reopen': T01,
  'POST /api/v1/incidents/:id/attachments': {
    covered: 'test',
    test: "attachments.test.ts › ADV-T10 (another guard's or organization's incident is not found)",
  },
  'POST /api/v1/attachments/:id/complete': {
    covered: 'test',
    test: "attachments.test.ts › ADV-T10 (another guard's photo is not found)",
  },
  'GET /api/v1/attachments/:id/url': T01,
  'GET /api/v1/attachments/:id/original-url': T01,
  'GET /api/v1/me/incidents': {
    covered: 'test',
    test: "incidents.test.ts › ADV-A03 (only the guard's own reports)",
  },
  'PUT /api/v1/local-objects/:token': {
    covered: 'test',
    test: 'attachments.test.ts › ADV-F03 (a guessed or altered link is refused)',
  },
  'GET /api/v1/local-objects/:token': {
    covered: 'test',
    test: 'attachments.test.ts › ADV-F03, F04 (a guessed, altered or expired link is refused)',
  },
  'POST /api/v1/sos': {
    covered: 'test',
    test: "sos.test.ts › ADV-S11 (the session or the phone's own key decides; another phone's key is refused, and the body names no organization)",
  },
  'GET /api/v1/sos/:id/status': {
    covered: 'test',
    test: "sos.test.ts › ADV-A03 (another guard's SOS is not found)",
  },
  'POST /api/v1/sos/:id/locations': {
    covered: 'test',
    test: "sos.test.ts › ADV-A03 (another guard's SOS is not found)",
  },
  'POST /api/v1/sos/:id/cancel-request': {
    covered: 'test',
    test: "sos.test.ts › ADV-A03 (another guard's SOS is not found)",
  },
  'GET /api/v1/sos/:id': T01,
  'POST /api/v1/sos/:id/acknowledge': T01,
  'POST /api/v1/sos/:id/resolve': T01,
  'GET /api/v1/sos-drills/current': T09,
  'POST /api/v1/sos-drills': {
    covered: 'test',
    test: "sos.test.ts › ADV-S10 (another organization's guard or member is not found)",
  },
  'GET /api/v1/sos-drills/:id': T01,
  'POST /api/v1/sos-drills/:id/end': T01,
  'GET /api/v1/push/config': { covered: 'no-tenant-data', reason: "the environment's public Web Push key" },
  'POST /api/v1/push-subscriptions': T09,
  'GET /api/v1/push-subscriptions': {
    covered: 'test',
    test: 'notifications.test.ts › "subscriptions: only push-service endpoints; a member lists and removes only their own"',
  },
  'DELETE /api/v1/push-subscriptions/:id': T01,
  'POST /api/v1/notifications/test': T09,
  'POST /api/v1/alerts/:id/seen': T01,
  'POST /api/v1/alerts/:id/delivered': T01,
  'POST /api/v1/me/push-token': {
    covered: 'test',
    test: "notifications.test.ts › ADV-A10 (a push token goes on the caller's own phone, never another guard's or organization's)",
  },

  // Phase 10
  'POST /api/v1/diagnostics/app-errors': {
    covered: 'test',
    test: 'diagnostics.test.ts › "the request cannot name an organization or device: the session decides, and extra fields are refused"',
  },
};
