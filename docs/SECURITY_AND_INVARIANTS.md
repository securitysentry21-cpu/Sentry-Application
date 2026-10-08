# Security Guard Operations & Tracking Platform
# SECURITY_AND_INVARIANTS.md — What must never be allowed to happen

| | |
|---|---|
| Spec revision | 2 |
| Date | 2026-10-08 |
| Approver | Product owner (Faraz) |
| Implementation agent | Claude Code |
| Audit agent | Fable |

---

## 0. Document set (identical block in all three documents)

| Document | Answers | Section prefix |
|---|---|---|
| `PRODUCT_SPEC.md` | What the product does, for whom, with which rules and defaults | `PROD §` |
| `ARCHITECTURE.md` | How it works technically, how it is built, in which order | `ARCH §` |
| `SECURITY_AND_INVARIANTS.md` | What must never be allowed to happen, and how that is proven | `SEC §` |

**Precedence when documents disagree:** `SECURITY_AND_INVARIANTS.md` > approved decisions in `docs/DECISIONS.md` > `PRODUCT_SPEC.md` > `ARCHITECTURE.md` > implementation convenience. A conflict between two statements at the same level is a STOP condition (ARCH §0.3).

**Normative words:** MUST / MUST NOT = required (violation is a defect). SHOULD = expected; deviation needs a recorded reason. MAY = optional. "Default" = a configurable value from PROD Appendix B; never hard-coded.

**Identifiers:** `INV-nn` invariants (SEC §2) · `D-nn` decisions (appendices of each document; numbering is global) · `ADV-xnn` adversarial tests (SEC §18) · `EXT-nn` external dependencies and approvals (ARCH §20) · `A-nn` assumptions (PROD §2.3). Tests SHOULD carry the ID they prove in their name.

---

## 1. How to use this document

- This document wins over the other two.
- Every invariant must be enforced by a **mechanism** — a database constraint, grant or policy; a test in CI; or a CI check — not by a comment or a paragraph of documentation. An invariant without a mechanism is an open defect.
- When a change touches anything below and the correct behaviour is not obvious: STOP (ARCH §0.3).
- SEC §20 lists the ways implementations usually get this wrong. Read it before Phases 1, 4, 6 and 8.

---

## 2. Critical invariants (non-negotiable)

| ID | Invariant | Mechanism | Proven by |
|---|---|---|---|
| INV-01 | A user can access only organizations where they hold an ACTIVE membership. | request context; RLS | ADV-T01, T06, T09 |
| INV-02 | A guard cannot access another guard's data (location, incidents, shifts, profile). | route policies with ownership rules | ADV-A01, A03 |
| INV-03 | Nobody can modify their own role, permissions or membership status; nobody can grant a role above their own authority. | service rules; tests | ADV-A02, A05, A06 |
| INV-04 | Location data belongs to exactly one tenant and is never readable across tenants. | RLS; composite FKs | ADV-T06, L02 |
| INV-05 | Location, checkpoint-visit, shift-event, incident-event, alert-event, consent and audit records are never silently rewritten or deleted. Corrections are new records. Deletion happens only through the audited retention process. | append-only grants (runtime role has INSERT + SELECT only); retention role | ADV-L09, P03; SEC §19 grant check |
| INV-06 | Every client event the phone can create offline carries a `client_event_id`; resubmission never creates a second record. | unique constraints | ADV-L01, Q04, S03 |
| INV-07 | Server time is authoritative for server-side state transitions; phone time is evidence, never authority. | injectable server clock; capture-time estimation | ADV-TM03, L10 |
| INV-08 | Tracking stops when the shift ends. The server rejects and does not store location captured outside an active shift window. The only exception is an active SOS. | phone failsafe; ingestion validation | ADV-L04, SH05, P01 |
| INV-09 | No interface presents a stale or unknown location as current. | shared freshness function; local ticking | ADV-U01 |
| INV-10 | SOS is never shown to the guard as received, notified or acknowledged before the corresponding server confirmation. | SOS client state machine | ADV-S01, S02 |
| INV-11 | A QR code alone never authorizes checkpoint completion; the server decides using identity, shift, site, time and location evidence. | verification algorithm (ARCH §11.2) | ADV-Q02, Q05, Q06, Q07 |
| INV-12 | Every protected operation is authorized on the server. Hiding UI is never a control. | route registry; meta-test | ADV-A09 |
| INV-13 | Every tenant-owned row carries a non-null `organization_id`, and the database rejects references across organizations. | composite FKs; NOT NULL | ADV-T04 |
| INV-14 | Every privileged read of historical location (view or export) and every security-sensitive change writes an audit record in the same transaction; reads are audited before data is returned. | audit service inside the transaction | ADV-P02; audit tests per action |
| INV-15 | SOS acceptance is never rate-limited, de-duplicated away, blocked by a minimum-version gate (except a version revoked for security) or blocked by organization suspension. Only notifications are throttled. | SOS route class exempt; tests | ADV-S04 |
| INV-16 | The phone never claims a server-side outcome (synced, verified, notified, delivered, acknowledged) it has not received confirmation for. | client state models | ADV-U03, S02, O02 |
| INV-17 | Organization context is never taken from request bodies or query strings; it comes from the authenticated session plus a validated membership. | request context; strict schemas | ADV-A10, T09 |

