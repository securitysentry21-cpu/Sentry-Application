# Phase 1 — Identity + tenancy · PLAN

| | |
|---|---|
| Status | **Approved 2026-10-08**: "go ahead with all of the phases that we can build" (round 6, decisions delegated) |
| Spec | Revision 3 + round-6 decisions (`docs/DECISIONS.md`) |
| Read | PROD §3–4; ARCH §4–6; SEC §2, §4–6, §17 |

## Goal

Dashboard users can sign in, belong to one or more organizations, invite people, change roles within the rules, edit settings and read the audit log. Every request runs with a validated organization context, and every security-sensitive change is audited in the same transaction.

## Scope

1. **Schema (migration 0002).**
   - `users`: global within the cell, no RLS; reached only through services.
   - `organization_members`, `invitations`, `organization_settings`, `audit_logs` (append-only).
   - `dashboard_sessions` and `auth_states` (OIDC login state), both global.
   - Narrow `SECURITY DEFINER` lookups for steps that run before any organization context exists: a user's own memberships, and an invitation by its token hash.
2. **Sign-in (D-01, decided round 6):** OIDC authorization code with PKCE, state and nonce, against the configured provider (Amazon Cognito in production). The ID token is verified with `jose` against the provider's keys. After sign-in, the API issues its own server-side session in an HttpOnly cookie. A development sign-in exists only when `DEV_AUTH=true`, and the API refuses to start with it in production.
3. **Request context (ARCH §4.1):**
   - session → user (must be ACTIVE) → organization from `X-Organization-Id`, or the only ACTIVE membership;
   - permission check from the role map, then the resource check;
   - organizations that are not ACTIVE are refused.
4. **CSRF (ADV-W03):** state-changing requests authenticated by cookie must carry `X-Sentry-CSRF: 1`, and a cross-site `Origin` or `Sec-Fetch-Site` is refused.
5. **Endpoints:**
   - `GET /me`;
   - `GET /members`, `PATCH /members/:id`;
   - `GET /invitations`, `POST /invitations`, `POST /invitations/:id/revoke`, `POST /invitations/accept`;
   - `GET /settings`, `PATCH /settings`;
   - `GET /audit-logs`;
   - auth: `login`, `callback`, `logout`, `dev-login`.
6. **Rules:**
   - nobody changes their own role or status (`SELF_ROLE_CHANGE`);
   - administrators can't create, change or remove owners or administrators;
   - the last ACTIVE owner can't be demoted, disabled or removed (`LAST_OWNER`);
   - strict schemas reject identity fields in bodies.
7. **Operator CLI** (D-19): creates an organization in the cell and an owner invitation, and prints the link.
8. **Dashboard:**
   - sign-in;
   - accept invitation;
   - shell with the organization switcher and "signed in as" on every screen;
   - members, invitations, settings and audit log pages;
   - a blocking signed-out screen when the session ends.

## Tests by ID

| ID | Proves |
|---|---|
| ADV-T01 | A user in organization A gets 404 for organization B's member and invitation, across every route that takes an ID. It extends automatically through the cross-tenant fixture list as resources arrive. |
| ADV-T06 | Generated over every tenant table, now including the new ones. |
| ADV-T09 | `X-Organization-Id` without a membership is refused. |
| ADV-A02 | Changing your own role or status → `SELF_ROLE_CHANGE`. |
| ADV-A05 | An administrator acting on an owner or administrator → 403. |
| ADV-A06 | The last owner → `LAST_OWNER`. |
| ADV-A07 | A disabled user's session is refused on the next request. The realtime half comes in Phase 6. |
| ADV-A09 | Every route has a policy and a cross-tenant fixture. |
| ADV-W03 | A cross-site state-changing request is blocked. |
| ADV-X03, X04 | Traceability and generated docs, as before. |

## Not in this phase

Guard enrollment and mobile sessions (Phase 2, together with guards); SMS and email sending (codes and links are shown in the dashboard, round 6).
