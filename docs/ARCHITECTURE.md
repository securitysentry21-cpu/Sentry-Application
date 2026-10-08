# Security Guard Operations & Tracking Platform
# ARCHITECTURE.md — How it works technically

| | |
|---|---|
| Spec revision | 3 — changes listed in PROD §0.2; decisions in `docs/DECISIONS.md` |
| Date | 2026-10-08 |
| Approver | Product owner (Faraz) |
| Implementation agent | Claude Code |
| Audit agent | Fable |

---

## 0. Document set and working protocol

### 0.1 Document set (identical block in all three documents)

| Document | Answers | Section prefix |
|---|---|---|
| `PRODUCT_SPEC.md` | What the product does, for whom, with which rules and defaults | `PROD §` |
| `ARCHITECTURE.md` | How it works technically, how it is built, in which order | `ARCH §` |
| `SECURITY_AND_INVARIANTS.md` | What must never be allowed to happen, and how that is proven | `SEC §` |

**Precedence when documents disagree:** `SECURITY_AND_INVARIANTS.md` > approved decisions in `docs/DECISIONS.md` > `PRODUCT_SPEC.md` > `ARCHITECTURE.md` > implementation convenience. A conflict between two statements at the same level is a STOP condition (ARCH §0.3).

**Normative words:** MUST / MUST NOT = required (violation is a defect). SHOULD = expected; deviation needs a recorded reason. MAY = optional. "Default" = a configurable value from PROD Appendix B; never hard-coded.

**Identifiers:** `INV-nn` invariants (SEC §2) · `D-nn` decisions (appendices of each document; numbering is global) · `ADV-xnn` adversarial tests (SEC §18) · `EXT-nn` external dependencies and approvals (ARCH §20) · `A-nn` assumptions (PROD §2.3). Tests SHOULD carry the ID they prove in their name, e.g. `it("ADV-T01 org A user cannot read org B guard")`.

### 0.2 Claude Code working protocol

1. **One phase at a time** (ARCH §22). Never start a phase without explicit approval. Never implement the whole product in one pass.
2. **Phase start:** read the sections listed for the phase in all three documents. Write `docs/phases/phase-N/PLAN.md`: scope, schema changes, endpoints, screens, jobs, tests by ID, risks, open questions. If anything needs a decision marked OPEN → STOP and present options.
3. **During the phase:** stay inside the phase. No out-of-scope features (PROD §2.2). No new infrastructure component. No silent architecture change.
4. **Build a table when a fact needs it.** ARCH §6 is the target model; create tables in the phase that first needs them, not all up front.
5. **Invariants are enforced mechanically, not by prose.** Every invariant in SEC §2 is backed by a database constraint, a test, or a CI check. If you implement something an invariant governs and cannot point to the mechanism, the work is not done.
6. **Never weaken, skip or delete a failing test** to get CI green. A skipped test needs a linked reason in `docs/OPEN_QUESTIONS.md`.
7. **Never report something as tested that was not executed.** Real-device tests are run by humans; prepare checklists and instrumentation and mark them "pending human verification".
8. **Dependencies:** justify every new dependency in the phase report (purpose, alternatives, maintenance, licence, size, native permissions it adds). Prefer the platform and existing dependencies.
9. **Phase end:** full CI green; write `docs/phases/phase-N/REPORT.md` (what was built, deviations and reasons, tests by ID, known gaps, human checklist); update docs so they describe the code as it is (docs that describe a superseded design are defects).

### 0.3 STOP protocol

When an architectural decision is needed, when the spec is silent on anything touching tenancy, authorization, privacy, location integrity, SOS or retention, or when two statements conflict:

```text
STOP
DOCUMENT THE DECISION (context, options, trade-offs, recommendation) in docs/DECISIONS.md
PRESENT OPTIONS
WAIT FOR APPROVAL
```

For other gaps choose the simplest option consistent with the spec, record it in `docs/DECISIONS.md` tagged `agent-decided`, and list it in the phase report.

### 0.4 Repository documents to create and maintain

`CLAUDE.md` (condensed rules, commands, pointers to invariants) · `docs/PRODUCT_SPEC.md` · `docs/ARCHITECTURE.md` · `docs/SECURITY_AND_INVARIANTS.md` · `docs/DECISIONS.md` (ADR log) · `docs/THREAT_MODEL.md` · `docs/OPEN_QUESTIONS.md` · `docs/EXTERNAL_DEPENDENCIES.md` (live copy of ARCH §20 with status) · generated OpenAPI · `docs/RUNBOOKS/*.md` · `docs/testing/device-matrix.md` · `docs/phases/phase-N/{PLAN,REPORT}.md`.

---

## 1. System overview

### 1.1 Components

| Component | Responsibility |
|---|---|
| Mobile app (Expo) | guards only: tracking, outbox, shifts, patrols, incidents, SOS. There is no supervisor mode (D-04) |
| API (Fastify) | the only gateway to the database; authentication, authorization, validation, business rules |
| Workers (same codebase, separate processes) | jobs, detectors, escalation, notifications, attachment processing, exports, retention |
| Web dashboard (Next.js) | UI only; talks to the API; never to the database. Also used by duty officers on their phones: responsive, installable to the home screen, receives web push (D-04) |
| PostgreSQL | system of record; row-level security; job queue (D-11) |
| Object storage (S3-compatible, private) | incident photos, exports |
| External providers | identity for dashboard users (D-01), push (D-26: FCM/APNs for the guard app, Web Push for the dashboard), SMS through a Pakistani aggregator (D-08), maps (Google Maps, D-12), error tracking |

**Cells (D-13) [R3].** Everything above except the external providers is deployed once per data region as an independent *cell*, with its own database, file storage, API and workers. Each organization lives in exactly one cell, chosen when the operator provisions it. V1 runs one cell, on AWS in Frankfurt (D-37). To keep a second cell possible on any provider, including a Pakistani one, a cell uses only portable building blocks: containers, PostgreSQL and S3-compatible storage. No provider-specific queues, functions or databases.

### 1.2 Key flows

```mermaid
sequenceDiagram
  participant P as Guard phone
  participant A as API
  participant DB as PostgreSQL
  participant W as Workers
  participant D as Dashboards
  P->>A: POST /sync/batch (ordered items)
  A->>DB: tx: insert points (idempotent), update live state, write outbox rows
  A-->>P: per-item results + server time + shift states
  W->>DB: read outbox
  W->>W: geofence evaluation, alert rules
  W->>D: realtime events (SSE)
```

```mermaid
sequenceDiagram
  participant P as Guard phone
  participant A as API
  participant DB as PostgreSQL
  participant W as Workers
  participant S as Supervisors
  P->>A: POST /sos (priority lane, no batching)
  A->>DB: tx: sos_event + SOS_ACTIVATED alert + outbox
  A-->>P: RECEIVED + sosEventId
  W->>S: realtime alarm + web push + SMS to duty officers (T+0)
  W->>S: SMS to administrators (T+60 s if unacknowledged), owners (T+180 s)
  S->>A: acknowledge
  P->>A: GET /sos/:id (poll) -> ACKNOWLEDGED by name
```

---

## 2. Technology stack

Every component has a reason. Nothing is added because it is fashionable.

| Concern | V1 choice | Reason |
|---|---|---|
| API | Node.js LTS, TypeScript (strict), Fastify | Revision 1 |
| Contracts | zod schemas in `packages/contracts`; OpenAPI generated from them | one source of truth for API, web and mobile |
| Database | PostgreSQL ≥ 16 managed, with point-in-time recovery | RLS, exclusion constraints, partitioning; UUIDv7 is generated in the API, so the PostgreSQL version doesn't matter |
| Required extensions | `btree_gist` (no-overlap shifts), `citext`, `pgcrypto` | verify availability on the chosen provider (EXT-14) |
| DB access | Kysely, plain SQL migrations, `kysely-codegen` types (D-10, approved) | explicit SQL and transactions; `SET LOCAL` per transaction; no ORM hiding tenant filters; a schema-first ORM conflicts with SQL-first migrations that carry RLS and grants |
| Migrations | SQL-first, in `packages/db`, run by a dedicated migration role | reviewable; RLS policies and grants live in migrations |
| Jobs | pg-boss on PostgreSQL (D-11) | no extra infrastructure; jobs enqueued in the same transaction |
| Realtime | Server-Sent Events + PostgreSQL LISTEN/NOTIFY (D-09 approved, D-11), replay buffer with a per-organization sequence assigned after commit (§14) | simplest viable; swap to Redis pub/sub only if measured need |
| Object storage | S3-compatible, private bucket | Revision 1 |
| Web | Next.js (App Router), client of the API | no direct DB access from Next.js |
| Mobile | Expo (SDK 55+, New Architecture only) with development builds (EAS), config plugins, native modules where needed; Expo Go is not used; builds target Android API 36 | Revision 1; background location needs native config |
| Mobile local storage | SQLite (transactional) for the outbox; secure storage for tokens | durability across kills and reboots |
| Background location | decided by Phase 0B spike (D-07); must support the New Architecture | highest technical risk |
| Maps | Google Maps Platform behind `MapProvider` (D-12, approved): Maps JavaScript API with Advanced Markers and clustering; current APIs only, never deprecated ones such as the legacy `Marker` | owner preference; strong map data in Pakistan (reasoned) |
| Push | FCM + APNs for the guard app; Web Push (VAPID) for the dashboard (D-26) | duty officers use the dashboard on their phones (D-04) |
| SMS | provider behind `SmsProvider` (D-08) | |
| Error tracking | Sentry-compatible with PII scrubbing | |
| Workspace package scope | our own registered npm scope | `@sentry/*` belongs to Sentry.io: name collisions and dependency confusion |
| Hosting (first cell) | AWS eu-central-1 (Frankfurt): ECS on Fargate behind an Application Load Balancer, RDS for PostgreSQL, S3, KMS, Secrets Manager (D-37, §19.8) | mature security tooling; meets every requirement in this table natively; uses only the portable building blocks of §1.1 |
| Identity | dashboard users: mature provider (D-01); guards: invitation-code enrollment into our own device-bound sessions (D-02, D-30) | never build password auth; the guard app has no identity-provider or SMS-OTP dependency |

**Hosting constraint:** the API, SSE endpoint and workers run as long-lived processes (containers or VMs). Serverless functions are not suitable for SSE streams, LISTEN/NOTIFY listeners or pg-boss workers. The Next.js dashboard is served from the same origin as the API: one domain, one reverse proxy, `/api/*` routed to the API. Browser cookies then authenticate REST and SSE alike, with no CORS allow-list, cross-site cookie or stream ticket.

**Connection-pooling constraint:** if a pooler in transaction mode is used, (a) tenant context must be set with `SET LOCAL` inside each transaction (session-level `SET` leaks between clients), and (b) LISTEN/NOTIFY needs a dedicated direct (non-pooled) connection per API instance.

---

## 3. Repository layout and module boundaries

```text
apps/api            Fastify API; workers entrypoint (separate process, same code)
apps/web            Next.js dashboard
apps/mobile         Expo app (guards only)
packages/contracts  zod schemas, enums, permission map, error codes, OpenAPI generation
packages/domain     pure logic, no IO: geofence, freshness, shift state machine,
                    checkpoint verification, capture-time estimation, alert rules, CSV escaping
packages/db         schema, migrations, RLS policies, grants, seed, test fixtures
packages/config     tsconfig, eslint, prettier
tools/simulator     fake-device CLI that drives the real sync API (staging, demos, load tests)
docs/
```

- `packages/domain` is used by the API, the web dashboard (freshness ticking) and the mobile app, so the same rule is never implemented twice.
- API modules: identity, tenancy, members, guards, devices, sites, patrols, shifts, tracking, incidents, attachments, sos, alerts, notifications, realtime, reports, exports, audit, settings, retention.
- Handlers are thin; services own transactions; repositories own SQL; domain functions are pure.
- All server code reads time from an injectable `Clock`. `Date.now()` / `new Date()` are banned in `packages/domain` and services (lint rule); tests use a fake clock.
- Lint MUST actually run in CI and fail on errors. A lint step that is a no-op is a defect.
- Workspace packages use our own registered npm scope, never `@sentry/*`.

---

## 4. Tenancy and authorization — implementation

Requirements are in SEC §4 and §6. This section is the mechanism.

### 4.1 Request context

```text
authenticate (provider JWT/session)
→ load user + ACTIVE memberships
→ choose organization:
     web: X-Organization-Id header, must match an ACTIVE membership
     mobile guard: the guard's single membership
→ load permissions for the role
→ context = { userId, orgId, role, permissions, guardId?, deviceId?, requestId }
```

`organization_id`, `guard_id`, `user_id` in bodies or query strings never establish identity or tenancy (INV-17).

### 4.2 Scoped data access

All access to tenant tables goes through repository functions that take the context and add `organization_id = :orgId`. Route handlers MUST NOT build SQL for tenant tables. A CI check flags raw SQL outside `packages/db` and repositories.

### 4.3 Row-level security

