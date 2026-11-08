# CLAUDE.md — SENTRY

A multi-tenant operations platform for private security companies. Guards use a mobile app (tracking during shifts, patrols, incidents, SOS). Owners, admins, supervisors, dispatchers and duty officers use the web dashboard.

## Read first

| Document | Answers |
|---|---|
| `docs/SECURITY_AND_INVARIANTS.md` (SEC) | What must never happen, and how that is proven. **Wins every conflict.** |
| `docs/DECISIONS.md` | Approved and rejected decisions. Second in precedence. |
| `docs/PRODUCT_SPEC.md` (PROD) | What the product does. |
| `docs/ARCHITECTURE.md` (ARCH) | How it is built, and the phase plan (§22). |
| `docs/OPEN_QUESTIONS.md` | What is still waiting for the owner. |

Precedence: SEC > DECISIONS > PROD > ARCH > convenience. Two statements at the same level that conflict are a STOP.

## Working protocol (ARCH §0.2–§0.3)

- **One phase at a time.** Never start a phase without the owner's explicit go-ahead. `docs/phases/status.json` holds the current phase.
- **At the start of a phase,** write `docs/phases/phase-N/PLAN.md`. **At the end,** write `REPORT.md`, and `pnpm verify` must pass.
- **STOP** (document the options in `DECISIONS.md` and wait) when anything touches tenancy, authorization, privacy, location integrity, SOS or retention and the spec is silent, or when two statements conflict. Other gaps: choose the simplest option, record it as agent-decided, and list it in the report.
- **Never weaken, skip or delete a failing test** to get green. Never report something as tested that wasn't run. Device tests are run by humans.
- **Commit only when the owner asks.**

## Commands

```bash
pnpm verify          # everything CI runs (add --skip=audit when offline)
pnpm test            # all tests; a local PostgreSQL 17 starts by itself (no Docker needed)
pnpm db:up           # persistent local database in .local/postgres; prints the URLs
pnpm api:dev         # API on :4000 (needs apps/api/.env; see .env.example)
pnpm web:dev         # dashboard on 127.0.0.1:3000; proxies /api to the API (same origin, review A-07)
pnpm check:licences  # licence allow-list (also part of verify)
pnpm docs:generate   # regenerate docs/generated/* after changing contracts or routes
pnpm db:codegen      # regenerate Kysely types after adding a migration
pnpm negative-controls
pnpm e2e             # browser tests (Playwright) against a throwaway local stack: sign-in, SOS alarm to resolution, CSV export; first `pnpm --filter @sentryops/web exec playwright install chromium`; not part of verify
pnpm load            # load and simulator harness (minutes, not part of verify); LOAD_PHONES=1000 LOAD_NIGHT_MINUTES=60 for the full scenarios; report in .local/load-report.md
node scripts/traceability.ts --through 10   # test IDs still missing if every phase up to 10 were done
```

On this Windows machine, run pnpm unattended (`CI=true`, `--reporter=append-only`). If `pnpm add` hangs after finishing, edit the `package.json` instead and run `pnpm install --no-frozen-lockfile`. Dependency install scripts are blocked unless listed, with a reason, under `allowBuilds` in `pnpm-workspace.yaml`.

## How the invariants are enforced (keep it that way)