```text
Bad:   if (user.role === "admin") showDeleteButton();      // UI hiding as a control
Good:  request → authenticate → resolve organization → authorize permission
               → authorize resource → validate → business rules → execute → audit
```

---

## 3. Threat model

Phase 0 produces `docs/THREAT_MODEL.md` with a STRIDE analysis per component (mobile app, API, workers, dashboard, database, object storage, providers) and maps every mitigation to a requirement and a test. Threats that MUST be covered:

- malicious guard · malicious supervisor · malicious dispatcher · compromised account · stolen phone (including unsynced data) · compromised supervisor phone · insider platform operator · shared control-room PC left signed in;
- GPS spoofing · replayed location events · offline replay · forged or skewed timestamps · duplicate events;
- modified API requests · IDOR · mass assignment · tenant breakout through APIs, realtime, jobs, caches, exports or files;
- stolen or photographed QR codes;
- malicious uploads (spoofed types, decompression bombs, polyglots);
- stored XSS through guard-entered text (incident text, names) in dashboards and map popups · CSV formula injection in exports;
- notification abuse and SMS pumping/toll fraud through OTP or invitations · alert suppression · SOS failure modes;
- API scraping · credential stuffing · denial of service through reconnection storms;
- log injection · leaked secrets or map keys · misconfigured bucket · dependency/supply-chain compromise · a library silently adding native permissions.

---

## 4. Tenant isolation requirements

### 4.1 Scope

Isolation applies to: API responses, database queries, realtime streams, background jobs, notifications, reports, exports, search, audit logs, file attachments, caches, queues, scheduled jobs, logs and error reports.

### 4.2 Requirements

1. Organization context comes only from the authenticated session and a validated ACTIVE membership (INV-17).
2. Every tenant table has `organization_id NOT NULL`, RLS enabled and forced, and composite FKs to its tenant parents (INV-13). Any table without RLS is listed in `docs/DECISIONS.md` with the reason.
3. The runtime database role does not own tables and does not have `BYPASSRLS`.
4. Requests for another organization's resources return 404 — indistinguishable from "does not exist".
5. Jobs carry `organization_id` and run with that context; cross-organization sweeps only enumerate work and never write across tenants.
6. Realtime subscriptions are bound server-side to the organization of the authenticated membership; clients cannot choose topics.
7. Object keys are prefixed by organization; buckets are private; access only through short-lived signed URLs issued after authorization.
8. Caches are keyed by organization and never shared across tenants.

### 4.3 Organization suspension

A suspended organization's users cannot use the dashboard; SOS events from its guards are still accepted and stored (INV-15).

### 4.4 Users across organizations

The design MUST NOT assume one user = one organization for dashboard roles. A guard user belongs to exactly one organization (A-04), enforced by a unique constraint.

### 4.5 Search and listing

There is no global user search. Listing users is always through memberships of the current organization.

### 4.6 Platform operator access

The platform operator has no standing access to tenant data through the product. Access for support or incident response uses a documented break-glass procedure: time-limited, reason required, recorded as `PLATFORM_ACCESS` in the tenant-visible audit log. V1 implements this as a procedure, not tooling (D-19).

---

## 5. Authentication and session security

- A mature identity provider (D-01). The application never stores passwords.
- MFA enforced for Owner and Administrator; SHOULD for Supervisor.
- Guard OTP abuse controls: per-number and per-IP limits, country allow-list, provider fraud controls (SMS pumping).
- Invitations: ≥ 128-bit random token, stored hashed, single use, 7-day expiry, bound to organization + role (+ guard).
- Disabled users and revoked sessions: tokens rejected within 60 s; realtime connections closed (ADV-A07).
- Mobile tokens in Keychain / Keystore; never in plain storage or logs.
- A device belongs to one guard; requests carry `X-Device-Id`, validated against the authenticated guard; revoked devices handled per ARCH §5.4 (ADV-A08).
- A guard cannot sign out during an active shift; an admin revoking a guard's access during a shift force-ends the shift with a recorded reason.
- Dashboard sessions on shared control-room PCs: the product shows who is signed in on every screen; session lifetime follows provider configuration; renewal failure shows a blocking signed-out screen.

---

## 6. Authorization requirements

