# THREAT_MODEL.md

| | |
|---|---|
| Method | STRIDE per component (SEC §3). Each threat maps to a mitigation, the requirement it implements, and the test that proves it. |
| Status | Written in Phase 0, 2026-10-08. Updated whenever a phase adds a component or a mitigation. |
| Legend | **Done** = enforced and tested now. **Phase N** = the phase that delivers it (ARCH §22). |

STRIDE: **S**poofing · **T**ampering · **R**epudiation · **I**nformation disclosure · **D**enial of service · **E**levation of privilege.

## Assets and trust boundaries

**What we protect, most sensitive first:**

1. Guards' location history.
2. SOS events and their delivery.
3. Tenant separation between security companies.
4. Incident records and photos (evidence).
5. Attendance and patrol records (commercial proof of service).
6. Credentials and keys.

**Trust boundaries:**

```text
guard's own phone ──(TLS, device-bound session)──► API ──(app_runtime, RLS)──► PostgreSQL
dashboard (control-room PC, duty officer's phone) ──(TLS, same-origin cookie)──► API
workers ──(app_runtime / system_worker / retention_worker)──► PostgreSQL
API, workers ──► S3 (private bucket, presigned URLs) · FCM/APNs · Web Push · SMS aggregator · Google Maps (browser)
CI ──► dependencies (npm), container images, mobile build service (EAS)
```

Nothing a phone or browser sends is trusted for identity or tenancy: organization, guard and user come from the session (INV-17).

## 1. Guard mobile app (on the guard's own phone)

| | Threat | Mitigation | Requirement | Proof | Status |
|---|---|---|---|---|---|
| S | Someone signs in as a guard on a new phone (recycled SIM number, stolen SMS) | A new phone needs a code issued from the dashboard; an SMS to the number alone never moves the account | D-31, SEC §5 | ADV-A12 | Phase 2 |
| S | GPS spoofing and mock locations | Mock flags, accuracy, implied-speed and clock checks are recorded as evidence and raise SUSPICIOUS_LOCATION. Spoofing is never claimed to be impossible | PROD §8.5, ARCH §8.9 | ADV-L11, Q08 | Phase 4, 7 |
| T | Forged or skewed timestamps used to fake history or shift starts | Capture time is estimated on the server from a monotonic clock; phone time is evidence only | INV-07, ARCH §8.7 | ADV-L10, TM03 | Phase 4 |
| T | Replayed or duplicated events (offline replay) | `client_event_id` idempotency; a resubmission with changed content keeps the original | INV-06, INV-05 | ADV-L01, L09, X06 | Phase 4 |
| I | Stolen phone exposes unsent data or the session | Queue in app-private storage, deleted after acknowledgement; tokens and the device key in Keystore/Keychain; device revocation | SEC §11, ARCH §5.4 | ADV-A08 | Phase 4 |
| I | Location collected off shift | Tracking only during shifts and SOS; the server refuses and does not store anything outside a shift window, including coordinates on scans, start attempts and incidents | INV-08 | ADV-L04, P01, P05 | Phase 4 |
| I | Phone logs or crash reports leak location or tokens | Redaction; no location in device logs | SEC §11, §15 | Unit tests | Phase 4 |
| E | A library silently adds native permissions (contacts, SMS, microphone) | CI allow-list of merged manifest permissions and Info.plist keys | SEC §11 | ADV-X08 | Phase 0B / 2 |
| D | One malformed item freezes the upload queue | Per-item savepoints; quarantine instead of failing the batch | Review A-03 | ADV-O09 | Phase 4 |

## 2. API (Fastify)