- Every tenant table: `ENABLE ROW LEVEL SECURITY` (not FORCE, D-33); policy `organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid` for SELECT/INSERT/UPDATE/DELETE as applicable. A missing or empty setting yields NULL → no rows (fail closed). The `NULLIF` matters: once a pooled connection has used the setting, it returns `''` instead of NULL, and a bare `::uuid` cast throws.
- Tables are owned by `migrator`, so data migrations it runs are not filtered. The API and workers check at startup that they are connected as their runtime role, without `BYPASSRLS` and owning no tables, and refuse to start otherwise (ADV-X07). That covers the case FORCE would guard: a misconfigured `DATABASE_URL`.
- Every request transaction begins with `SET LOCAL app.org_id = '<uuid>'` (and `app.user_id`).
- Roles:

| Role | Owns tables | Bypasses RLS | Used by |
|---|---|---|---|
| `migrator` | yes | n/a | migrations only |
| `app_runtime` | no | no | API and per-org jobs |
| `system_worker` | no | no; has explicit read-only cross-org policies on specific tables | cross-org sweeps that only enumerate work |
| `retention_worker` | no | explicit DELETE policies on retained tables | retention job |

- Tests run as `app_runtime`, never as a superuser or table owner (a superuser silently bypasses RLS and makes isolation tests pass falsely).
- Test the behaviour of every role against every tenant table, on fresh connections and on connections that already served another tenant. Any table without RLS is listed in `docs/DECISIONS.md` with the reason (e.g., `users`, which is global within a cell).

### 4.4 Composite foreign keys

Every tenant table has `UNIQUE (organization_id, id)`. Child tables reference parents with `(organization_id, parent_id)`. The database therefore rejects a shift in organization A that points at a site in organization B even if application code is wrong (INV-13). Where two parents must share a site (route ↔ checkpoint), the key includes `site_id` too (ARCH §6.3).

### 4.5 Background jobs

Every job payload carries `organization_id`; the runner opens a transaction with `SET LOCAL app.org_id`. Cross-organization sweeps (detectors) run as `system_worker`, only select work items, and enqueue per-organization jobs that do the writes as `app_runtime`. System writes record `actor_type = SYSTEM`.

### 4.6 Permissions and route policies

- Permissions are strings (e.g., `shifts.write`, `location.history.read`). The role → permission map lives once in `packages/contracts` and implements PROD §3.2.
- Every route is declared in a registry with: method, path, required permission(s), resource loader and ownership rule, request and response schemas, rate-limit class, audit action. Unregistered routes cannot be mounted.
- A CI meta-test enumerates the registry and fails if any route lacks a policy or is missing from the cross-tenant test fixture list (ADV-A09).
- Resources in another organization return 404, not 403 (no existence leak).

### 4.7 Namespaces

Cache keys, pub/sub channels and object keys are prefixed with the organization: `org/{orgId}/incidents/{incidentId}/{attachmentId}/...`. Buckets are private; access only through short-lived signed URLs issued after authorization.

---

## 5. Identity, sessions and devices

### 5.1 Identity provider (D-01) — dashboard users only

The provider handles dashboard users' identities only: email/password or passkeys, verification, password reset, MFA (authenticator app or passkey), account disabling, session revocation, JWT signing-key rotation. Guards have no provider accounts (§5.3). **Organization membership, roles and permissions live in our database**, the single source of truth; the provider's own organization/role features are not used for authorization.

### 5.2 Dashboard sessions

HttpOnly secure cookies; MFA enforced for Owner and Administrator; silent renewal while the tab is open; blocking signed-out screen if renewal fails (PROD §14.7).

### 5.3 Guard enrollment and mobile sessions (D-02, D-30) [R3]

- **Enrollment.** The guard's invitation SMS carries an install link and an enrollment code. Redeeming it (`POST /enrollments/redeem`) proves possession of the SMS, creates a P-256 key pair in Keystore / Secure Enclave that never leaves the phone, registers its public key with the device, and returns our own session. On Android the code travels through installation via the Play install referrer (verify in Phase 2); otherwise the guard opens the link again or types the code.
- **Session.** Our API issues it: a short-lived access token, and a refresh token valid ≥ 14 days (sliding) so a long offline shift never loses identity. Refresh tokens rotate on every use and are stored hashed; presenting an already-rotated token revokes the whole session. Tokens and the device key live in Keychain / Android Keystore.
- **No provider SDK in the sync path.** The sync engine refreshes its own session, so native or headless uploads keep working with the app's UI closed.
- **SOS fallback.** An SOS signed with the device key is accepted even when the session has expired, as long as the device is ACTIVE, or REPLACED within its grace window (INV-15).
- Capture continues offline even if the access token has expired; the outbox uploads after refresh.
- If refresh is impossible (revoked or disabled): stop tracking, keep the queue, show "Signed out by your organization — pending data cannot be sent".
- Later messages to the guard (for example "Your account was moved to a new phone") are in-app or push notifications, not SMS.

### 5.4 Devices (D-05, D-31)

- On first launch the app generates an `installation_id` (random UUID kept in secure storage). Hardware identifiers are never used as identity.
- Enrollment binds the installation and its public key to the guard → server `device_id`. The app sends `X-Device-Id` on every request; the server checks the device is ACTIVE and belongs to the authenticated guard.
- One ACTIVE device per guard: the guard's own phone. Moving to a new phone needs a new enrollment code issued from the dashboard by a Supervisor, Administrator or Owner (`POST /guards/:id/enrollment-codes`, audited). Redeeming it revokes the old device as REPLACED. An SMS to the guard's number alone is never enough, because numbers get recycled.
- Revocation reasons: REPLACED (pending uploads captured before revocation are accepted for 72 h), LOST / COMPROMISED / ADMIN (everything rejected).

### 5.5 Lent phones

Shared or site phones are not supported in V1 (D-05). Because a guard can still lend their phone, the outbox stays partitioned by (user, organization): one user's queue is never uploaded with another user's session, and switching user with pending data requires the first user to sync or explicitly confirm data loss.

---

## 6. Data model

### 6.1 Conventions

- Primary keys UUIDv7, generated in the API. The only client-generated IDs are `client_event_id` values, used solely as idempotency keys.
- Tenant tables: `organization_id uuid NOT NULL`, `UNIQUE (organization_id, id)`, RLS (ARCH §4.3), composite FKs (ARCH §4.4).
- All timestamps `timestamptz`, stored UTC. Mutable tables have `created_at`, `updated_at`; admin-editable tables add `created_by`, `updated_by`.
- Editable entities carry `version int NOT NULL DEFAULT 1` for optimistic concurrency (guards, sites, checkpoints, patrol_routes, shifts, incidents, alerts, sos_events, settings, members).
- Enums as PostgreSQL enum types or CHECK constraints; transitions enforced in `packages/domain`.
- Operational entities are never hard-deleted; they become INACTIVE/ARCHIVED.
- **Append-only tables** (runtime role has INSERT and SELECT only): `location_points`, `shift_events`, `checkpoint_visits`, `incident_events`, `alert_events`, `device_status_events`, `tracking_consents`, `audit_logs`. Only `retention_worker` deletes.
- Coordinates `double precision` with CHECK ranges; accuracy CHECK > 0.
- Emails `citext`; phones E.164.

### 6.2 Entity list

```text
organizations, organization_settings, org_sequences
users, organization_members, invitations
guards, guard_devices, mobile_sessions, push_tokens, tracking_consents
sites, checkpoints, patrol_routes, patrol_route_checkpoints, patrol_runs, checkpoint_visits
shifts, shift_events, shift_live_state
location_points, device_status_events
incidents, incident_events, incident_attachments
sos_events, alerts, alert_events, notification_deliveries
exports, audit_logs, outbox, realtime_events, quarantined_items
```

Revision 1's `site_geofences` table is folded into `sites` (one circle per site in V1). A separate table is introduced only when polygons or multiple zones are approved.

### 6.3 Tables

Shorthand: `ts` = timestamptz; `→ X` = composite FK `(organization_id, x_id) → X(organization_id, id)`.