1. Every route is declared with its permission, resource loader and ownership rule; unregistered routes cannot be mounted; a CI meta-test fails on any route without a policy (ADV-A09).
2. Resource authorization always checks the resource's organization against the context, and for guard-owned resources the guard against the context guard.
3. No self-role or self-status changes (`SELF_ROLE_CHANGE`). Administrators cannot create, modify or remove Owners or Administrators. The last ACTIVE Owner cannot be demoted, disabled or removed (`LAST_OWNER`).
4. Mutations use strict schemas: unknown fields are rejected, and identity fields (`organizationId`, `guardId`, `userId`, `role`) are never accepted from the body where the server derives them (mass-assignment protection, ADV-A10).
5. Never trust `organization_id`, `guard_id`, `user_id`, `site_id`, `shift_id` from the client without validating ownership (Revision 1 §63).
6. Permission checks use permission strings from the single role → permission map (PROD §3.2), never role-name comparisons scattered in code.
7. Role and membership changes take effect on the next request and close realtime connections within 60 s.

---

## 7. Data integrity and evidence

- Append-only tables (ARCH §6.1) are enforced by database grants, not convention (INV-05).
- Guard-submitted incident content is immutable; changes by supervisors are events with old and new values.
- Idempotency for every offline-capable event (INV-06). A resubmission with the same `client_event_id` but different content keeps the original and is counted as an anomaly.
- History is ordered by server-estimated capture time, never by insertion order (ARCH §8.7, §9.4).
- Location acceptance is judged by capture time relative to the shift window, not by the shift's current state: offline data captured during a shift is accepted after the shift ends; data captured outside it is rejected and not stored (INV-08).
- Server receipt time is always preserved; phone time is preserved as evidence; neither overwrites the other.
- Projections (`shift_live_state`) are never the source of truth and can be rebuilt.
- Incident photos keep the original privately with its sha256; views use a re-encoded copy.

---

## 8. Input validation and output encoding

**Input** (shared zod schemas; never trust mobile clients):

| Field | Rule |
|---|---|
| latitude / longitude | [−90, 90] / [−180, 180] |
| accuracy_m | > 0; null allowed (flagged); > 50,000 rejected |
| altitude_m | [−500, 10,000] |
| speed_mps | [0, 150] else flagged |
| heading_deg | [0, 360) |
| timestamps | RFC 3339 with offset; after estimation not later than receipt + 2 min; not older than max offline age |
| IDs | UUID format |
| enums | exact values |
| text | title ≤ 120, description/notes ≤ 4,000, names ≤ 120; control characters stripped |
| arrays | batch ≤ 500 items; photos ≤ 5 per incident |
| files | size and type per SEC §12 |
| phone numbers | E.164 |

**Output:**
- All user-supplied text renders as text: no `dangerouslySetInnerHTML`, no map-popup `setHTML`, no HTML in push/SMS templates (ADV-W01).
- CSV exports: RFC 4180 quoting; any cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with a single quote (ADV-W02).
- Logs: user text is never interpolated into log messages as structure (log injection).

---

## 9. Rate limiting

Limits are keyed by device, user, phone number or organization — not only by IP, because mobile carriers put many guards behind the same address (CGNAT). Responses: 429 + `Retry-After` + `RATE_LIMITED`.

| Class | Default |
|---|---|
| OTP send | 3 per phone per 15 min; 20 per IP per hour; country allow-list |
| Sign-in attempts | provider defaults + 10 per account per 15 min |
| Sync batches | 60 per device per min sustained, burst 120 |
| Checkpoint scans | 60 per guard per min |
| Incident creation | 20 per guard per hour |
| Attachment upload slots | 30 per guard per hour |
| Invitations | 100 per organization per day |
| Reports | 30 per user per min |
| Exports | 1 running per user; 20 per organization per day |
| **SOS** | **never rejected** (INV-15); duplicates fold into the open SOS; notifications throttled instead |

Limits must not reject legitimate reconnection backlogs: the phone sends sequential batches and respects `Retry-After`; nothing is lost when throttled (ADV-L12).

---

## 10. Web security

- Session cookies HttpOnly, Secure, SameSite (Lax or Strict); CSRF protection on all state-changing requests authenticated by cookie (ADV-W03).
- Strict Content Security Policy (no inline scripts; map provider domains allow-listed); `frame-ancestors 'none'`; HSTS; `X-Content-Type-Options: nosniff`; CORS allow-list.
- No secrets in client bundles. Browser map keys restricted by referrer and API.
- The dashboard never queries the database directly; all data goes through the API.

---

## 11. Mobile security

