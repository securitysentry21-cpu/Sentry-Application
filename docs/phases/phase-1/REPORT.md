# Phase 1 — Identity + tenancy · REPORT

| | |
|---|---|
| Date | 2026-10-08 |
| Result | **Built.** `pnpm verify` passes: 13 checks, 21 test files, 107 tests; every ID due through Phase 1 has a test. |
| Commit | Local only. The GitHub repository is public, so nothing has been pushed (round 6). |

## What was built

- **Schema (migration 0002):**
  - `users` (global within the cell);
  - `organization_members`, `invitations`, `organization_settings`, and `audit_logs` (append-only);
  - `dashboard_sessions` and `auth_states`.

  Two narrow `SECURITY DEFINER` lookups cover the steps that run before an organization is chosen: a user's own memberships, and an invitation by its token hash.
- **Sign-in (D-01):** OpenID Connect against the configured provider (Amazon Cognito in production).
  - The flow is authorization code with PKCE, state and nonce; `jose` verifies the ID token.
  - Then our own server-side session: an HttpOnly, SameSite=Lax cookie, `__Host-` on HTTPS, 12-hour idle and 7-day absolute lifetime.
  - The development sign-in is refused by the configuration in production.
- **Request pipeline** for every route: CSRF check → session → organization (`X-Organization-Id`, or the only membership) → permission → rate limit → strict input schemas.
- **Endpoints:**
  - `/me`;
  - members (list; change role or status);
  - invitations (create, list, revoke, accept);
  - settings (read; edit dashboard-editable keys);
  - the audit log with cursor pagination;
  - sign-in, sign-out and session status.
- **Rules:**
  - nobody changes their own role or status;
  - only an active owner manages owners and administrators;
  - the last active owner can't be removed.

  These live in `packages/domain`. The API applies them after locking the owner rows, and re-reads the caller's authority under that lock.
- **Operator CLI:** `pnpm --filter @sentryops/api operator create-organization --name … --owner-email …` creates the organization and prints the owner's single-use invitation link.
- **Dashboard:**
  - sign-in, development or provider;
  - accepting an invitation; the token travels in the URL fragment and is removed from the address bar;
  - the shell, with the organization switcher and "Signed in as" on every screen;
  - Overview, Members (with invitation links shown once), Settings and Audit log;
  - a blocking signed-out screen.

## Tests by ID

| ID | Where |
|---|---|
| ADV-T01 | `tenancy.test.ts`: generated over every `:id` route, plus the lists |
| ADV-T06 | `rls.test.ts`: generated over the registry, now 8 tenant tables |
| ADV-T09 | `tenancy.test.ts` |
| ADV-A02, A05, A06 | `packages/domain/test/members.test.ts` (rules) and `apps/api/test/members.test.ts` (through the API, including two owners demoting each other at once) |
| ADV-A07 | `auth.test.ts`: a disabled user, and the idle expiry |
| ADV-A09 | `route-registry.test.ts`, with every new route in `cross-tenant-fixtures.ts` |
| ADV-A10 | `tenancy.test.ts`: identity fields in a body are rejected |
| ADV-W03 | `csrf.test.ts` |
| ADV-X03, X04 | traceability and generated docs |

Also tested:

- the OpenID Connect sign-in round trip against a fake provider with real signed tokens: PKCE, single-use state, and no open redirect;
- invitations: single use, bound to the email, expiry, revocation, and an unknown token revealing nothing;
- settings: ranges, cross-field rules, versioning, and phone numbers never written into the audit log;
- provisioning, end to end;
- UTF-8 databases, with an Urdu name stored and read back.

## Found and fixed

- **Windows PostgreSQL clusters defaulted to WIN1252,** which cannot store Urdu. Every cluster and database is now explicitly UTF-8, with a test (D-14).
- **A race between two owners demoting each other** could deadlock, or act on authority read before the other change committed. Owner rows are now locked in ID order, and the caller's authority is re-read under the lock.
- **The audit catalogue lacked `MEMBER_ENABLED` and `ORGANIZATION_CREATED`.** Both were added to SEC §17.1 and the contract.

## Deviations

- **Mobile sessions (D-30)** move to Phase 2, together with guard enrollment, which creates them.
- **Realtime connections closing on revocation (ADV-A07, second half)** comes with the stream in Phase 6.
- **Email sending:** none yet. The dashboard shows the invitation link once, to be sent by hand (round 6).

## For the owner

- **Cognito:** create a user pool in eu-central-1 with MFA required, and an app client with a secret; the callback is `https://<dashboard>/api/v1/auth/callback`. Then set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. Until then, development uses `DEV_AUTH=true`.