| | Threat | Mitigation | Requirement | Proof | Status |
|---|---|---|---|---|---|
| E | A route without authorization reaches the database | Every route declared through the registry with a policy; mounting anything else throws | INV-12, ARCH §4.6 | ADV-A09, INV-12 tests | **Done** |
| E | Tenant breakout: organization ID taken from a body or query | Organization comes only from the session and an ACTIVE membership; strict schemas reject unknown fields | INV-17, SEC §6 | ADV-A10, T09 | Phase 1 |
| I | IDOR: guessing another organization's IDs | RLS returns nothing for other tenants; such resources answer 404, the same as missing ones | INV-01, SEC §4.2 | ADV-T01, A01 | Phase 1 |
| E | Privilege escalation: self-promotion, admin editing owners | Role-change rules; last-owner protection | INV-03 | ADV-A02, A05, A06 | Phase 1 |
| T | Mass assignment | Strict zod schemas; identity fields never accepted from the body | SEC §6.4 | ADV-A10 | Phase 1 |
| I | Errors leak internals | Fixed error envelope; no stack traces; readiness details go to logs only | ARCH §15.1 | health tests | **Done** |
| I | API responses framed, sniffed as HTML, or kept by a cache. In AWS, `/api/*` goes straight to the API, so the dashboard's headers don't cover it | Every API response: `default-src 'none'; frame-ancestors 'none'`, `nosniff`, HSTS, `no-referrer`, and `Cache-Control: no-store` unless a route opts in | SEC §10 | API header test | **Done** |
| I | Logs leak secrets or personal data | Pino redaction list for tokens, codes, coordinates, incident text and phone numbers | SEC §15 | logger test | **Done** |
| R | A privileged action can't be traced | Audit row in the same transaction; history reads audited before the data is returned | INV-14 | ADV-P02, X05 | Phase 1, 6 |
| D | Reconnection storms, scraping, credential stuffing | Rate limits per device, user or organization (not just IP, because of carrier NAT); 429 with Retry-After; SOS never limited | SEC §9, INV-15 | ADV-L12, S04 | Phase 4, 8 |
| S | An expired session blocks an SOS | A device-key-signed SOS is accepted while the device is ACTIVE | INV-15, D-30 | ADV-S11 | Phase 8 |

## 3. Workers (jobs, detectors, notifications, retention)

| | Threat | Mitigation | Requirement | Proof | Status |
|---|---|---|---|---|---|
| E | A job for organization A touches B's rows | The job payload carries the organization; the runner sets the tenant context; cross-tenant sweeps only enumerate work | SEC §4.2.5, ARCH §4.5 | ADV-T07 | Phase 3 |
| T | Retention deletes evidence or the wrong rows | Only `retention_worker` deletes; incident evidence windows are kept; counts are audited | INV-05, SEC §16.5 | ADV-P03, P04 | Phase 9 |
| D | SOS escalation stalls (provider down, job lag) | Escalation job every 15 s; provider failure alerts; synthetic SOS canary in production | ARCH §13, §18.4 | ADV-S06, S08 | Phase 8 |
| R | "Notified" claimed without proof | NOTIFIED only on a display or delivery receipt | INV-10, review C-10 | ADV-S01 | Phase 8 |

## 4. Web dashboard (control-room PCs, duty officers' phones)

| | Threat | Mitigation | Requirement | Proof | Status |
|---|---|---|---|---|---|
| T | Stored XSS through guard-entered text (incidents, names) in the dashboard or map popups | Text-only rendering; lint ban on `dangerouslySetInnerHTML`; map popups via text APIs | SEC §8 | ADV-W01 | lint **Done**; test Phase 6 |
| T | Cross-site request forgery | Same origin, SameSite cookies, a required custom header and an Origin check | SEC §10 | ADV-W03 | Phase 1 |
| I | Framing and clickjacking; MIME sniffing | `frame-ancestors 'none'`, `nosniff`, HSTS, Referrer-Policy (baseline now); strict CSP with nonces in Phase 1 | SEC §10 | Header test | baseline **Done** |
| S | A shared control-room PC stays signed in, or a duty officer's phone is lost | MFA for owners and admins; signed-in user shown on every screen; session renewal rules; lock-screen-safe push and SMS text | SEC §5 | ADV-A07 | Phase 1 |
| I | CSV formula injection in exports | Cells starting with `= + - @`, tab or CR are prefixed | SEC §8 | ADV-W02 | Phase 9 |
| I | A leaked Google Maps key is abused | Browser key restricted by referrer and API; quotas and budget alerts | SEC §10, EXT-13 | Config review | Phase 2 |

## 5. PostgreSQL