- TLS 1.2+ only. Debug and staging builds cannot point at production (distinct bundle IDs and configuration).
- No secrets in the app bundle. Mobile map keys (if any) restricted by package name / bundle ID and signing certificate.
- Certificate pinning not in V1 (risk of locking users out on rotation) — D-28.
- Root/jailbreak detection is a flag, never a block — D-29.
- Native permissions are allow-listed in CI; any library that adds a permission (contacts, SMS, microphone, etc.) fails the build.
- Local queue in app-private storage, deleted after acknowledgement; encryption at rest per D-27.
- No location, tokens or incident text in device logs or crash reports.

---

## 12. File security

- Upload only through presigned URLs constrained to content type and maximum length (15 MB); short expiry.
- Server verifies magic bytes (never the filename extension), size, pixel dimensions (≤ 40 MP) and sha256; re-encodes for viewing, stripping metadata.
- Stored outside the database, in a private bucket, keyed by organization.
- Access only through authorization + signed GET URL with TTL ≤ 5 min. Originals: Owner/Admin only, audited.
- A user cannot guess a storage URL and retrieve another organization's file (ADV-F03, T10).
- Scanned for malware if infrastructure or customer policy requires.

---

## 13. Secrets and keys

- Never in source control. Examples: `DATABASE_URL`, identity provider secrets, `MAPS_API_KEY`, object storage credentials, push credentials, SMS credentials, `QR_TOKEN_PEPPER`, the QR token encryption key.
- Stored in the environment's secret manager; separate values per environment; least-privilege cloud IAM per process (API, workers, retention).
- Rotation procedures documented for each secret, including the QR pepper (ARCH §11.1) and identity signing keys.
- Secret scanning in CI and pre-commit.

---

## 14. Supply chain

- Lockfile committed; exact versions for security-relevant and native dependencies.
- CI dependency audit fails on High/Critical, with a reviewed allow-list file for justified exceptions.
- Automated update PRs (Renovate or Dependabot).
- Licence allow-list.
- New dependencies justified in the phase report (purpose, maintenance, licence, native permissions added).
- Third-party providers on the SOS path are minimized (D-26).

---

## 15. Logging and error-reporting hygiene

Never log or send to error tracking: access/refresh tokens, OTPs, passwords, invitation tokens, QR tokens, precise coordinates, incident text, photos, phone numbers. Use IDs. The logger's redaction configuration is unit-tested. Every log line carries `request_id`; tenant-scoped entries carry `org_id`.

---

## 16. Privacy and data protection

### 16.1 Principles

Location is sensitive. Collection is tied to a legitimate product function (shift operations and emergencies); minimal; transparent to guards; accessible on a least-privilege basis; retained only as configured. Controls: TLS, encryption at rest where supported, least privilege, access controls, audit logging, retention, secure file storage, secret management (Revision 1 §83).

### 16.2 Collection boundaries

- Location only during ACTIVE shift windows and an active SOS (INV-08). Nothing at sign-in, app open off-shift, or in the background between shifts.
- Readiness-check fixes stay on the phone; only the fix attached to a start action is uploaded.
- Not collected: contacts, microphone, call logs, other apps' usage, photo-library browsing (system picker only).
- Device diagnostics limited to what ARCH §6.3 `device_status_events` lists.

### 16.3 Transparency and consent

- In-app disclosure before any permission request (PROD §7.2); versioned; acceptance recorded with version and language in an append-only table; re-shown when the version changes.
- Tracking always visibly indicated while active.
- The guard can see their own shift history and, per D-22, their own location trail.

### 16.4 Access to historical location

Only roles with `location.history.read`; every view or export is audited before data is returned (INV-14); reason field present, mandatory when the organization requires (D-21). Owners can review who accessed what in the audit log.

### 16.5 Retention

- Configurable per organization; defaults in PROD Appendix B are product defaults, not legal requirements; legal review required.
- Daily retention job per organization, batched deletes (partition drops when partitioned), executed by `retention_worker`.
- **Evidence preservation:** location points within ±`retention.incident_evidence_window_minutes` of an incident or SOS on the same shift are kept as long as that incident/SOS is kept.
- `RETENTION_RUN` audit entry with counts only.
- Backups expire within the backup retention period (35 days); this is disclosed in the privacy policy.
- Legal holds: not in V1; the design must allow adding them.

### 16.6 Guard lifecycle and data-subject requests

- Terminated guards' records follow retention; their account is disabled; anonymization after retention per legal review.
- Owner/Admin can produce an export of one guard's data (profile, shifts, location, incidents they authored) through the export system (audited). Deletion or anonymization requests follow the legal review outcome.

### 16.7 Legal review checklist (human, before any production data — EXT-17)

Data protection law in each operating country (verify current status at launch) · employee-monitoring and labour rules · customer contracts · data residency (D-13) · privacy policy · guard disclosure text in every language · retention defaults · push/SMS content · cross-border transfer to providers (identity, push, SMS, maps, error tracking).