```text
organizations                (RLS: id = app.org_id)
  id, name, legal_name, status ACTIVE|SUSPENDED|CLOSED,
  timezone text NOT NULL (IANA), default_locale,
  data_region text NOT NULL (the cell's region, D-13; checked at startup), created_at, updated_at

organization_settings
  organization_id PK → organizations, settings jsonb NOT NULL (validated by versioned zod schema),
  schema_version int, version int, updated_by, updated_at

org_sequences
  organization_id, name, next_value bigint; PK (organization_id, name)    -- incident reference numbers

users                        (global within a cell; no RLS; access only through services, never listed globally)
  id, auth_provider_user_id UNIQUE NULL (dashboard users only; guards have none, D-02), email citext UNIQUE NULL, phone UNIQUE NULL,
  name, status ACTIVE|DISABLED, locale, created_at, updated_at
  CHECK (email IS NOT NULL OR phone IS NOT NULL)

organization_members
  id, organization_id, user_id, role OWNER|ADMIN|SUPERVISOR|DISPATCHER|GUARD,
  status INVITED|ACTIVE|DISABLED|REMOVED, version, created_at, updated_at
  UNIQUE (organization_id, user_id)

invitations                  (member invitations, guard enrollment and new-phone codes)
  id, organization_id, purpose MEMBER|GUARD_ENROLLMENT|NEW_DEVICE, role, email NULL, phone NULL, guard_id NULL → guards,
  token_hash bytea UNIQUE (link token), code_hash bytea NULL (typed code), attempts int DEFAULT 0,
  expires_at, accepted_at, accepted_by_user_id, revoked_at, created_by, created_at

guards
  id, organization_id, user_id NULL, employee_number, display_name, phone,
  status ACTIVE|INACTIVE|SUSPENDED|TERMINATED, preferred_locale, version, created/updated (+by)
  UNIQUE (organization_id, employee_number)
  UNIQUE (user_id) WHERE user_id IS NOT NULL AND status <> 'TERMINATED'   -- A-04: one organization at a time

guard_devices
  id, organization_id, guard_id → guards, installation_id uuid, public_key bytea NOT NULL, key_algorithm text NOT NULL,
  platform IOS|ANDROID,
  manufacturer, model, os_version, app_version, status ACTIVE|REVOKED,
  revoked_reason REPLACED|LOST|COMPROMISED|ADMIN NULL, revoked_at, revoked_by, last_seen_at, created_at, updated_at
  UNIQUE (organization_id, installation_id)
  UNIQUE (guard_id) WHERE status = 'ACTIVE'                  -- D-05

mobile_sessions              (D-30)
  id, organization_id, guard_id → guards, device_id → guard_devices,
  refresh_token_hash bytea UNIQUE NOT NULL, family_id uuid NOT NULL, issued_at, last_used_at, expires_at,
  revoked_at NULL, revoked_reason ROTATION_REUSE|DEVICE_REVOKED|GUARD_DISABLED|SIGNED_OUT NULL, created_at
  -- one row per rotation; presenting a rotated token revokes every row in its family

push_tokens                  (user-scoped; accessed only by notification service)
  id, user_id, installation_id NULL, provider FCM|APNS|WEBPUSH, token (for Web Push: the subscription endpoint), keys jsonb NULL (Web Push keys),
  status ACTIVE|INVALID, last_registered_at, created_at
  UNIQUE (provider, token)

tracking_consents            (append-only)
  id, organization_id, guard_id → guards, user_id, device_id → guard_devices,
  disclosure_version, locale, accepted_at, created_at

sites
  id, organization_id, name, client_name, address_line_1, address_line_2, city, state, postal_code,
  country (ISO 3166-1 alpha-2), timezone (IANA), latitude, longitude,
  geofence_radius_meters int CHECK (50..5000), status ACTIVE|INACTIVE|ARCHIVED, notes, version, created/updated (+by)

checkpoints
  id, organization_id, site_id → sites, name, description, latitude NULL, longitude NULL,
  verification_radius_meters int CHECK (10..500),
  qr_token_hash bytea UNIQUE NOT NULL,        -- SHA-256(token); the token itself is derived, ARCH §11.1
  qr_token_version int NOT NULL DEFAULT 1, qr_rotated_at,
  status ACTIVE|INACTIVE|ARCHIVED, version, created/updated (+by)
  UNIQUE (organization_id, site_id, id)

patrol_routes
  id, organization_id, site_id → sites, name, description, enforce_order bool DEFAULT false,
  interval_minutes int NULL (NULL = on demand), first_run_offset_minutes int DEFAULT 0,
  completion_window_minutes int, status, version, created/updated (+by)
  UNIQUE (organization_id, site_id, id)

patrol_route_checkpoints
  id, organization_id, site_id, patrol_route_id, checkpoint_id, sequence int, required bool DEFAULT true
  FK (organization_id, site_id, patrol_route_id) → patrol_routes(organization_id, site_id, id)
  FK (organization_id, site_id, checkpoint_id)   → checkpoints(organization_id, site_id, id)
  UNIQUE (patrol_route_id, sequence), UNIQUE (patrol_route_id, checkpoint_id)
  -- the database guarantees a route and its checkpoints share a site
  -- service rule: a checkpoint is in at most one scheduled route

shifts
  id, organization_id, guard_id → guards, site_id → sites,
  starts_at, ends_at, start_deadline_at,
  status SCHEDULED|ACTIVE|COMPLETED|MISSED|CANCELLED,
  actual_started_at, actual_ended_at,
  start_source APP_ONLINE|APP_OFFLINE_SYNCED|SUPERVISOR_MANUAL NULL,
  start_latitude, start_longitude, start_accuracy_m, start_distance_m,
  start_geofence_class INSIDE|OUTSIDE|UNCERTAIN|NO_FIX, start_device_id, start_flags text[],
  end_reason GUARD|GUARD_OFFLINE_SYNCED|SUPERVISOR_FORCE_END|AUTO_TIMEOUT|GUARD_DISABLED NULL,
  end_latitude, end_longitude, end_accuracy_m,
  cancelled_reason, notes, version, created/updated (+by)
  CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '24 hours')
  EXCLUDE USING gist (guard_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status <> 'CANCELLED')

shift_events                 (append-only)
  id, organization_id, shift_id → shifts, type, actor_type GUARD|USER|SYSTEM, actor_user_id, device_id,
  client_event_id NULL, occurred_at (server), client_recorded_at NULL, payload jsonb, created_at
  UNIQUE (shift_id, client_event_id) WHERE client_event_id IS NOT NULL
  types: CREATED, UPDATED, REASSIGNED, CANCELLED, STARTED, START_REJECTED, ENDED, AUTO_ENDED,
         FORCE_ENDED, EXTENDED, MARKED_MISSED, REOPENED, ENTERED_SITE, LEFT_SITE,
         TRACKING_DEGRADED, TRACKING_RESTORED
  -- START_REJECTED payloads hold no coordinates (INV-08)

shift_live_state             (projection; rebuildable from source tables; never the source of truth)
  shift_id PK, organization_id, guard_id, site_id,
  last_fix_latitude, last_fix_longitude, last_fix_accuracy_m, last_fix_captured_at, last_fix_point_id,
  last_contact_at,
  geofence_state INSIDE|UNCERTAIN|OUTSIDE_SUSPECTED|OUTSIDE_CONFIRMED|UNKNOWN,
  geofence_state_since, outside_since, outside_point_count,
  tracking_issues text[], tracking_service_state RUNNING|STOPPED|PERMISSION_PROBLEM|UNKNOWN, device_report_at,
  battery_pct, is_charging, app_version, pending_queue_count, oldest_pending_at,
  updated_at

location_points              (append-only; high volume)
  id, organization_id, guard_id, shift_id NULL, sos_event_id NULL, device_id,
  client_event_id uuid NOT NULL,
  latitude, longitude, accuracy_m NULL, altitude_m, speed_mps, heading_deg,
  recorded_at   -- phone clock at capture, as reported (preserved, never overwritten)
  captured_at   -- server-estimated true capture time (ARCH §8.7); used for ordering and queries
  received_at   -- server receipt
  clock_status VERIFIED_MONOTONIC|DEVICE_CLOCK_ONLY|SKEWED,
  source TRACKING|SHIFT_START|SHIFT_END|CHECKPOINT|INCIDENT|SOS,
  provider GPS|NETWORK|FUSED|UNKNOWN, is_mock bool NULL, flags text[],
  app_version, sync_batch_id, created_at
  UNIQUE (device_id, client_event_id)          -- see ARCH §6.5 before partitioning

device_status_events         (append-only; short retention)
  id, organization_id, guard_id, device_id, shift_id NULL, client_event_id, recorded_at, received_at,
  location_permission ALWAYS|WHEN_IN_USE|DENIED|RESTRICTED|NOT_DETERMINED, precise_location bool,
  location_services_enabled bool, notifications_enabled bool, battery_pct, is_charging,
  power_save_mode bool, battery_optimization_exempt bool NULL, auto_time_enabled bool NULL,
  oem_steps_confirmed text[], tracking_service_state, app_version, os_version, pending_queue_count, oldest_pending_at,
  last_successful_sync_at
  UNIQUE (device_id, client_event_id)

patrol_runs
  id, organization_id, shift_id → shifts, guard_id, site_id, patrol_route_id → patrol_routes,
  sequence_no int, due_at, window_ends_at,
  status PENDING|IN_PROGRESS|COMPLETED|INCOMPLETE|MISSED|CANCELLED,
  started_at, completed_at, required_count, counted_count, unconfirmed_count, created_at, updated_at
  UNIQUE (shift_id, patrol_route_id, sequence_no)

checkpoint_visits            (append-only)
  id, organization_id, guard_id, shift_id NULL, checkpoint_id NULL (NULL when INVALID_QR),
  patrol_route_id NULL, patrol_run_id NULL, device_id, client_event_id,
  scanned_at_recorded, scanned_at (server-estimated), received_at,
  latitude NULL, longitude NULL (both NULL when NO_ACTIVE_SHIFT, INV-08), accuracy_m, fix_age_s, distance_m, distance_band_m, is_mock,
  verification_status VERIFIED|LOCATION_UNCONFIRMED|OUTSIDE_RADIUS|WRONG_SITE|INVALID_QR|NO_ACTIVE_SHIFT|DUPLICATE,
  verification_reason, flags text[], counted bool, qr_token_version NULL, created_at
  UNIQUE (device_id, client_event_id)
  -- the scanned token itself is never stored

incidents
  id, organization_id, reference_number text NOT NULL, guard_id NULL, reported_by_user_id,
  shift_id NULL, sos_event_id NULL, site_id NULL, checkpoint_id NULL,
  type, severity, title (≤120), description (≤4000), latitude, longitude, accuracy_m,
  occurred_at, reported_at, received_at,
  status OPEN|ACKNOWLEDGED|RESOLVED, acknowledged_by, acknowledged_at, resolved_by, resolved_at,
  resolution_note, client_event_id NULL, device_id NULL, version, created_at, updated_at
  UNIQUE (organization_id, reference_number), UNIQUE (device_id, client_event_id)
  CHECK (guard_id IS NULL OR shift_id IS NOT NULL OR sos_event_id IS NOT NULL)   -- guards file incidents only during a shift or an open SOS (INV-08)

incident_events              (append-only)
  id, organization_id, incident_id → incidents,
  type CREATED|NOTE_ADDED|STATUS_CHANGED|SEVERITY_CHANGED|TYPE_CHANGED|ATTACHMENT_ADDED|ATTACHMENT_REJECTED,
  actor_type, actor_user_id, body (≤4000), from_value, to_value, created_at

incident_attachments
  id, organization_id, incident_id → incidents, client_event_id,
  original_storage_key, view_storage_key, mime_type (from magic bytes), size_bytes, width, height,
  sha256, capture_source IN_APP_CAMERA|GALLERY, exif_captured_at NULL, exif_latitude NULL, exif_longitude NULL,
  status PENDING_UPLOAD|PROCESSING|AVAILABLE|REJECTED, rejection_reason, created_at
  UNIQUE (incident_id, client_event_id)

sos_events
  id, organization_id, guard_id, shift_id NULL, device_id, client_event_id,
  activated_at_recorded, activated_at (server-estimated), received_at,
  latitude NULL, longitude NULL, accuracy_m NULL,
  status ACTIVE|ACKNOWLEDGED|RESOLVED, guard_cancel_requested_at NULL,
  alert_sent_at NULL (a provider accepted a push or SMS), notified_at NULL (display receipt, §13.1),
  acknowledged_by, acknowledged_at, resolved_by, resolved_at,
  resolution GENUINE|FALSE_ALARM|ACCIDENTAL|DRILL|OTHER NULL, resolution_note,
  is_drill bool DEFAULT false, alert_id, version, created_at, updated_at
  UNIQUE (device_id, client_event_id)
  UNIQUE (guard_id) WHERE status IN ('ACTIVE','ACKNOWLEDGED')   -- one open SOS per guard

alerts
  id, organization_id, type, severity LOW|MEDIUM|HIGH|CRITICAL,
  status OPEN|ACKNOWLEDGED|RESOLVED|DISMISSED, dedupe_key text NOT NULL,
  summary (server-generated plain text),
  guard_id, site_id, shift_id, checkpoint_id, patrol_run_id, incident_id, sos_event_id (nullable, composite FKs),
  opened_at, last_triggered_at, trigger_count int,
  acknowledged_by, acknowledged_at, resolved_by NULL (system), resolved_at,
  resolution_type MANUAL|CONDITION_CLEARED|SHIFT_ENDED|SUPERSEDED NULL,
  dismissed_by, dismissed_at, dismiss_reason,
  escalation_level int DEFAULT 0, next_escalation_at NULL, detected_late bool DEFAULT false,
  version, created_at, updated_at
  UNIQUE (organization_id, dedupe_key) WHERE status IN ('OPEN','ACKNOWLEDGED')

alert_events                 (append-only)
  id, organization_id, alert_id → alerts,
  type OPENED|RETRIGGERED|REOPENED|ACKNOWLEDGED|ESCALATED|NOTIFIED|SEEN|RESOLVED|AUTO_RESOLVED|DISMISSED|NOTE,
  actor_type, actor_user_id, note, payload jsonb, created_at

notification_deliveries      (status updated by workers and provider callbacks; never deleted except retention)
  id, organization_id, recipient_user_id, alert_id NULL, sos_event_id NULL, type,
  channel PUSH|SMS|EMAIL, status QUEUED|SENT|DELIVERED|FAILED|SUPPRESSED, dedupe_key UNIQUE,
  attempt int, provider, provider_message_id, error_code, created_at, sent_at, delivered_at, failed_at

exports
  id, organization_id, requested_by, type, params jsonb, status QUEUED|RUNNING|READY|FAILED|EXPIRED,
  storage_key, row_count, error_code, expires_at, created_at, completed_at

audit_logs                   (append-only)
  id, organization_id NULL (NULL only for platform-level events), actor_type USER|SYSTEM|PLATFORM_OPERATOR,
  actor_user_id, action, resource_type, resource_id, reason NULL, request_id, ip_address inet,
  user_agent, metadata jsonb, created_at

outbox                       (internal)
  id, organization_id, topic, payload jsonb, created_at, processed_at NULL, attempts int

realtime_events              (replay buffer, §14; written only by the outbox dispatcher)
  organization_id, seq bigint, type, payload jsonb (IDs only), created_at
  PK (organization_id, seq)    -- seq assigned after commit; pruned after 5 min or beyond 10,000 per organization

quarantined_items            (short retention; sync items that hit a server error, §9.3)
  id, organization_id, device_id, batch_id, client_event_id, item jsonb, error_code, created_at, replayed_at NULL
```

### 6.4 Indexes (validate against EXPLAIN on realistic volume; do not index every column)

```text
location_points        (organization_id, guard_id, captured_at); (shift_id, captured_at); UNIQUE (device_id, client_event_id)
shifts                 (organization_id, starts_at); (guard_id, starts_at);
                       (organization_id, status, starts_at) WHERE status IN ('SCHEDULED','ACTIVE')
shift_live_state       (organization_id)
alerts                 (organization_id, status, created_at); (next_escalation_at) WHERE status = 'OPEN'
incidents              (organization_id, created_at); (organization_id, status)
checkpoint_visits      (shift_id, scanned_at); (checkpoint_id, scanned_at)
patrol_runs            (organization_id, status, window_ends_at)
audit_logs             (organization_id, created_at); (organization_id, resource_type, resource_id)
notification_deliveries (status, created_at) WHERE status = 'QUEUED'
outbox                 (created_at) WHERE processed_at IS NULL
mobile_sessions        UNIQUE (refresh_token_hash); (family_id)
quarantined_items      (created_at) WHERE replayed_at IS NULL
```

Performance verification uses a dedicated environment seeded with ≥ 10 million location rows.

### 6.5 Partitioning (design for it; do not build it prematurely)

- `location_points` and `device_status_events` are designed so monthly range partitioning on `captured_at` / `received_at` can be added when volume requires (roughly > 100 M rows, or retention deletes become expensive). `captured_at` is safe as a partition key because ingestion bounds it to the shift window and the maximum offline age.
- **Trap:** a PostgreSQL unique index on a partitioned table must include the partition key, and `captured_at` is not identical across retries of the same event. When partitioning is introduced, idempotency moves to a separate non-partitioned `ingest_keys (device_id, client_event_id, received_at)` table checked in the same transaction (retained ≥ max offline age + margin).
- Dropping partitions implements the global maximum retention; shorter per-organization retention uses batched deletes.

### 6.6 ERD

Phase 0 generates a Mermaid ERD from the schema into `docs/ARCHITECTURE.md`, regenerated whenever migrations change.

---

## 7. Shift engine

