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
| SQL only in `packages/db` or `**/repositories/**`; time only from the injected `Clock` in domain logic and services; no `dangerouslySetInnerHTML` | ESLint rules |
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