### 16.8 Privacy policy requirements

Must specifically explain: what location data is collected; when; why; who can access it; which service providers process it; retention; deletion; security; user rights where applicable; contact information. A generic "we may collect information" template is not acceptable.

---

## 17. Audit logging

### 17.1 Actions

| Area | Actions |
|---|---|
| Identity & membership | MEMBER_INVITED, INVITATION_REVOKED, INVITATION_ACCEPTED, ROLE_CHANGED, MEMBER_DISABLED, MEMBER_REMOVED, USER_DISABLED |
| Guards & devices | GUARD_CREATED, GUARD_UPDATED, GUARD_DISABLED, GUARD_TERMINATED, DEVICE_REGISTERED, DEVICE_REVOKED, TRACKING_CONSENT_RECORDED |
| Sites & patrols | SITE_CREATED, SITE_UPDATED, GEOFENCE_CHANGED, CHECKPOINT_CREATED, CHECKPOINT_UPDATED, CHECKPOINT_QR_ROTATED, CHECKPOINT_QR_PRINTED, PATROL_ROUTE_CREATED, PATROL_ROUTE_UPDATED |
| Shifts | SHIFT_CREATED, SHIFTS_BULK_CREATED, SHIFT_UPDATED, SHIFT_REASSIGNED, SHIFT_CANCELLED, SHIFT_MANUAL_START, SHIFT_FORCE_ENDED, SHIFT_EXTENDED, SHIFT_REOPENED |
| Location | LOCATION_HISTORY_VIEWED, LOCATION_HISTORY_EXPORTED, LOCATION_REPORT_VIEWED |
| Incidents | INCIDENT_CREATED (dashboard), INCIDENT_UPDATED, INCIDENT_STATUS_CHANGED, ATTACHMENT_ORIGINAL_DOWNLOADED |
| Alerts & SOS | ALERT_ACKNOWLEDGED, ALERT_RESOLVED, ALERT_DISMISSED, SOS_VIEWED, SOS_ACKNOWLEDGED, SOS_RESOLVED, SOS_DRILL_STARTED, SOS_DRILL_ENDED |
| Organization | SETTINGS_CHANGED, EXPORT_REQUESTED, EXPORT_DOWNLOADED, RETENTION_RUN, PLATFORM_ACCESS |

### 17.2 Record and rules

- Fields: id, organization_id, actor_type, actor_user_id, action, resource_type, resource_id, reason, request_id, ip_address, user_agent, metadata, created_at.
- Written in the same transaction as the action; if the audit insert fails the action fails (INV-14).
- Append-only by grants.
- Metadata: IDs and changed field names/values for configuration only; no coordinates, tokens, descriptions or phone numbers (masked if the change itself concerns such a field).
- Tamper-evident hash chaining per organization: not in V1; design must allow it.

---

## 18. Adversarial test suite

The implementation is **not complete** until every test below exists, runs in CI (or, where marked *device*, has a recorded human result) and passes. Tests are named with their ID. Phase assignment: ARCH §22.

### 18.1 Tenant isolation (T)

| ID | Attempt | Must |
|---|---|---|
| ADV-T01 | Organization A user requests an organization B guard, site, shift, incident, alert | 404 for every resource type |
| ADV-T02 | Organization A user opens the realtime stream with B's ID in `X-Organization-Id`, or keeps a stream open after losing membership | rejected; connection closed within 60 s; zero B events received |
| ADV-T03 | Organization A export with B's IDs inserted into parameters | no B data in output |
| ADV-T04 | Create a shift/route/checkpoint in A referencing B's site, guard or checkpoint — through the API **and directly at the database layer** | rejected by API and by composite FK |
| ADV-T05 | A's admin requests B's QR print sheet or rotates B's QR | 404 |
| ADV-T06 | Generated test: for **every** tenant table, as `app_runtime` with A's context, select all rows | zero B rows; zero rows when no context is set |
| ADV-T07 | Job whose payload is for A attempts to read or write B rows | zero rows / failure |
| ADV-T08 | B's QR scanned by an A guard | `INVALID_QR`, response identical to an unknown token |
| ADV-T09 | User sets `X-Organization-Id` to an organization without membership | rejected |
| ADV-T10 | A user requests a signed URL for B's attachment, or uses an A URL after expiry | 404 / denied |

### 18.2 Authorization (A)