| | Threat | Mitigation | Requirement | Proof | Status |
|---|---|---|---|---|---|
| I | A cross-tenant read through a query that forgot its filter | RLS on every tenant table, enabled and not forced (D-33); `app.current_org_id()` with NULLIF so a reused connection fails closed | INV-01, INV-04 | ADV-T06, generated from the table registry: fresh and reused connections, raw SQL and Kysely, and it fails if a table lacks seed rows for both organizations | **Done** (proof of concept) |
| T | A cross-tenant reference written by buggy code | Composite foreign keys reject it in the database itself | INV-13 | ADV-T04 | **Done** (proof of concept) |
| T | Append-only evidence rewritten | The runtime role has INSERT and SELECT only | INV-05 | INV-05 test; ADV-X01 | **Done** (proof of concept) |
| E | The app connects as the owner or a BYPASSRLS role (a mistyped DATABASE_URL) | API and workers refuse to start | D-33 | ADV-X07 | **Done** |
| T | Schema drift away from the tenancy rules | Schema linter in CI over a registry of every table | SEC §19 | ADV-X01 | **Done** |
| T | A data migration silently touches zero rows | ENABLE (not FORCE), so the owner sees all rows; migrations run only as `migrator` with checksums | D-33 | migrate tests | **Done** |
| D | Data loss (region failure, war damage, operator error) | PITR for 35 days; backups copied to a second region; quarterly restore drill | ARCH §19.6 | Restore drill | Phase 1 / 10 |

## 6. Object storage (S3)

| | Threat | Mitigation | Requirement | Proof | Status |
|---|---|---|---|---|---|
| I | A misconfigured public bucket; guessed object keys | Block Public Access; keys prefixed by organization; short-lived signed URLs only after authorization | SEC §12 | ADV-F03, T10 | Phase 8 |
| T | Malicious uploads: spoofed type, decompression bomb, polyglot | Magic-byte check, size and pixel limits, re-encoded view copy, metadata stripped | SEC §12 | ADV-F01, F02, F05 | Phase 8 |

## 7. External providers

| | Threat | Mitigation | Requirement | Proof | Status |
|---|---|---|---|---|---|
| D | SMS pumping or toll fraud through invitation or enrollment codes | Codes only to numbers an admin entered; +92 only unless the operator allows another country; per-number and daily limits | SEC §5, §9 | ADV-A11 | Phase 2 |
| D | Push or SMS provider outage during an SOS | Dashboard alarm; SMS to duty officers at 0 s; delivery receipts; operator alerts | D-04, ARCH §13 | ADV-S08 | Phase 8 |
| I | Personal data processed abroad by providers | Lock-screen-safe content; sub-processor list for the legal review | D-13, EXT-17 | Legal review | before Pilot 0 |

## 8. Build and supply chain

| | Threat | Mitigation | Requirement | Proof | Status |
|---|---|---|---|---|---|
| T | A malicious dependency install script | pnpm blocks install scripts unless allow-listed with a reason | SEC §14 | `pnpm-workspace.yaml` | **Done** |
| T | Dependency confusion with the `@sentry/*` scope | Own scope `@sentryops/*`, `workspace:*` links, CI check | SEC §20 item 37 | scope check | **Done** |
| I | Secrets committed to the repo | gitleaks over the full history in CI; `.env` ignored. SEC §13 also asks for a pre-commit scan | SEC §13 | CI job | CI **Done** (runs once the repo is on GitHub); pre-commit open (needs gitleaks installed locally) |
| T | Known-vulnerable dependencies | Audit fails on High/Critical; allow-list entries need a reason and expire at most 90 days after review; Dependabot | SEC §14 | `scripts/audit-deps.ts` | **Done** |
| T | A dependency moves to a new, unreviewed version | Exact versions for runtime and native dependencies; one React version (override); lockfile frozen in CI | SEC §14 | manifests; `--frozen-lockfile` | **Done** |
| T | A dependency arrives under licence terms we can't meet | Licence allow-list; anything else needs a reasoned exception | SEC §14 | `scripts/check-licences.ts` | **Done** |
| T | A security check silently does nothing | Negative controls prove each check can fail; Vitest exit codes double-checked | Review M-04 | ADV-X02 | **Done** |

## 9. People

| Threat | Mitigation | Status |
|---|---|---|
| Malicious guard (fake attendance, fake patrols) | Location evidence, patrol QR plus location, mock flags; evidence, not proof (PROD §1.3) | Phases 4–7 |
| Malicious supervisor or dispatcher (history snooping, alert suppression) | Least privilege (dispatchers have no history); every history read audited; alerts never deleted | Phases 1, 5, 6 |
| Insider platform operator | No standing access; break-glass procedure audited as PLATFORM_ACCESS (SEC §4.6) | Phase 1 (procedure) |