- The state machine (PROD §6.3) is a pure function in `packages/domain`: `transition(shift, command, actor, now, settings) → { newState, events, effects } | error`. Unit tests are table-driven over every (state × command × actor) combination (ADV-SH01).
- Each transition runs in one transaction: lock the shift row (`SELECT … FOR UPDATE`) or compare `version`, apply, insert `shift_events`, insert `audit_logs` when the actor is a user, insert outbox rows (patrol run generation, live-state creation, realtime, alert evaluation).
- Commands from phones carry a `client_event_id`; a repeat returns the original outcome (ADV-SH02).
- `start_deadline_at` = `starts_at + shift.missed_after_minutes`, recomputed on edit; set to `ends_at` on reopen.
- Online guard start uses server receipt time as `actual_started_at` (INV-07). Offline-synced start uses `captured_at` (ARCH §8.7) with `start_source = APP_OFFLINE_SYNCED`; if `clock_status` is not `VERIFIED_MONOTONIC` the start is flagged.
- A START captured offline inside the start window that arrives after the start deadline moves the shift MISSED → ACTIVE (late sync) and auto-resolves `SHIFT_MISSED` (PROD §6.3–§6.4, ADV-SH06).
- Detectors (ARCH §16): late/missed every 60 s; auto-end and overrun every 60 s. Each compares timestamps against `now` (catch-up safe), never assumes it ran on every tick.
- Bulk create: domain function expands the weekly pattern in the site timezone into instants (DST-correct via IANA zones), validates each row, returns a preview; commit inserts all rows in one transaction (exclusion constraint is the final guard against overlaps).

---

## 8. Mobile location subsystem

### 8.1 Library choice (D-07) — decided by evidence

Phase 0B builds the same minimal tracker with each candidate and measures it on real devices:

| Candidate | Notes |
|---|---|
| `expo-location` background updates + `expo-task-manager` | free; less control over Android foreground-service behaviour and heartbeats; reliability on aggressive manufacturer builds must be proven |
| `react-native-background-geolocation` (Transistorsoft) | mature motion detection and persistence; Android release builds require a paid licence per app (EXT-12); evaluate using it for capture only, with our own outbox and sync protocol |
| Custom native modules (Kotlin foreground service + Fused Location Provider; Swift CLLocationManager) via the Expo Modules API | maximum control, highest effort |

Criteria: 12-hour overnight gap count and duration per matrix device, battery %/hour, data MB per shift, survival after swipe-away / kill / reboot, permission-change detection, availability of monotonic timestamps and mock flags, licence and maintenance. Also measured [R3]: delivery latency and heartbeat cadence **as seen by the server** after the app is swiped away and the JavaScript runtime is killed (capture gaps alone are not enough); wake-lock use against Play's vitals thresholds; support for the New Architecture; battery and data at 60, 120 and 180 s heartbeats. Run on the pilot customer's guards' phones.

Whatever is chosen sits behind a `LocationSource` interface. Our outbox and sync protocol (ARCH §8.6) is the contract; the library is replaceable. Expect the native foreground service to own capture, the SQLite queue writes and the upload, so tracking keeps working when Android kills the JavaScript context.

### 8.2 Platform configuration

**Android**
- Foreground service of type `location` while a shift (or SOS) is active: `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION` permissions, declared service type, Play Console foreground-service declaration (EXT-04). Started from a user action in the foreground.
- Persistent, non-dismissible notification: "Shift active — sharing location with ‹Organization› until your shift ends".
- Fused Location Provider, high accuracy when moving. Record mock status (`Location.isMock()` on API 31+, older equivalent below).
- `RECEIVE_BOOT_COMPLETED` to resume an active shift after reboot where the platform allows starting a location foreground service from the background for our target SDK (verify during Phase 0B; if not allowed, post a notification asking the guard to reopen the app, and let stale/offline detection surface the gap).
- Do not depend on exact alarms (`SCHEDULE_EXACT_ALARM` is restricted on recent Android). The local end-of-shift failsafe is checked on every location callback and heartbeat.
- Declare the app as an enterprise monitoring tool in the manifest, as Google Play's monitoring policy requires, in every build on every track; CI checks it (ADV-X08). Play Protect shows guards a notice that a monitoring app is installed; onboarding explains it (PROD §7.2). The policy also requires a persistent notification whenever the app is running; whether that extends outside shifts must be confirmed against the policy text (EXT-20).
- Background location ("Allow all the time") is requested (D-35 rejected). The Play declaration (EXT-05) must justify why a foreground service started by the guard isn't enough: automatic resumption after a reboot or an OS kill during an active shift. If Play refuses, the fallback is tap-to-resume tracking without the permission, so the tracking code must keep working without it.

**iOS**
- `UIBackgroundModes: location`; `allowsBackgroundLocationUpdates = true`; **`pausesLocationUpdatesAutomatically = false`** (stationary guards must not be paused); `showsBackgroundLocationIndicator = true`.
- Accuracy best / nearest-ten-metres; distance filter from settings. Evaluate `CLLocationUpdate.liveUpdates` and `CLBackgroundActivitySession` (iOS 17+) in Phase 0B.
- Significant-location-change monitoring as a relaunch safety net.
- Record `sourceInformation.isSimulatedBySoftware` (iOS 15+).
- Known limit to verify per iOS version: after the user force-quits the app, background tracking stops until the app is reopened. Stale/offline detection makes this visible to supervisors; on reopen the app reports the interruption window.
- Privacy manifest: the boot-time and uptime APIs behind `mono_ms` and `boot_id` (§8.7) are Apple "required reason" APIs and must be declared; confirm the exact categories in Phase 0B.

Usage strings: `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSLocationTemporaryUsageDescriptionDictionary`, `NSCameraUsageDescription` — specific to this product.

### 8.3 Sampling

Implements PROD §8.2 from settings delivered by `GET /mobile/config`. Start, end, checkpoint, incident and SOS take an on-demand fix (wait ≤ 10 s for target accuracy, keep the best). Moving and stationary are detected from location alone (PROD §8.2); no motion or physical-activity permission is requested in V1.

### 8.4 Heartbeats and device status

While a shift is active and the phone is online, a HEARTBEAT item is sent every 60 s even without a new point, and rides on an upload whenever there is data. The 60 s default is provisional: Phase 0B measures battery and data at 60, 120 and 180 s and sets it. On Android the wake-up comes from a location request at the heartbeat interval, never from a partial wake lock held through the shift: Play counts foreground services in its wake-lock vitals (EXT-46). If iOS cannot heartbeat while stationary, tracking health uses a platform-specific offline threshold rather than paging supervisors about every still iPhone. DEVICE_STATUS items are sent immediately on change (permission, precise/approximate, location services, power saver, notifications, battery thresholds) and with every heartbeat as a compact delta.

### 8.5 Sync cadence

Upload every `sync.upload_interval_s` when online; immediately for SOS, start, end, scans and incidents. Failure → exponential backoff with full jitter (base 5 s, cap 5 min). A network-regained event triggers a flush, but **success is judged only by a completed request with a server response**, never by the OS "connected" flag (captive portals and dead data connections report connected).

### 8.6 Outbox

- SQLite in app-private storage, transactional writes. Survives app kill, OS kill, reboot and app update (local schema migrations are tested — ADV-O08). Never in-memory or AsyncStorage.
- Partitioned by (user, organization).
- Row: `seq` (monotonic local integer), `client_event_id` (UUIDv7), `type`, `shift_ref`, `payload`, `recorded_at`, `mono_ms`, `boot_id`, `attempts`, `next_attempt_at`, `status`, `last_error`.
- **Lanes**
  - SOS lane: `SOS`, `SOS_LOCATION`, `SOS_CANCEL_REQUEST`. Sent immediately and independently; never behind other items.
  - Main lane: `SHIFT_START`, `LOCATION`, `HEARTBEAT`, `DEVICE_STATUS`, `CHECKPOINT_SCAN`, `INCIDENT`, `INCIDENT_NOTE`, `SHIFT_END`. Sent in `seq` order, **one batch in flight at a time**, so the server sees a shift's START before its points and its points before its END.
  - Upload lane: incident photos (ARCH §12), after the incident is acknowledged.
- **Per-item results** from the server: `ACCEPTED` | `DUPLICATE` (treated as accepted) | `QUARANTINED` (the server kept the item for operator replay after an internal error; treated as accepted) | `REJECTED` (permanent, with code) | `RETRY` (transient). The phone deletes ACCEPTED, DUPLICATE, QUARANTINED and REJECTED items; REJECTED is logged to diagnostics and shown when meaningful (e.g., `START_REJECTED`). Whole-batch failure (network, 5xx, 429) → retry the same batch with the same IDs; an error in one item never fails the batch (§9.3).
- **Limits:** batch ≤ 500 items and ≤ 512 KB compressed. Items older than `sync.max_offline_age_hours` are dropped (the server would reject them). If queued location items exceed 20,000, the oldest are thinned to one per 60 s. SOS, start, end, scans and incidents are never dropped or thinned.

### 8.7 Time and clock integrity

- Every item carries `recorded_at` (phone wall clock, ms), `mono_ms` (a monotonic clock that keeps counting during deep sleep: Android `SystemClock.elapsedRealtime*` / `Location.getElapsedRealtimeNanos()`; iOS a continuous clock such as `mach_continuous_time` — verify in Phase 0B) and `boot_id` (Android `Settings.Global.BOOT_COUNT`; iOS derived from boot time).
- Every batch carries `sent_mono_ms` and `boot_id`.
- Server estimate:
  - same boot → `captured_at = received_at − (sent_mono_ms − item.mono_ms)`, `clock_status = VERIFIED_MONOTONIC`;
  - different boot → `captured_at = recorded_at` corrected by the last measured offset for that device, `clock_status = DEVICE_CLOCK_ONLY`;
  - `|recorded_at − captured_at| > 120 s` → flag `SKEWED_CLOCK`, raise the `CLOCK_SKEW` tracking issue.
  - `captured_at` is clamped to ≤ `received_at`; a phone clock more than 120 s ahead of receipt is flagged `SKEWED_CLOCK`. Nothing is rejected for being in the future.
- Every response carries `X-Server-Time`; the app warns when its clock is more than 2 min off.
- If the chosen library cannot supply per-fix monotonic timestamps, record `mono_ms` at callback time and document the added error.

### 8.8 Lifecycle and failsafes

- Tracking starts only after a START (local or server) and stops on: END tapped; local deadline (`ends_at + auto_end_after`); server reports the shift not ACTIVE; sign-out; guard disabled; device revoked.
- On launch, foreground and every heartbeat response the phone reconciles its local shift state with the server; **server state wins**.
- Permission or service changes → immediate DEVICE_STATUS item and an in-app/notification prompt to fix.
- After reboot or app update during a shift, tracking resumes where the platform permits; otherwise the guard is prompted and the gap is reported.
- If reconciliation finds the shift ACTIVE with a later end than the one the local failsafe used (an extension made while the phone was offline), the phone notifies the guard "Shift extended — tap to resume tracking" and reports the gap.

### 8.9 Spoofing evidence (collected, never claimed as proof)

`is_mock`, provider, accuracy, implied speed and jumps, clock status, and root/jailbreak heuristics (flag only, D-29). Surfaced as flags and `SUSPICIOUS_LOCATION` alerts.

### 8.10 Budgets (targets to measure in Phase 0B and Phase 4)

- Battery: ≤ 3% per hour with screen off on a mid-range Android during an active shift.
- Mobile data: ≤ 5 MB per 12-hour shift excluding photos. This is a hard limit, because guards pay for their own data (confirmed 2026-10-08).
If not met, adjust sampling before building more features.

### 8.11 On-device data

Queue in app-private storage, deleted after acknowledgement. No location in device logs or crash reports. Tokens in secure storage. Local database encryption: D-27.

---

## 9. Ingestion pipeline

### 9.1 Endpoint

`POST /api/v1/sync/batch` accepts ordered main-lane items. SOS uses `POST /api/v1/sos` (and is also accepted inside a batch with the same idempotency key).

```json
{
  "batchId": "uuid",
  "sentAt": "2026-10-08T19:57:03.120Z",
  "sentMonoMs": 912334455,
  "bootId": "41",
  "items": [
    { "clientEventId": "…", "type": "SHIFT_START", "shiftId": "…", "recordedAt": "…", "monoMs": 912300000,
      "fix": { "lat": 24.8607, "lon": 67.0011, "accuracyM": 8, "isMock": false, "provider": "FUSED" },
      "permission": { "location": "ALWAYS", "precise": true } },
    { "clientEventId": "…", "type": "LOCATION", "shiftId": "…", "recordedAt": "…", "monoMs": 912310000,
      "fix": { "lat": 24.8608, "lon": 67.0013, "accuracyM": 6, "speedMps": 1.1, "headingDeg": 90 } }
  ]
}
```

Response: `{ serverTime, results: [{ clientEventId, status, code? }], shifts: [{ shiftId, status, endsAt }], sos: [{ sosEventId, status, acknowledgedBy? }] }`.

Organization, guard and device come from the authenticated context and `X-Device-Id`, never from the body.

### 9.2 Per-item validation (in order)