| ID | Attempt | Must |
|---|---|---|
| ADV-A01 | Guard A reads guard B's location, profile, incidents or shifts | 404 |
| ADV-A02 | Guard (or any user) modifies their own role or status | `SELF_ROLE_CHANGE` |
| ADV-A03 | Guard starts, ends or scans on another guard's shift | 404 |
| ADV-A04 | Dispatcher requests location history or a location export | 403 |
| ADV-A05 | Administrator creates, edits, disables or removes an Owner or Administrator | 403 |
| ADV-A06 | Demote, disable or remove the last Owner | `LAST_OWNER` |
| ADV-A07 | Disabled user's token is used; disabled user's stream stays open | rejected within 60 s; stream closed |
| ADV-A08 | Device revoked as COMPROMISED uploads; device revoked as REPLACED uploads pre-revocation data | rejected; accepted within 72 h |
| ADV-A09 | Meta-test over the route registry | every route has a policy and a cross-tenant fixture |
| ADV-A10 | Mutations include `organizationId`, `guardId`, `userId`, `role` in the body | rejected or ignored; never applied |

### 18.3 Location ingestion (L)

| ID | Submit | Must |
|---|---|---|
| ADV-L01 | the same location event twice | one row; second result DUPLICATE |
| ADV-L02 | location for a shift of another organization or another guard | rejected |
| ADV-L03 | capture time in the future | clamped and flagged, or rejected; never stored as future |
| ADV-L04 | location captured after the shift ended (beyond tolerance) | rejected and **not stored** |
| ADV-L05 | location captured during the shift but uploaded after the shift completed | **accepted** |
| ADV-L06 | points arriving out of order | history ordered by capture time; live state never regresses |
| ADV-L07 | accuracy 5 m, 50 m, 500 m, null | geofence and checkpoint rules behave per PROD §8.4, §9.3 |
| ADV-L08 | a batch mixing valid and invalid items | per-item results; valid items stored |
| ADV-L09 | the same `client_event_id` with altered coordinates | original kept; DUPLICATE; anomaly metric incremented |
| ADV-L10 | phone clock set 2 h ahead | `captured_at` correct via monotonic estimate; flagged SKEWED_CLOCK |
| ADV-L11 | points flagged as mock | stored with flag; checkpoint policy applies; SUSPICIOUS_LOCATION opens |
| ADV-L12 | reconnection storm causing 429s | no data loss; phone respects `Retry-After` |

### 18.4 Offline (O)

| ID | Scenario | Must |
|---|---|---|
| ADV-O01 | internet lost 30 min, then restored | every valid event synchronized exactly once |
| ADV-O02 | shift started offline | phone shows "waiting to confirm"; dashboard shows not started until sync; then ACTIVE with offline flag |
| ADV-O03 | offline start rejected by the server on sync | phone stops tracking, shows the reason, drops that shift's points |
| ADV-O04 | app killed with a pending queue | queue survives; resumes |
| ADV-O05 | phone rebooted mid-shift (*device*) | tracking resumes, or the gap is visible and reported |
| ADV-O06 | access token expired while offline | refresh, then upload; nothing lost |
| ADV-O07 | user switch on a shared phone with pending data | no data uploaded under the wrong identity |
| ADV-O08 | app updated mid-shift | outbox preserved; local schema migration succeeds |

### 18.5 Geofence (G)

| ID | Scenario | Must |
|---|---|---|
| ADV-G01 | single outside point | no alert |
| ADV-G02 | sustained outside beyond persistence | exactly one GUARD_LEFT_SITE |
| ADV-G03 | flapping across the boundary | no alert storm (dedupe + reopen suppression) |
| ADV-G04 | outside points with poor accuracy | no departure |
| ADV-G05 | guard returns inside | alert auto-resolves with duration |
| ADV-G06 | location goes stale while inside | shown as stale; never "left site" |

### 18.6 Patrols and QR (Q)

| ID | Scenario | Must |
|---|---|---|
| ADV-Q01 | valid scan at the checkpoint | VERIFIED |
| ADV-Q02 | photographed QR scanned far away | OUTSIDE_RADIUS; not counted |
| ADV-Q03 | indoor scan with poor accuracy | LOCATION_UNCONFIRMED, labelled QR only; counted per D-17 |
| ADV-Q04 | the same scan event resubmitted; a new scan of the same checkpoint inside the window | original result; DUPLICATE (not counted) |
| ADV-Q05 | old label after rotation | INVALID_QR |
| ADV-Q06 | checkpoint of another site | WRONG_SITE |
| ADV-Q07 | scan with no active shift | NO_ACTIVE_SHIFT |
| ADV-Q08 | two checkpoints 500 m apart scanned 10 s apart | IMPLAUSIBLE_TRAVEL flag; SUSPICIOUS_LOCATION |
| ADV-Q09 | scans made offline | verified on sync with capture time |

### 18.7 SOS (S)