| Rule | Where |
|---|---|
| Tenant data only through `withTenant()` / `withTenantTransaction()`, which set `app.org_id` with `set_config(..., true)` inside the transaction | `packages/db/src/tenant.ts`, `kysely.ts` |
| RLS **enabled, not forced** (D-33). Policies read `app.current_org_id()`, which wraps `NULLIF(current_setting('app.org_id', true), '')` | migrations; schema linter |
| Every table is classified in `packages/db/src/registry.ts`. Tenant tables have `organization_id NOT NULL`, `UNIQUE (organization_id, id)`, composite FKs and policies; append-only tables give the runtime role INSERT/SELECT only | `lintSchema()` (ADV-X01) |
| Every registered tenant table gets the cross-tenant read test automatically, and it fails until the seed data has rows for both organizations | `packages/db/test/rls.test.ts` via `tenantTables()` (ADV-T06) |
| API and workers refuse to start unless connected as a runtime role (no owner, superuser or BYPASSRLS) | `verifyRuntimeRole()` (ADV-X07) |
| Every route goes through `defineRoute()` with a policy, and has an entry in `apps/api/test/cross-tenant-fixtures.ts` | route registry, meta-test (ADV-A09) |
| Coordinates in response schemas are tagged `GUARD_LOCATION`, `SITE_GEOMETRY` or `INCIDENT_LOCATION` (the last only on routes needing an `incidents.*` permission); a route returning guard coordinates declares `locationScope: 'live'` or an audit action | `packages/contracts/src/geo.ts`, `route-registry.test.ts` (ADV-X05) |
| A REPLACED phone is accepted for 72 h by `POST /sync/batch` (`replacedDeviceDrain`, only data it captured before the replacement) and by the SOS routes (`policy.sos`), nowhere else | `context.ts`, `services/sync.ts` (ADV-A08, S11) |
| SOS routes (`policy.sos: true`) are never rate-limited, never refused for a suspended organization, an old app version or an expired session: without a usable session they take the device-key signature (`X-Device-Signature`, ±5 min, over the raw body) | `context.ts`, `rate-limit.ts`, `auth/device-signature.ts`; `sos.test.ts` (ADV-S02–S04, S11) |
| The guard's phone is told ALERT_SENT only after a provider accepted a message, NOTIFIED only after a display receipt (`/alerts/:id/seen`) or a delivery receipt (`/alerts/:id/delivered`) | `services/notifications.ts`, `services/receipts.ts`, `domain/sos.ts` (`guardSosPhase`); `sos.test.ts` (ADV-S01, INV-10) |
| Notifications are delivery rows with idempotent keys, written in the alert's transaction and sent only by the worker; texts are throttled per recipient per SOS; a drill reaches only its members; only the worker holds the Web Push private key | `services/notifications.ts`, `workers/notifications.ts`, `notify/*`, `infra/terraform/cell/notifications.tf`; `sos.test.ts`, `notifications.test.ts` (ADV-S06, S08, S10) |
| Incident photos are reached only through signed links (upload ≤ 15 min, exact type and length, never over an existing object; view ≤ 5 min); the worker checks size, real type, pixels before decoding and the hash, and serves a re-encoded copy without metadata; originals only to Owners and Administrators, audited | `storage/*`, `services/attachments.ts`, `attachments/image.ts`; `attachments.test.ts` (ADV-F01–F05, T10) |
| A guard's incident is never edited: the runtime role may update only its status, severity, type and resolution columns, and its events are append-only | migration 0010 (column grants); `incidents.test.ts` (INV-05) |
| Reports count by local dates in the site's zone (the organization's for several sites); a site, guard or shift of another organization is not found, in reports and exports alike | `services/reports.ts`, `services/exports.ts`; `reports.test.ts`, `exports.test.ts` (ADV-TM02, T03) |
| Every CSV goes through `csvDocument` / `csvCell`: UTF-8 with a BOM, every cell formula-safe | `packages/domain/reports.ts`; `exports.test.ts` (ADV-W02) |
| Exports run in the background, one at a time per person; each kind keeps its own permission at request, list and download (a guard's data: `exports.guard_data`; location kinds: location-history access and the D-21 reason, again at download); requests and downloads are audited | `services/exports.ts`, migration 0011; `exports.test.ts` |
| Retention runs as `retention_worker`, one organization at a time (its policies see only that organization), children before parents, evidence kept, one `RETENTION_RUN` row with counts; `retention_worker` may delete, and update only the position columns a table lists in `retentionClears` | `services/retention.ts`, `repositories/retention.ts`, migration 0011, `schema-lint.ts`; `retention.test.ts` (ADV-P03, P04), negative control |
| Alert rules are pure (`packages/domain/alerts.ts`, `geofence.ts`); the engine applies them against the partial unique index on open dedupe keys | `apps/api/src/services/alerts.ts` (ADV-AL01–AL05, G01–G06) |
| Checkpoint scans are judged by the server alone, arriving through `POST /sync/batch`, with pure rules (`packages/domain/patrols.ts`); the scanned token is never stored; a visit outside a shift can't hold coordinates (check constraint) | `apps/api/src/services/patrols.ts`, migration 0008; `patrols.test.ts` (ADV-Q01–Q09, T08) |
| Changes reach dashboards only through outbox rows written in the same transaction (`publish()`); the dispatcher numbers them after commit, under a per-organization lock; a stream belongs to the request's organization and re-checks session and membership every 30 s | `services/realtime.ts`, `workers/outbox.ts`, `realtime/hub.ts`, `routes/live.ts`; `realtime.test.ts` (ADV-T02) |
| Location history writes its audit row before reading any point; the reason is required when the organization says so. The SOS page's trail is history too (`SOS_VIEWED`); a newer SOS position alone travels live on the stream, without a reload | `routes/live.ts`, `routes/sos.ts`, `realtime/hub.ts`; `live.test.ts`, `realtime.test.ts` (ADV-P02, A04, INV-14) |
| The dashboard has no HTML sink (no `innerHTML`, map-popup HTML or `dangerouslySetInnerHTML`); map details open in a plain-text panel | ESLint; `apps/web/test/plain-text.test.tsx` (ADV-W01) |
| SQL only in `packages/db` or `**/repositories/**`; time only from the injected `Clock` in domain logic and services; no `dangerouslySetInnerHTML` | ESLint rules |
| The guard app's release manifest, merged by Gradle in CI, declares the Play monitoring tool, holds exactly the allow-listed permissions, declares the location service's foreground type, targets API ≥ 36 and allows neither cloud backup nor plain HTTP | `apps/mobile/android-permissions.ts`, `apps/mobile/scripts/*`, CI job `android-manifest`; `android-manifest.test.ts` (ADV-X08), negative control |
| Crash reports from the guard app go to our own API only, which writes them to its service log (30 days) and nowhere else. Every field is held to an identifier-like pattern, so no message text, name, number, coordinate or incident text fits; the phone rebuilds the error name and frames from allow-listed characters and never reads the message; one bad report refuses the batch | `packages/contracts/src/diagnostics.ts`, `routes/diagnostics.ts`, `apps/mobile/src/core/diagnostics/*`; `diagnostics.test.ts`, `crash-reports.test.ts` (mutation-checked) |
| A guard app below the minimum version is refused with 426 on guard routes, except the config, queued uploads (sync, photos), crash reports and SOS; a revoked version is refused everywhere but the config, SOS included (INV-15's one exception). Set per route by `policy.appVersion` | `apps/api/src/app-version.ts`, `context.ts`, route policies; `app-version.test.ts` (mutation-checked) |
| Operator commands into an organization need a reason and write a `PLATFORM_ACCESS` audit row first; they run as `app_runtime` in that organization's tenant transaction and print counts, ages, IDs and codes only. A quarantined item is replayed through the real sync pipeline as its own phone, never from a lost or compromised one, and the runtime role may update only its `replayed_at` | `services/operator.ts`, `cli/operator*.ts`, migration 0012; `operator.test.ts` |
| Defaults, error codes and audit actions equal the spec tables | spec-consistency tests (ADV-X04) |
| Generated docs and DB types match the code | `docs:check`, `db:codegen --check` |
| Each security check can fail | `scripts/negative-controls.ts` (ADV-X02) |
| Tests name the INV/ADV IDs they prove; IDs due in a phase need a test | `scripts/traceability.ts` (ADV-X03) |
| Logs never contain tokens, codes, coordinates, incident text or phone numbers; every request's log lines carry `request_id` | `apps/api/src/logger.ts`, `app.ts` and their tests |
| High/Critical advisories fail unless allow-listed with a reason, for at most 90 days; every licence is on the allow-list or a reasoned exception | `security/audit-allowlist.json`, `security/licence-policy.json` (SEC §14) |

Vitest's exit code is not trusted on its own. It once exited 0 with failing tests because `embedded-postgres` installs a process exit hook, which is why the embedded server runs in a child process. Scripts use `vitestFailed()`.

## Code conventions

- **Node 24 runs TypeScript directly** (type stripping). Use erasable syntax only (no enums, no parameter properties), explicit `.ts` extensions in relative imports, and `import type` for types.
- **IDs are UUIDv7 generated in the API.** Migrations are plain SQL files: never edit an applied one, add a new one. Then run `pnpm db:codegen` and `pnpm docs:generate`.
- **Workspace scope is `@sentryops/*`,** never `@sentry/*` (that scope belongs to Sentry.io).
- **Dependencies (SEC §14):** runtime and native dependencies use exact versions (no `^` or `~`), including those `npx expo install` adds. Every new dependency is justified in the phase report: purpose, maintenance, licence, native permissions. One React version for the whole tree (`overrides` in `pnpm-workspace.yaml`).
- **Errors** use the ARCH §15.1 envelope, with codes from `packages/contracts/src/errors.ts`.
- **Dashboard (Next.js 16):** its APIs and conventions differ from older versions. Read the matching guide in `node_modules/next/dist/docs/` before writing dashboard code. Next.js's own agent-file generation is off (`agentRules: false`); this file is the agent guide.
- **Mobile (Expo SDK 57, guards only):** check the versioned docs at <https://docs.expo.dev/versions/v57.0.0/>, because Expo changes between SDKs. Add libraries with `npx expo install`. `android/` and `ios/` are generated, never hand-edited. Use development builds, not Expo Go. New Architecture only. Over-the-air updates never change native permissions or tracking.