1. Schema and ranges (SEC §8).
2. Device ACTIVE and owned by the guard (REPLACED: accept items captured before revocation for 72 h; LOST / COMPROMISED / ADMIN: reject all).
3. Shift belongs to the guard (else REJECTED `NOT_FOUND`).
4. Time: compute `captured_at` (ARCH §8.7); `received_at − captured_at` ≤ max offline age (else `TIMESTAMP_TOO_OLD`).
5. **Shift window:** for LOCATION, `captured_at` ∈ [actual start − 60 s, (actual end or now) + 60 s]; otherwise REJECTED `OUTSIDE_SHIFT_WINDOW` and **not stored** (INV-08). START/END follow ARCH §7. Exception: SOS-linked points while the guard has an open SOS (`captured_at ≥ activated_at`).
6. Accuracy: null → flag `ACCURACY_UNKNOWN`; > 50,000 m → REJECTED; otherwise stored, with `LOW_ACCURACY` when > the usable threshold.
7. Plausibility: implied speed from the previous accepted point > 70 m/s → flag `IMPLAUSIBLE_SPEED`.

Items that carry coordinates but fall outside any shift window and open SOS — a scan with no active shift, a rejected START, an incident — keep only derived facts, never coordinates (INV-08, ADV-P05).

Points captured during a shift but uploaded after the shift completed are **accepted** (ADV-L05). Items within a batch are processed in order, so a START earlier in the batch applies before that shift's points.

### 9.3 Write path

One transaction per batch (chunks of ≤ 500), with each item inside its own savepoint:
- insert with `ON CONFLICT (device_id, client_event_id) DO NOTHING` → DUPLICATE; if the stored row's content differs from the resubmission, keep the original, return DUPLICATE and increment `idempotency_conflict` (INV-05, INV-06);
- update `shift_live_state` by compare-and-set (only if newer `captured_at` / contact time);
- insert outbox rows (geofence evaluation, realtime);
- commit, then respond.
- an unexpected error in one item rolls back only that item's savepoint: the raw item goes to `quarantined_items` (short retention; operator replay tool), its result is `QUARANTINED`, the operator is paged, and the rest of the batch commits. One bad item never freezes a phone's upload lane (ADV-O09).

Target: p95 ≤ 300 ms for a 100-item batch.

### 9.4 Out-of-order data

- History is ordered by `captured_at`, never by insertion order or ID.
- Live state never moves backwards.
- Geofence evaluation per shift runs in `captured_at` order with a watermark. Points older than the watermark go through a backfill pass: an excursion that already ended is recorded as `LEFT_SITE`/`ENTERED_SITE` events with `detected_late = true` for history and reports, not as a live alert; a still-ongoing condition follows the normal rules.

### 9.5 Rate limits and backpressure

Per device: 60 requests/min sustained, burst 120 (SEC §9). On overload return `429` + `Retry-After`; the phone keeps its data. When the database is degraded, return `RETRY` rather than buffering in memory. SOS is never refused (INV-15).

---

## 10. Geofence, freshness and live state

- `packages/domain/geo`: haversine distance (WGS-84 mean radius; adequate for radii ≤ 5 km), point classification and the departure/return state machine from PROD §8.4, all pure and property-tested (e.g., a point with distance > radius is never INSIDE; adding accuracy never turns OUTSIDE into INSIDE).
- `packages/domain/freshness`: tracking health from (now, last_contact_at, settings) and location age from (now, last_fix_at, settings), returned as two separate results (D-36). The same functions run in the freshness detector, the snapshot endpoint, the dashboard's local ticker on desktops and phones (PROD §8.3).
- Geofence evaluator (worker, outbox-driven, one shift at a time, ordered): reads new points since the watermark, updates `shift_live_state.geofence_state`, writes `shift_events`, opens/resolves alerts. Geofence edits mid-shift reset the evaluation to use the new circle from the next point.
- `shift_live_state` is a projection that can be rebuilt from `location_points`, `device_status_events` and `shift_events` (a maintenance command exists and is tested).

---

## 11. Checkpoints and QR verification

### 11.1 QR tokens

- Token: `HMAC-SHA256(QR_TOKEN_SECRET, checkpoint_id ‖ qr_token_version)`, truncated to 128 bits, base64url (22 chars). QR content `SG1:<token>` (final prefix TBD): versioned, not a URL, no internal IDs.
- Lookup: `qr_token_hash = SHA-256(token)`, unique-indexed. A slow password hash is unnecessary for 128-bit tokens and would prevent indexed lookup.
- Reprinting: the print endpoint (Owner/Admin, audited `CHECKPOINT_QR_PRINTED`) recomputes the token from the secret. Nothing is stored encrypted, so there is no ciphertext column or decrypt path.
- Rotation: `qr_token_version + 1` produces a new token; the old one is invalid immediately; audited.
- Secret rotation: documented runbook; requires reprinting all labels (or a dual-lookup period with `hash_v2` alongside `hash_v1` until relabelled).
- Tokens never appear in logs, analytics, error reports or audit metadata.

### 11.2 Verification (server; identical for online and offline-synced scans)

Input: token, scan `recorded_at`/`mono_ms`, fix (lat, lon, accuracy, fix age, is_mock), authenticated guard and device.

1. Look up `HMAC(token)`. Not found, archived, or another organization → `INVALID_QR` (identical response; never reveal existence).
2. Active shift covering scan `captured_at` → else `NO_ACTIVE_SHIFT`, stored without coordinates (INV-08).
3. `checkpoint.site_id = shift.site_id` → else `WRONG_SITE`.
4. Same checkpoint already counted in the same run within `checkpoint.duplicate_window_s` → `DUPLICATE`. (Retrying the same `client_event_id` returns the original result, not DUPLICATE.)
5. Location:
   - checkpoint without coordinates, no fix, fix age > `checkpoint.max_fix_age_s`, accuracy > `checkpoint.max_usable_accuracy_m`, or mock under policy → `LOCATION_UNCONFIRMED`;
   - distance ≤ radius → `VERIFIED`;
   - distance − accuracy > radius → `OUTSIDE_RADIUS`;
   - otherwise → `LOCATION_UNCONFIRMED`.
6. Implied speed from the previous counting visit in the shift > `checkpoint.max_plausible_speed_mps` → flag `IMPLAUSIBLE_TRAVEL` and open/retrigger `SUSPICIOUS_LOCATION`.
7. `counted` = VERIFIED, or LOCATION_UNCONFIRMED when `patrol.count_unconfirmed_as_completed`.
8. Attach to the open run of the checkpoint's scheduled route whose window contains `captured_at`; update run counters and status.

Endpoint: `POST /api/v1/checkpoint-scans` with the token in the body. This replaces Revision 1's `POST /checkpoints/:id/verify`, which would have required the QR to contain an internal ID.

### 11.3 Patrol runs

Generated in the START transaction (outbox effect) for each scheduled route at the site; regenerated for future runs on extend or route change; closed by the patrol-run closer job (ARCH §16) and at shift end.

---

## 12. Attachments pipeline

1. Incident exists on the server (phone has the server ID).
2. `POST /incidents/:id/attachments` with `clientEventId`, declared type and size → `{ attachmentId, uploadUrl, headers, expiresAt }` — a presigned PUT, ≤ 15 min, constrained to content type and maximum length (15 MB).
3. Phone uploads a compressed JPEG (long edge ≤ 2,048 px, quality ≈ 0.8) from app-private storage; resumable via retry.
4. `POST /attachments/:id/complete` with `sha256`.
5. Worker verifies: object exists; size; magic bytes (JPEG, PNG, HEIC, WebP); pixel count ≤ 40 MP (decompression-bomb guard); sha256 match. Extracts EXIF capture time and GPS into columns. Produces a re-encoded view copy with metadata stripped. Status AVAILABLE or REJECTED.
6. Viewing: `GET /attachments/:id/url` → authorization → signed GET of the view copy, TTL ≤ 5 min. Original: `GET /attachments/:id/original-url`, Owner/Admin only, audited.

Keys: `org/{orgId}/incidents/{incidentId}/{attachmentId}/original` and `/view.jpg`. Malware scanning added if infrastructure policy requires (re-encoding already defuses most image-borne payloads).

---

## 13. SOS, alerts, escalation and notifications engines

### 13.1 SOS

`POST /sos` (idempotent by `client_event_id`; authenticated by our session token or, when the session has expired, by a request signed with the device key, §5.3):
- transaction: insert `sos_events` (or, if the guard already has an open SOS, add a RETRIGGERED alert event and update location), open `SOS_ACTIVATED` alert, set `next_escalation_at`, insert outbox rows (realtime, notifications);
- respond `{ sosEventId, status: RECEIVED }` immediately — notification fan-out is never inline.

`ALERT_SENT` is set when a notification delivery first reaches `SENT`: a provider accepted it, which means queued, not delivered. `NOTIFIED` is set only on a display or delivery receipt from a person's device. A dashboard, on a desktop or a phone, reports the alarm on screen (`POST /alerts/:id/seen`). The dashboard's web-push service worker reports that the alert arrived on a device (`POST /alerts/:id/delivered`). Or the SMS aggregator returns a delivery report for an SOS SMS.

Targets: p95 receipt → dashboard event ≤ 2 s; p95 receipt → first provider-accepted push ≤ 10 s.

### 13.2 Alert engine

- Alert rules are pure functions in `packages/domain/alerts` (inputs: event or detector state; output: open / retrigger / resolve intents with dedupe keys).
- The engine applies intents transactionally against the partial unique index on `(organization_id, dedupe_key)` for open alerts; reopen-within-suppression is handled by looking up the most recent resolved alert with the same key.
- Dedupe keys: `sos:{sosId}`, `incident:{id}`, `left_site:{shiftId}`, `tracking:{shiftId}`, `offline:{shiftId}`, `stale:{shiftId}`, `not_started:{shiftId}`, `missed:{shiftId}`, `patrol_run:{runId}`, `suspicious:{shiftId}`, `off_site_start:{shiftId}`, `overrun:{shiftId}`, `battery:{shiftId}`, `device:{deviceId}`.

### 13.3 Escalation engine

A job every 15 s selects OPEN alerts with `next_escalation_at ≤ now`, applies the organization's ladder step (PROD §11.4), creates notification deliveries, writes `ESCALATED`, sets the next step time. Acknowledgement clears `next_escalation_at`.

### 13.4 Notification engine

- Deliveries are rows; sending happens in workers via `PushProvider` / `SmsProvider` / `EmailProvider` interfaces.
- Idempotency: `dedupe_key = {alertId}:{recipientId}:{channel}:{escalationLevel}`; a retried job never double-sends.
- Retries: SOS — 3 attempts within 2 min; others — 5 within 30 min. Invalid push tokens are deactivated.
- Status meanings: QUEUED → SENT (provider accepted) → DELIVERED (provider receipt where available) | FAILED | SUPPRESSED (throttled or duplicate).
- Push priority: dashboard users get Web Push with `Urgency: high` for CRITICAL and HIGH. The browser decides how it is shown, and it follows the phone's silent and Do Not Disturb settings, which is why SOS also sends SMS to duty officers from the first second (PROD §11.4). Guards get FCM/APNs pushes (shift notifications, SOS acknowledged).
- Non-production environments send SMS only to allow-listed numbers.

---

## 14. Realtime transport

- **SSE** (D-09, approved): `GET /api/v1/stream`, served from the dashboard's own origin (§2), so the browser's HttpOnly session cookie authenticates it (EventSource cannot set headers). If token auth is ever needed, use a single-use stream ticket (`POST /stream/tickets`, valid 30 s, bound to user + organization), never logged.
- On connect: resolve membership and permissions; attach the connection to the organization's topic server-side. Clients cannot name topics. Events are filtered per recipient permissions.
- Revalidation: on membership/role change or session revocation, an internal event closes that user's connections; all connections are cycled every 30 min to re-authenticate.
- Envelope: `{ id: "<orgSeq>", type, occurredAt, data }`, with a per-organization monotonic sequence. The server keeps a short replay buffer (5 min / 10,000 events per organization). If `Last-Event-ID` is outside the buffer, the server sends `resync`; the client reloads `GET /dashboard/snapshot`.
- **The sequence is assigned after commit, by the single outbox dispatcher** (it holds an advisory lock) when it moves committed outbox rows into `realtime_events`. It is never assigned inside the business transaction: transactions commit out of order, so a client reconnecting with `Last-Event-ID` would silently skip events. The replay buffer is the `realtime_events` table, so any API instance can replay.
- Event types: `guard.state`, `alert.opened`, `alert.updated`, `sos.activated`, `sos.updated`, `incident.created`, `incident.updated`, `shift.updated`, `coverage.updated`. Payloads are minimal; details are fetched over REST.
- Fan-out: outbox → publisher → `NOTIFY` with IDs only (payload limit ~8 KB) → each API instance's dedicated listener connection → connections. Swap to Redis pub/sub only on measured need (D-11).
- Keep-alive comment every 25 s; `X-Accel-Buffering: no` and equivalent settings so proxies do not buffer.
- Monitoring coverage (PROD §11.5) = count of live dashboard connections, desktop and phone.
- Target: 500 concurrent dashboard connections in V1.

---

## 15. API conventions and endpoints

### 15.1 Conventions