| ID | Scenario | Must |
|---|---|---|
| ADV-S01 | SOS online | states RECEIVED → NOTIFIED → ACKNOWLEDGED appear only after the matching server confirmations |
| ADV-S02 | SOS with no network | "waiting for network"; never "notified"; delivered exactly once when online |
| ADV-S03 | repeated presses | one open SOS; retriggered |
| ADV-S04 | SOS while the guard is rate-limited, below minimum app version, or the organization is suspended | accepted |
| ADV-S05 | SOS with no active shift | accepted; SOS tracking only |
| ADV-S06 | SOS unacknowledged (fake clock) | escalation steps at 0 / 60 / 180 s, repeats every 120 s |
| ADV-S07 | guard taps "I'm safe" | SOS remains open; escalation continues until acknowledged |
| ADV-S08 | push provider down | dashboard alarm still shown; NOTIFIED via display receipt; operator alert fires |
| ADV-S09 | dashboard where sound has not been enabled | visible warning; alarm banner still shown |
| ADV-S10 | SOS in drill mode and in the demo organization | labelled DRILL; reaches only configured test recipients; excluded from statistics |

### 18.8 Alerts (AL)

| ID | Scenario | Must |
|---|---|---|
| ADV-AL01 | same condition triggers repeatedly | one alert; counter increments |
| ADV-AL02 | dispatcher resolves/dismisses; anyone dismisses SOS_ACTIVATED | rejected |
| ADV-AL03 | two supervisors acknowledge at once | both succeed idempotently; first acknowledger recorded |
| ADV-AL04 | shift ends with open alerts | condition alerts auto-resolve; SOS/incident/missed/suspicious stay |

### 18.9 Files (F)

| ID | Scenario | Must |
|---|---|---|
| ADV-F01 | executable renamed `.jpg` | rejected |
| ADV-F02 | oversize file or decompression bomb | rejected |
| ADV-F03 | guessed storage key or unsigned bucket access | denied |
| ADV-F04 | signed URL used after expiry | denied |
| ADV-F05 | view copy inspected; original requested by a supervisor | metadata stripped; original denied (Owner/Admin only, audited) |

### 18.10 Web (W)

| ID | Scenario | Must |
|---|---|---|
| ADV-W01 | script payloads in incident text, guard names, site names, checkpoint names | rendered as text in dashboard, map popups and supervisor app |
| ADV-W02 | `=HYPERLINK(...)`, `+cmd`, `@SUM` in exported fields | neutralized in CSV |
| ADV-W03 | cross-site request to a state-changing endpoint | blocked |

### 18.11 Time (TM)

| ID | Scenario | Must |
|---|---|---|
| ADV-TM01 | overnight shift across midnight in the site timezone (and a DST-observing zone in tests) | correct instants and display |
| ADV-TM02 | reports for a date range | site-timezone local dates |
| ADV-TM03 | phone clock manipulated to start a future or past shift, or to fake historical location | refused / flagged; server time decides |

### 18.12 Shift state (SH)

| ID | Scenario | Must |
|---|---|---|
| ADV-SH01 | every (state × command × actor) combination | only the transitions in PROD §6.3 succeed |
| ADV-SH02 | double-tap start or end | one transition |
| ADV-SH03 | overlapping shifts for one guard | rejected by API and by the exclusion constraint |
| ADV-SH04 | shift not ended | auto-ended at the deadline |
| ADV-SH05 | phone with no server contact at the deadline | stops tracking by itself |

### 18.13 Privacy (P)

| ID | Scenario | Must |
|---|---|---|
| ADV-P01 | location submitted outside any shift window (not SOS) | nothing stored |
| ADV-P02 | location history viewed or exported | audit row committed before data returned |
| ADV-P03 | retention run | expired rows deleted; counts audited; nothing else touched |
| ADV-P04 | retention run with an incident/SOS still retained | evidence window points kept |

### 18.14 Honest UI (U)

| ID | Scenario | Must |
|---|---|---|
| ADV-U01 | dashboard receives no events for 6 min after a LIVE fix | marker becomes STALE on its own; never shown as live |
| ADV-U02 | permission revoked mid-shift (*device*) | phone banner shows the problem within one heartbeat; dashboard shows TRACKING_DISABLED |
| ADV-U03 | phone shows "All data sent" | only when the outbox is empty and every item was acknowledged |

---

## 19. Fable post-build audit requirements

The pre-build audit brief is a separate file (`FABLE_PREBUILD_AUDIT.md`). After implementation, Fable audits the code against this document and specifically attempts to discover: tenant isolation failures; authorization bypasses; IDOR; location-history leaks; file-storage leaks; realtime tenant leakage; mobile/API trust failures; GPS spoofing weaknesses; offline replay; duplicate-event vulnerabilities; timestamp manipulation; shift-state manipulation; QR replay; alert suppression; SOS failure modes and dishonest SOS states; privacy failures; store-review blockers; third-party dependency risks; infrastructure single points of failure.