- Base path `/api/v1`, from day one. JSON, camelCase. Timestamps RFC 3339 UTC with `Z`. IDs as UUID strings. Enums UPPER_SNAKE strings. Coordinates in degrees as numbers.
- Request headers: `Authorization: Bearer` with our session token (mobile) or the session cookie (web, same origin); `X-Device-Signature` (mobile SOS fallback when the session has expired); `X-Organization-Id` (web, multi-organization users); `X-Device-Id`, `X-App-Version`, `X-Platform` (mobile); `Idempotency-Key` (SHOULD on web POSTs that create resources); `X-Request-Id` (generated if absent).
- Response headers: `X-Server-Time`, `X-Request-Id`.
- Pagination: opaque cursor; default 50, max 100; stable sort.
- Concurrency: editable resources return `version`; PATCH requires it; mismatch → 409 `VERSION_CONFLICT` with the current resource.
- Errors:

```json
{ "error": { "code": "SHIFT_NOT_ACTIVE", "message": "The shift is not currently active.",
             "requestId": "…", "details": [ { "path": "fix.accuracyM", "issue": "must be > 0" } ] } }
```

  400 `VALIDATION_FAILED` · 401 `UNAUTHENTICATED` · 403 `FORBIDDEN` (insufficient permission in own organization) · 404 `NOT_FOUND` (includes other organizations' resources) · 409 state/version conflicts · 422 business-rule violations · 426 `APP_VERSION_UNSUPPORTED` · 429 `RATE_LIMITED` · 500 `INTERNAL_ERROR` · 503 not ready. No stack traces. Codes in ARCH Appendix B.
- Schemas: zod in `packages/contracts`, strict (unknown fields rejected on mutations); OpenAPI generated and committed; CI fails on drift; web and mobile use generated types.

### 15.2 Mobile compatibility

- `GET /mobile/config` → `minSupportedVersion`, `recommendedVersion`, `revokedVersions`, `disclosureVersion`, tracking and sync parameters, feature flags, `serverTime`.
- Below the minimum the app shows an update screen, but uploads of already-captured data and SOS are still accepted unless the version is on the security-revoked list (INV-15).
- API changes within v1 are additive. Removing or changing a field requires ≥ 90 days' deprecation and a minimum-version bump. Every location event carries app version and device ID (Revision 1 §90).

### 15.3 Endpoint inventory (V1)

`[perm]` is the required permission; `audited` means an audit record is written.

**Session and configuration**
- `GET /me` — user, memberships, permissions [authenticated]
- `GET /mobile/config` [authenticated]

**Members and invitations**
- `GET /members` · `PATCH /members/:id` (role, status) [members.manage; owners.manage for owner/admin targets] audited
- `POST /invitations` · `GET /invitations` · `POST /invitations/:id/revoke` [members.manage] audited
- `POST /invitations/accept` [invitation token + authenticated user] audited

**Guards and devices**
- `GET /guards` · `POST /guards` · `POST /guards/import?preview=true|false` (CSV) · `GET /guards/:id` · `PATCH /guards/:id` · `POST /guards/:id/disable` · `POST /guards/:id/terminate` [guards.*] audited
- `GET /guards/:id/location` (live) [live.read]
- `GET /guards/:id/location-history?shiftId=|from=&to=&reason=` [location.history.read] audited before data is returned
- `POST /enrollments/redeem` [enrollment code] audited (`DEVICE_REGISTERED`) · `POST /sessions/refresh` [refresh token] · `POST /guards/:id/enrollment-codes` [devices.enroll: Supervisor+] audited · `GET /guards/:id/devices` [devices.read] · `POST /devices/:id/revoke` [devices.revoke] audited
- `POST /push-tokens` · `DELETE /push-tokens/:id` [authenticated; guard-app FCM/APNs tokens and dashboard Web Push subscriptions]
- `POST /tracking-consents` [guard self]

**Sites, checkpoints, patrols**
- `GET /sites` · `POST /sites` · `GET /sites/:id` · `PATCH /sites/:id` [sites.*] audited
- `GET /sites/:id/checkpoints` · `POST /sites/:id/checkpoints` · `PATCH /checkpoints/:id` · `POST /checkpoints/:id/rotate-qr` [checkpoints.write] audited
- `GET /sites/:id/checkpoints/print-sheet` [checkpoints.qr.print] audited
- `GET /sites/:id/patrol-routes` · `POST /sites/:id/patrol-routes` · `PATCH /patrol-routes/:id` [patrols.*] audited
- `GET /patrol-runs?shiftId=|siteId=&from=&to=` [patrols.read]
- `POST /checkpoint-scans` [guard self]

**Shifts**
- `GET /shifts` · `POST /shifts` · `POST /shifts/bulk?preview=true|false` · `GET /shifts/:id` · `PATCH /shifts/:id` [shifts.*] audited
- `POST /shifts/:id/start` · `POST /shifts/:id/end` [guard self]
- `POST /shifts/:id/cancel` · `/manual-start` · `/force-end` · `/extend` · `/reopen` [shifts.supervise] audited
- `GET /me/shifts` [guard self]

**Sync**
- `POST /sync/batch` [guard self]

**Incidents and attachments**
- `GET /incidents` · `POST /incidents` · `GET /incidents/:id` · `PATCH /incidents/:id` (severity, type) · `POST /incidents/:id/notes` · `POST /incidents/:id/status`
- `POST /incidents/:id/attachments` · `POST /attachments/:id/complete` · `GET /attachments/:id/url` · `GET /attachments/:id/original-url` (audited)

**SOS**
- `POST /sos` [guard self] · `GET /sos/:id` [guard own / sos.read] · `POST /sos/:id/cancel-request` [guard own]
- `POST /sos/:id/acknowledge` [sos.ack] · `POST /sos/:id/resolve` [sos.resolve] audited
- `POST /sos-drills` · `POST /sos-drills/:id/end` [sos.drill] audited

**Alerts**
- `GET /alerts` · `GET /alerts/:id` · `POST /alerts/:id/acknowledge` · `/resolve` · `/dismiss` · `/notes` · `/seen` · `/delivered`

**Dashboard and realtime**
- `GET /dashboard/snapshot` (live states, open alerts, coverage, server time) · `GET /stream`

**Reports and exports**
- `GET /reports/attendance` · `/patrols` · `/incidents` · `/locations` · `/site-activity` [reports.read] (location report audited)
- `POST /exports` · `GET /exports/:id` · `GET /exports/:id/download` [exports.create] audited

**Audit and settings**
- `GET /audit-logs` [audit.read]
- `GET /settings` · `PATCH /settings` [org.settings.*] audited

**Operations**
- `GET /health` — process alive; no dependencies; no data
- `GET /ready` — database reachable, migrations at expected version, job system reachable

---

## 16. Background jobs and outbox

### 16.1 Transactional outbox

Side effects (realtime publish, notifications, alert evaluation, patrol-run generation, live-state creation) are written as `outbox` rows in the same transaction as the state change. A single dispatcher (it holds an advisory lock) moves them to pg-boss / NOTIFY and assigns the realtime sequence (§14). Delivery is at-least-once; every handler is idempotent.

### 16.2 Jobs

| Job | Cadence | Notes |
|---|---|---|
| Late / missed shift detector | 60 s | PROD §6.7 |
| Auto-end and overrun detector | 60 s | PROD §6.6 |
| Freshness detector (offline / stale alerts) | 60 s | `packages/domain/freshness` |
| Geofence evaluator | outbox-driven | ordered per shift, ARCH §10 |
| Patrol-run closer | 60 s | ARCH §11.3 |
| Alert escalation | 15 s | ARCH §13.3 |
| Notification sender | queue | retries, idempotent |
| Attachment processor | queue | ARCH §12 |
| Export generator | queue | PROD §15.2 |
| Retention | daily, 03:00 organization time | SEC §16.5 |
| Push-token cleanup | daily | |
| Demo shift refresher | 15 min | PROD §17 |
| Synthetic SOS canary | 5 min (production) | ARCH §18.4 |
| Partition maintenance | monthly, if partitioned | ARCH §6.5 |
| Outbox dispatcher | continuous; single instance (advisory lock) | moves committed outbox rows to jobs and `realtime_events`; assigns the realtime sequence (§14) |
| Quarantine monitor | 5 min | pages the operator on new quarantined sync items (§9.3) |
| Enrollment-code expiry | daily | expires unused codes (§5.3) |

Detectors are idempotent, tolerate missed runs (compare timestamps with `now`), batch per organization, and export lag metrics. Long-running work never depends on a web request staying open.

---

## 17. Maps

- `MapProvider` interface (Revision 1 §85): `renderMap`, `renderMarker`, `renderGeofence`, `renderRoute`, `cluster`, `geocode`. Web only in V1; the guard app needs no map tiles. Duty officers see the same web map on their phones.
- Provider (D-12, approved 2026-10-08): Google Maps Platform. Before Phase 2, confirm pricing at expected dashboard usage and the terms on storing geocoding results (pin-confirmed coordinates are user data). Use current APIs only (Advanced Markers, not the deprecated `Marker`). Test the live map with 1,000 markers spread over a very large colony, on a mid-range phone as well as a desktop.
- Browser keys restricted by HTTP referrer and enabled APIs; quotas and budget alerts on; maps lazy-loaded.
- Popups use text APIs only (never `setHTML` / `dangerouslySetInnerHTML` with user content).

---

## 18. Observability and operations

### 18.1 Logs and errors

Structured JSON logs with `request_id`, `org_id`, `user_id` (IDs only); error tracking with scrubbing (SEC §15). Tracing optional.

### 18.2 Metrics

`location_upload_success_rate`, `location_upload_latency`, `ingest_items_total{status,code}`, `idempotency_conflict_total`, `offline_sync_backlog` and `oldest_pending_age` (from heartbeats), `active_shifts`, `stale_locations`, `offline_devices`, `tracking_issues{type}`, `geofence_departures`, `sos_events`, `sos_receipt_to_dashboard_ms`, `sos_receipt_to_first_notify_ms`, `sos_unacknowledged_open`, `notification_delivery_rate{channel}`, `job_lag_seconds{job}`, `outbox_backlog`, `sse_connections`, `monitoring_coverage{org}`, `api_error_rate`, `db_pool_saturation`, `clock_skew_devices`, `mock_location_flags`, `quarantined_items_total`, `sos_receipt_to_notified_ms`, `enrollment_redemptions_total{result}`, `tracking_health{state}`.

### 18.3 Targets (V1)

| Target | Value |
|---|---|
| API availability (ingest and SOS paths) | 99.9% monthly |
| SOS receipt → dashboard event | p95 ≤ 2 s |
| SOS receipt → first provider-accepted push | p95 ≤ 10 s |
| Sync batch (100 items) | p95 ≤ 300 ms |
| Detector lag | ≤ 2 min |
| Dashboard snapshot (1,000 active guards in one organization) | p95 ≤ 1 s |

### 18.4 Platform alerting and synthetic SOS

- Operator on-call alerts (not customer alerts): SOS pipeline errors, synthetic canary failure, notification provider failure rate > 5%, job lag > 2 min, ingest error rate > 2%, database health, certificate expiry, any organization with an SOS unacknowledged > 10 min (check delivery health).
- Synthetic canary: an internal organization; every 5 min a simulated device sends an SOS through the public API; the canary measures receipt, alert creation, realtime event and a push to an internal test device, then resolves it. Excluded from customer data and metrics.

### 18.5 Health

`/health` = alive; `/ready` = ready to serve (Revision 1 §69).

### 18.6 Mobile diagnostics

Device status events plus crash reporting without location or personal data (Revision 1 §92).

### 18.7 Runbooks (`docs/RUNBOOKS/`)

SOS notifications failing · notification provider outage · database restore · mass device offline · key rotation (QR token secret, session signing keys, provider keys) · replaying quarantined sync items · onboarding a large organization (bulk import, batched invitations) · tenant data incident response · revoking an app version.

---

## 19. Environments, CI/CD, data and release

### 19.1 Environments

development · staging · production. Separate cloud projects/accounts, credentials, buckets, push and SMS credentials. Non-production SMS goes only to allow-listed numbers. Production location data is never used for development. Hosting per D-13: production is made of cells, one per data region; V1 runs one cell, on AWS in eu-central-1, Frankfurt (D-37).

### 19.2 Staging

Test organizations, guards, sites, simulated shifts and alerts. The simulator scripts scenarios: "guard leaves site", "offline 30 min", "SOS while offline", "100 guards normal night", "reconnection storm".

### 19.3 CI on every pull request (a failing security test blocks merge)

typecheck · lint (must actually run) · unit · integration on real PostgreSQL in containers **as `app_runtime`** with RLS · security suite (cross-tenant, authorization, route-policy meta-test) · migration validation (empty database and seeded snapshot; down-migrations where defined) · OpenAPI drift · dependency audit · secret scanning · mobile typecheck/lint/unit · **native permission allow-list check** (merged AndroidManifest permissions and Info.plist usage keys must match an allow-list; a library that silently adds a permission fails CI) · build all apps · schema linter (ADV-X01) · negative controls proving the security tests can fail (ADV-X02) · ID traceability (ADV-X03) · generated-docs drift (ADV-X04) · coordinate-field audit meta-test (ADV-X05) · generated idempotency test (ADV-X06) · runtime-role startup check (ADV-X07) · Play monitoring-tool declaration (ADV-X08) · no `@sentry/*` workspace packages.

### 19.4 Migrations

All schema changes via migrations; never manual production changes. Deterministic, reviewable, reversible where practical, tested. Expand/contract for anything older phones touch. RLS policies, grants and constraints are part of migrations. Data backfills are separate idempotent scripts.

### 19.5 Seed and demo

Deterministic seed: Demo Company with 10 guards, 5 sites (realistic coordinates and geofences), 20 shifts covering every state, 4 patrol routes, incidents, alerts, and simulator-generated tracks for completed shifts. Demo organization for development, QA and store reviewers, with no real people (PROD §17).

### 19.6 Backups and disaster recovery

Managed PostgreSQL with point-in-time recovery (RPO target ≤ 15 min), daily snapshots kept 35 days, encrypted; multi-AZ in production. Backups are also copied to a second region: in 2026, war damage made some single-region cloud data in the Gulf unrecoverable. For the first cell, database backups and files are replicated to eu-west-1, Ireland (§19.8). Object storage versioning and lifecycle rules. RTO target ≤ 4 h. Restore drill before launch and quarterly. Single points of failure documented.

### 19.7 Mobile release

- EAS build profiles for development, staging and production with distinct bundle IDs and app names; a staging build cannot reach production.
- Staged rollout on Play and phased release on the App Store.
- Over-the-air updates only for JavaScript-only changes; never for native configuration, permissions or tracking behaviour that depends on native code.
- App version gating through `/mobile/config`.
- Builds target Android API 36, required for new apps and updates since 31 Aug 2026 (verified 2026-10-08).
- Every release: smoke test on 3 matrix devices (one Pixel-class, one aggressive-manufacturer Android, one iPhone).

### 19.8 Cloud security baseline (first cell, D-37) [R3]

The first cell runs on AWS in eu-central-1 (Frankfurt), with backups in eu-west-1 (Ireland). These are the minimum controls. Phase 0 sets them up as infrastructure as code (Terraform), and production is never changed by hand:

- **Accounts.** Separate AWS accounts for staging and production under AWS Organizations. People sign in through IAM Identity Center with MFA; root users are locked away with MFA and no access keys.
- **Identity.** One least-privilege IAM role per service (API, workers, retention, migrations); no long-lived access keys anywhere.
- **Database.** RDS for PostgreSQL:
  - in private subnets with no public endpoint;
  - Multi-AZ, with TLS required and encryption at rest with KMS;
  - point-in-time recovery for 35 days;
  - automated backups copied to eu-west-1, through RDS cross-region backup replication or AWS Backup (confirm in Phase 0).
- **Files.** S3 with Block Public Access, KMS encryption and versioning, replicated to eu-west-1. Access only through short-lived presigned URLs (§12).
- **Secrets.** AWS Secrets Manager, separate per environment (SEC §13).
- **Edge.** Application Load Balancer accepting TLS 1.2+ only. AWS WAF managed rules sit in front of the API, complementing the application's own rate limits.
- **Detection.** CloudTrail in every account and GuardDuty switched on, with findings routed to the operator on-call (§18.4).
- **Cost.** Arm (Graviton) instance types, a smaller staging environment, and Savings Plans once usage is stable. The bill is reviewed monthly.

---

## 20. External dependencies, approvals and platform constraints [R2]

Things outside the codebase that can block or reshape the product late. Phase 0 copies this register into `docs/EXTERNAL_DEPENDENCIES.md` with owner and status, and starts every long-lead item immediately. **Every item must be re-verified against the current official source when acted on; policies change.**

### 20.1 Approvals and accounts (human-owned; start in Phase 0)

| ID | Item | Why | Lead-time / risk | Needed by |
|---|---|---|---|---|
| EXT-01 | Legal-entity verification for developer accounts (D-U-N-S number for an organization enrolment). The company is registered in Pakistan (confirmed 2026-10-08) | Apple and Google organization accounts | days to weeks; blocks everything below | start now; Phase 0B |
| EXT-02 | Apple Developer Program (organization) | iOS device builds, TestFlight, App Store | after EXT-01 | Phase 0B |
| EXT-03 | Google Play Console (organization) | Android distribution; new personal accounts need 12 testers for 14 days before production (verified 2026-10-08), so use an organization account | identity verification lead time | Phase 4 |
| EXT-04 | Play foreground-service type declaration (location) | Android 14+ apps using a location foreground service | review; may need a video | before first Play track release |
| EXT-05 | Play background-location permission declaration | `ACCESS_BACKGROUND_LOCATION` is requested (D-35 rejected) | review with a video of the prominent disclosure and the feature; rejections are common; plan ≥ 2 cycles. Play may ask why a foreground service started by the guard isn't enough: the justification is automatic resumption after a reboot or OS kill during a shift. Fallback if refused: tap-to-resume without the permission (§8.2) | before first Play track release (submit at the end of Phase 4) |
| EXT-06 | Play Data safety form; current target-API-level requirement (API 36 since 31 Aug 2026, verified 2026-10-08) | listing requirement; target level deadlines recur yearly | moderate | Phase 10 |
| EXT-07 | Apple Critical Alerts entitlement | no longer needed: there is no native supervisor app (D-04) | — | — |
| EXT-08 | App Store review of background location and a login-gated B2B app | review notes, demo account | days; rejection risk | Phase 10 |
| EXT-09 | APNs key and Firebase project (FCM) | push | low | Phase 5 |
| EXT-10 | Pakistani SMS aggregator with verified delivery on Jazz, Zong, Telenor and Ufone; sender-ID / masking registration with the company's documents (verify operator/regulator requirements) | guard invitations and new-phone codes (D-02), SOS escalation | registration can take weeks; delivery quality varies by route | start now; Phase 2 (guard enrollment), Phase 8 |
| EXT-11 | Identity provider production instance for dashboard users: email, MFA (authenticator app or passkeys), custom domain. Guards no longer depend on it (D-02) | dashboard sign-in | low | Phase 1 |
| EXT-12 | Background-location library licence (if D-07 selects a commercial library) | Android release builds | purchase tied to package name | Phase 4 |
| EXT-13 | Google Maps Platform billing account, restricted keys, quotas and budget alerts; terms on storing geocoded coordinates (D-12) | dashboard maps | low | Phase 2 |
| EXT-14 | Cloud account for the first cell: AWS eu-central-1, with backups in eu-west-1 (D-13, D-37); managed PostgreSQL version and extensions (`btree_gist`, `citext`, `pgcrypto`); PITR; direct connections for LISTEN/NOTIFY; backups copied to a second region | core infrastructure | a missing extension is an architectural dead end. Checked 2026-10-08: no hyperscaler region exists in Pakistan; among local providers only QCloud claims managed PostgreSQL with PITR (vendor claim: test a real restore and the extensions first); Gulf regions carry war risk (2026) | Phase 0 |
| EXT-15 | Email sending domain with SPF, DKIM, DMARC; reputation warm-up | invitations, export notices | days to weeks | Phase 1 |
| EXT-16 | Public URLs for privacy policy, terms, support | store listings, disclosures | low | Phase 10 |
| EXT-17 | Legal review: data protection law in each operating country (for Pakistan, verify the status of personal data protection legislation at launch), employee-monitoring and labour rules, guard disclosure text in each language, retention defaults, data residency | lawful operation | weeks | before production data |
| EXT-18 | Expo Application Services plan and build quotas; signing credentials management | builds | low | Phase 0B |
| EXT-19 | Customer-side readiness: QR labels printed and installed, guard phones meeting minimum OS (D-20), guard mobile data | pilot | per customer | pilot |
| EXT-20 | Google Play monitoring-tool declaration (`isMonitoringTool`), persistent-notification rule and listing disclosure; Play Protect shows guards a monitoring-app notice | enterprise employee-monitoring policy | reviewed with the app; confirm whether the notification must show outside shifts | before first Play track release |
| EXT-21 | Apple guideline 5.1.5: location-based APIs must not be used to provide emergency services | SOS must be described as alerting the company's control room (app copy, listing, review notes) | rejection risk | Phase 8, Phase 10 |
| EXT-22 | Reviewer access without a Pakistani SMS | Apple 2.1(a) requires a working demo account; reviewers cannot receive +92 SMS | pre-issued demo enrollment code in the review notes (PROD §17) | before the first review |
| EXT-23 | iOS distribution route for a B2B app | Apple Business custom apps don't list Pakistan; use public or unlisted App Store distribution, both reviewed (D-25) | low | Phase 10 |
| EXT-24 | Private GitHub repository | CI (ARCH §19.3) runs on GitHub Actions; until it exists, `pnpm verify` runs locally only | low | Phase 0 |

### 20.2 Platform constraints that shape the design

| ID | Constraint | Design response |
|---|---|---|
| EXT-30 | Android 11+: background location is granted separately, through settings | two-step permission flow (PROD §7.3) |
| EXT-31 | Android 14+: foreground services need a declared type; Android 12+ restricts starting foreground services from the background | start tracking from a user action; verify reboot resume path in Phase 0B |
| EXT-32 | Android manufacturers (Xiaomi, Oppo/Realme, Vivo, Samsung, Huawei, Transsion brands) kill background apps beyond stock Android | guided setup, readiness check, device matrix, visible gaps |
| EXT-33 | Play policy restricts `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` to qualifying use cases | open the settings screen instead unless the policy is confirmed to allow it |
| EXT-34 | Play policy restricts `SEND_SMS` / `READ_SMS` to default SMS apps | phone opens the SMS composer; never sends in background |
| EXT-35 | Android 14+ restricts full-screen intents to calling/alarm apps (Play declaration) | not used: there is no native supervisor app (D-04) |
| EXT-36 | Exact alarms are restricted on recent Android | failsafes checked on callbacks, not alarms |
| EXT-37 | Android 11+ revokes permissions of apps unused for months | readiness item; detect and prompt |
| EXT-38 | iOS: user force-quit stops background location until reopened | stale detection + interruption report |
| EXT-39 | iOS/Android silent, Do Not Disturb and Focus suppress ordinary notifications, web push and SMS alike; iOS web push needs the dashboard installed to the home screen (16.4+) | SMS to duty officers from the first second, setup test, dashboard alarm, a staffed control room (PROD §11.5) |
| EXT-40 | Browsers block audio until user interaction | "Enable alarm sound" control and warning |
| EXT-41 | Serverless platforms cannot host long-lived SSE streams, listeners or workers | long-lived processes for API and workers |
| EXT-42 | Transaction-mode connection poolers break session `SET` and `LISTEN` | `SET LOCAL` per transaction; dedicated listener connection |
| EXT-43 | PostgreSQL unique indexes on partitioned tables must include the partition key | separate ingest-key table when partitioning (ARCH §6.5) |
| EXT-44 | Expo Go cannot run background location; over-the-air updates cannot change native configuration; Expo SDK 55+ supports only the New Architecture | development builds; OTA policy (ARCH §19.7); every native module must support the New Architecture |
| EXT-45 | Store policies on location, data safety and target API level change yearly | re-verify at each submission |
| EXT-46 | Since 1 Mar 2026 Play counts partial wake locks held by foreground services in its wake-lock vitals (over 2 h a day with the screen off in more than 5% of sessions → battery warning on the listing, less discovery) | heartbeats wake on location callbacks, never on a held wake lock (§8.4); Phase 0B checks each candidate library |

---

## 21. Testing strategy

Adversarial and security tests are specified in SEC §18. This section covers the rest.

### 21.1 Layers

- **Unit** — `packages/domain`: geofence, freshness, state machines, verification, capture-time estimation, alert rules, CSV escaping. Property-based tests (fast-check) for geometry and time estimation (e.g., `captured_at ≤ received_at` always; classification monotonic in distance).
- **Integration** — real PostgreSQL, `app_runtime` role, RLS on. Every endpoint: happy path, validation, authorization, cross-tenant.
- **Contract** — OpenAPI drift; web and mobile compile against generated types.
- **Time-travel** — fake clock for detectors, escalation ladders, auto-end, retention.
- **Mobile** — outbox ordering, acknowledgement handling, retries, thinning, user partitioning, local migrations; state reconciliation; readiness logic; simulated location sources.
- **End-to-end (staging)** — simulator scenarios plus browser tests of dashboard flows (SOS appears with alarm, acknowledgement, freshness transitions on the live map).

### 21.2 Load and performance

Simulate 2,000 active guards, 1,000 of them in one organization (mix of moving points every 30 s and stationary every 5 min, heartbeats every 60 s) for 1 h; a reconnection storm (1,000 devices, a whole pilot-sized organization, each uploading a 60-minute backlog within 2 min); 500 SSE dashboard connections. Must meet ARCH §18.3 with no data loss and database CPU < 70%.

### 21.3 Real-device matrix (humans execute; results in `docs/testing/device-matrix.md`)

**Android:** Pixel-class (stock) · Samsung mid-range (One UI) · Xiaomi/Redmi (HyperOS/MIUI) · Oppo or Realme (ColorOS) · Vivo (Funtouch/OriginOS) · Infinix or Tecno (XOS/HiOS) · one low-RAM device · oldest supported Android version (D-20) and the latest.
**iOS:** current iPhone on the latest iOS · oldest supported iPhone/iOS (D-20).

**Scenarios:** foreground · background · screen locked · 12-hour overnight soak on battery with screen off · poor GPS (indoors/basement) · poor network · no network · captive Wi-Fi (connected but no internet) · battery saver / low-power mode · location services off · permission downgraded to "while using" mid-shift · precise → approximate mid-shift · notifications disabled · app swiped from recents · force-stop (Android) / force-quit (iOS) · device reboot mid-shift · app update mid-shift · manual clock change ±2 h · timezone change · low storage · SOS with screen locked · SOS in airplane mode, then reconnect.

**Record:** device, OS, build, scenario, result, gap count and longest gap, battery %/h, data MB, notes.

### 21.4 Initial tracking-reliability gate (refined after Phase 0B)

On each matrix device, correctly set up, over a 12-hour screen-off soak: no gap longer than 10 min while stationary or 5 min while moving, except where the OS or user stopped the app — in which case the gap is visible on the dashboard within `offline_after` + 1 min. Universal background reliability is never claimed beyond what was tested.

---

## 22. Implementation phases

Every phase delivers: schema + migrations, backend, frontend (web and/or mobile), tests (unit, integration, security), documentation and `REPORT.md`. Exit = listed tests pass in CI + human checklist signed off + product owner approval.

| Phase | Scope | Read | Exit tests |
|---|---|---|---|
| **0 Architecture** (no feature code) | repo skeleton, tooling, CI skeleton with real lint, `CLAUDE.md`, architecture doc with flows and ERD, `THREAT_MODEL.md`, permission map and route-policy mechanism, API conventions, error catalog, environments, `EXTERNAL_DEPENDENCIES.md` with long-lead items started, decisions presented and recorded in `docs/DECISIONS.md`; RLS proof-of-concept test showing a cross-tenant read blocked under `app_runtime`; CI mechanisms ADV-X01–X08 from day one | all three docs | RLS PoC; CI runs; ADV-X01, X02, X07 |
| **0B Tracking spike** (parallel with 1; throwaway code; real devices) | minimal dev build per D-07 candidate: start/stop tracking, SQLite outbox, upload to a throwaway endpoint, device status, monotonic time, mock flag; 12-h soaks on ≥ 4 matrix devices, including the pilot customer's guards' phones; battery and data measured at 60, 120 and 180 s heartbeats; server-side delivery latency after swipe-away; wake locks; New Architecture support | ARCH §8, §20, §21.3 | recommendation for D-07, heartbeat and sampling defaults approved |
| **1 Identity + tenancy** | identity provider for dashboard users, our mobile session service (D-30), users, operator provisioning CLI, organizations (with their cell's region), members, invitations, permissions, request context, RLS + composite-FK pattern, route registry + meta-test, audit service, settings service, `/me`, dashboard shell with sign-in and organization switch | PROD §3–4; ARCH §4–6; SEC §2, §4–6, §17 | ADV-T01, T06, T09, A02, A05, A06, A07, A09, W03, X03, X04 |
| **2 Guards + sites** | guards (including bulk CSV import), guard enrollment by invitation SMS (D-02) and new-phone codes (D-31), mobile shell (enrollment, disclosure + consent, diagnostics), i18n setup (Urdu + English guard app), sites with map pin and geofence, checkpoints, QR generation / print / rotate, patrol route configuration | PROD §4–5, §7.1–7.3; ARCH §5, §11.1, §17 | ADV-T04, T05, A01, A10, A11, A12, Q05 |
| **3 Shifts** | CRUD, bulk create, state machine, online start/end, manual start / force-end / extend / reopen / cancel, late/missed/auto-end detectors, shift events, guard shift list, dashboard shift pages; guard shift notifications ship with push in Phase 5 | PROD §6; ARCH §7, §16 | ADV-SH01–SH06, A03, T07, TM01, TM03 |
| **4 Mobile location subsystem** | chosen library, readiness check, permission flows, outbox and lanes, sync endpoint, idempotency, per-item quarantine, capture-time estimation, live state, heartbeats, device status, offline start/end, failsafes; a minimal live view (snapshot polling, tracking health and location age) and the attendance report, then **Pilot 0** once tracking is proven (D-34); first Play closed-testing submission (EXT-04, EXT-05, EXT-20) | PROD §6.5–6.6, §7.4–7.6, §8; ARCH §8–9 | ADV-L01–L12, O01–O09, A08, P01, P05, U02, U03, U04, X05, X06; device-matrix subset on the pilot's phones (human) |
| **5 Geofence + alerts** | geofence evaluator, freshness detectors, alert engine (catalog, dedupe, auto-resolve, reopen suppression), push notifications to guards (including shift notifications), web push to dashboard users and a phone-friendly alerts view for duty officers (D-04), tracking-health UI (D-36), basic alert UI | PROD §8.3–8.4, §12–13; ARCH §10, §13.2–13.4 | ADV-G01–G06, AL01–AL05 |
| **6 Live operations dashboard** | SSE, snapshot, live map on Google Maps (D-12; tested with 1,000 markers, also on phones), exception home with coverage, guard detail, location history viewer with audit | PROD §14; ARCH §14 | ADV-T02, A04, W01, P02, U01 |
| **7 Patrols** | run generation, scans online/offline, verification, run closer, patrol UI on mobile and web | PROD §9; ARCH §11 | ADV-Q01–Q09, T08 |
| **8 Incidents + SOS** | incidents with attachments, SOS end to end (with display receipts), escalation ladder, SMS, dashboard alarm, SOS acknowledgement from duty officers' phones (web), drill mode, synthetic canary; SOS is turned on for pilot guards only after these exit tests pass | PROD §10–11; ARCH §12–13 | ADV-S01–S11, F01–F05, T10 |
| **9 Reports + exports** | all reports, background CSV exports, CSV safety, retention job with evidence preservation | PROD §15–16; SEC §16 | ADV-T03, W02, P03, P04, TM02 |
| **10 Hardening + launch** | full adversarial suite, full device matrix, load tests, restore drill, Fable audit and fixes, privacy and legal documents, store submissions, production deployment, runbooks verified | everything | PROD §18 Definition of Done |

Dependencies: 0 → (0B ∥ 1) → 2 → 3 → 4 (needs 0B) → 5 → 6 → 7 → 8 → 9 → 10.

---

## 23. Cost and scale

- Revision 1 example: 1,000 guards × 1 point/min × 8-hour shifts = 480,000 rows/day. At roughly 200–300 bytes per row including indexes that is about 100–150 MB/day, or roughly 10–14 GB at 90-day retention. 2,000 guards with 30-second moving intervals is 2–4× more.
- Controls: batched uploads; indexes validated by query plans; snapshot + SSE instead of querying the location table on every refresh; downsampling for map rendering; retention; partitioning when needed (ARCH §6.5).
- Maps are billed per dashboard map load, not per data refresh. SMS cost is bounded by the escalation ladder, throttles and the non-SOS cap. Push is free.

---

## Appendix A — Technical decisions

Status: **OPEN** unless marked APPROVED or REJECTED; `docs/DECISIONS.md` holds the reasoning.

| ID | Question | Options | Recommendation | Needed by |
|---|---|---|---|---|
| D-01 | Identity provider | Clerk · Auth0 · other mature provider | **Scope APPROVED 2026-10-08:** dashboard users only; guards enroll per D-02. Provider: Clerk recommended; confirm its MFA options before Phase 1 | Phase 1 |
| D-07 | Background location implementation | expo-location · Transistorsoft · custom native | decide on Phase 0B evidence | Phase 4 |
| D-08 | SMS in V1 | yes (SOS escalation, invitations) · no | **APPROVED 2026-10-08:** yes, for guard invitations and new-phone codes (D-02) and SOS escalation, through a Pakistani aggregator (EXT-10) | Phase 2 / 8 |
| D-09 | Realtime transport | SSE · WebSocket | **APPROVED 2026-10-08:** SSE, keeping the replay buffer and per-organization sequence, assigned after commit (§14) | Phase 6 |
| D-10 | Database access and migrations | Kysely · Drizzle | **APPROVED 2026-10-08:** Kysely, plain SQL migrations, `kysely-codegen` types | Phase 0 |
| D-11 | Jobs, pub/sub, rate-limit store | PostgreSQL only (pg-boss, LISTEN/NOTIFY, per-instance token buckets) · Redis (BullMQ, pub/sub, shared limits) | PostgreSQL only for V1 | Phase 0 |
| D-12 | Map provider | Google Maps · Mapbox | **APPROVED 2026-10-08:** Google Maps Platform (owner preference); confirm pricing and terms before Phase 2 | Phase 2 |
| D-13 | Hosting region and data residency | cells (one deployment per region) · two regions at launch · one region for everyone | **APPROVED 2026-10-08:** cells, launching with one; each organization's region chosen at provisioning; the first cell runs on AWS in Frankfurt (D-37) | Phase 0 |
| D-19 | Organization provisioning and operator access | operator CLI · self-serve | operator CLI; documented break-glass (SEC §4.6) | Phase 1 |
| D-20 | Minimum OS versions | — | from launch-market device data and library support (e.g., Android 9/10+, iOS 16+); verify | Phase 0B |
| D-23 | V1 scale target | — | A-05; the pilot organization alone has about 1,000 guards | Phase 0 |
| D-26 | Push delivery path | direct FCM/APNs · Expo push service | direct FCM/APNs for the guard app (one fewer third party); Web Push (VAPID) for the dashboard (D-04) | Phase 5 |
| D-32 | Realtime reconnection | snapshot only · replay buffer + per-organization sequence | **REJECTED 2026-10-08** (snapshot only): the replay buffer and sequence are kept, with the sequence assigned after commit | Phase 6 |
| D-37 | Cloud provider for the first cell | AWS · Google Cloud · Azure · smaller providers | **DECIDED 2026-10-08** (the owner delegated: "any cloud service … secure"): AWS eu-central-1, Frankfurt, with backups in eu-west-1, Ireland, and the security baseline in §19.8; Supabase and Firebase were compared and not chosen (`docs/DECISIONS.md`) | Phase 0 |

---

## Appendix B — Error codes

| Code | HTTP | Meaning |
|---|---|---|
| VALIDATION_FAILED | 400 | schema or range violation (details[] included) |
| UNAUTHENTICATED | 401 | missing or invalid credentials |
| FORBIDDEN | 403 | authenticated but lacks permission in own organization |
| NOT_FOUND | 404 | does not exist **or belongs to another organization** |
| ORG_CONTEXT_REQUIRED | 400 | multi-organization user omitted `X-Organization-Id` |
| ORG_SUSPENDED | 403 | organization suspended (SOS still accepted) |
| VERSION_CONFLICT | 409 | optimistic concurrency failure |
| SHIFT_INVALID_TRANSITION | 409 | transition not allowed from current state |
| SHIFT_OVERLAP | 409 | guard already has a shift in that period |
| SHIFT_NOT_ACTIVE | 409 | operation needs an ACTIVE shift |
| SHIFT_OUTSIDE_START_WINDOW | 422 | too early or after the start deadline |
| TRACKING_PERMISSION_REQUIRED | 422 | phone-reported permission insufficient under policy |
| LOCATION_FIX_REQUIRED | 422 | no fresh fix attached |
| STARTED_OFF_SITE_BLOCKED | 422 | start outside geofence when policy is BLOCK |
| OUTSIDE_SHIFT_WINDOW | 422 | location captured outside the shift window |
| TIMESTAMP_TOO_OLD | 422 | beyond maximum offline age |
| DEVICE_NOT_REGISTERED | 403 | missing or unknown `X-Device-Id` |
| DEVICE_REVOKED | 403 | device revoked |
| INVALID_QR | 422 | unknown, rotated, archived or foreign QR |
| LAST_OWNER | 409 | would leave the organization without an owner |
| SELF_ROLE_CHANGE | 403 | attempt to change own role or status |
| INVITATION_EXPIRED | 410 | invitation or enrollment code expired, used or revoked |
| ENROLLMENT_CODE_INVALID | 422 | wrong enrollment code, or the code doesn't match the phone number |
| ATTACHMENT_TOO_LARGE | 413 | over size limit |
| ATTACHMENT_TYPE_NOT_ALLOWED | 415 | content does not match an allowed type |
| EXPORT_RANGE_TOO_LARGE | 422 | export range > 92 days |
| APP_VERSION_UNSUPPORTED | 426 | below minimum (not returned for SOS or queued uploads unless revoked) |
| RATE_LIMITED | 429 | with `Retry-After` |
| INTERNAL_ERROR | 500 | no internals exposed |
| NOT_READY | 503 | dependency unavailable |