**Concrete checks (non-exhaustive):**
- Every tenant table has RLS enabled and forced: query `pg_class.relrowsecurity` / `relforcerowsecurity` against the tenant-table list.
- `app_runtime` owns no tables, lacks `BYPASSRLS`, and has no UPDATE/DELETE on append-only tables (`has_table_privilege`).
- Every tenant relation uses a composite FK including `organization_id`.
- Integration tests connect as `app_runtime`, not a superuser.
- Every route in the registry has a policy; no route is mounted outside it.
- No `dangerouslySetInnerHTML`, map `setHTML`, or HTML push/SMS templates with user input.
- No raw SQL against tenant tables outside repositories; no `Date.now()` in domain or services.
- Redaction config covers tokens, OTPs, QR tokens, coordinates, incident text.
- SOS code paths: phone never shows a state not returned by the server; SOS route exempt from rate limits and version gates.
- Signed URL TTLs; bucket policy private; object keys prefixed by organization.
- Outbox survives kill/reboot (test evidence), lanes ordered as specified.
- Retention preserves evidence windows; retention role is the only deleter.
- Merged native permissions match the allow-list.
- Lint and security suites actually execute in CI (not no-ops).

**Findings format:** ID · severity (Critical / High / Medium / Low / Info) · requirement IDs affected · location (file, endpoint, table) · evidence or reproduction · recommended fix · the test that would have caught it. Critical and High findings block release.

---

## 20. Common mis-implementations to avoid

Each of these has sunk real projects. Claude Code MUST check its work against this list.

1. **Tests run as a superuser or the table owner**, so RLS never applies and isolation tests pass falsely.
2. **Session-level `SET app.org_id`** through a transaction-mode pooler: tenant context leaks to the next client. Use `SET LOCAL` inside the transaction.
3. **`FORCE` vs `ENABLE` RLS chosen by accident**; owner-run jobs silently bypass or silently break. Choose per table, document, test every role.
4. **Organization ID read from the request body or query** "because the client already knows it".
5. **403 for other organizations' resources**, revealing that they exist. Use 404.
6. **Only adding `WHERE organization_id = …` in some queries** and relying on discipline. Use the repository layer plus RLS plus composite FKs.
7. **Ordering location by insertion order or ID** instead of capture time.
8. **Rejecting late-arriving offline data because the shift is now COMPLETED.** Judge by capture time.
9. **Trusting `recorded_at` from the phone** for ordering, shift start or partitioning.
10. **Idempotency key that includes a server-derived value** (e.g., receipt time), so retries are not recognized as duplicates.
11. **Showing "Supervisor notified" when the HTTP request returned 200.** 200 means RECEIVED.
12. **Rate-limiting SOS** with the same middleware as everything else, or blocking it behind a forced-update screen.
13. **Freshness that only changes when an event arrives**, leaving a dead guard's marker "live".
14. **Uploading the previous user's queue with the new user's token** on a shared phone.
15. **Using the OS "connected" flag as proof that data was sent** (captive portals).
16. **iOS `pausesLocationUpdatesAutomatically` left at its default**, silently stopping tracking for stationary guards.
17. **Relying on exact alarms or background-started services** that recent Android blocks.
18. **Storing the raw QR token, or hashing it with a slow password hash** that prevents indexed lookup.
19. **QR codes containing internal IDs or a URL** that a phone camera opens.
20. **Map popups built with HTML strings** containing guard or incident text.
21. **CSV exports without formula-injection protection.**
22. **Long-lived or public object URLs** for incident photos.
23. **Deleting alerts or overwriting incident descriptions** to "clean up".
24. **Next.js server components or actions querying the database directly**, bypassing API authorization.
25. **Running SSE or workers on serverless functions**, or LISTEN/NOTIFY through a pooler.
26. **Lint or security test steps that exist in CI but do nothing.**
27. **Invariants documented only in prose or comments** with no constraint or test behind them.
28. **Docs left describing a superseded design** after the code changed.
29. **Over-the-air updates that change native permissions or tracking configuration.**
30. **Demo or staging environments that can page real people** with SOS notifications or SMS.

---

## Appendix A — Security decisions

Status: **OPEN** until approved.

| ID | Question | Options | Recommendation | Needed by |
|---|---|---|---|---|
| D-27 | Encrypt the phone's local queue at rest | SQLCipher · OS file protection only | measure performance on low-end devices in Phase 0B; default OS protection + prompt deletion after acknowledgement | Phase 4 |
| D-28 | Certificate pinning in the mobile app | yes · no (V1) | no in V1; revisit after launch | Phase 4 |
| D-29 | Rooted / jailbroken devices | flag only · block | flag only (blocking hurts legitimate guards and is easily bypassed) | Phase 4 |

