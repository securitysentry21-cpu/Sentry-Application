# Phase 0 — Architecture foundations · REPORT

| | |
|---|---|
| Date | 2026-10-08 |
| Plan | `PLAN.md`, approved 2026-10-08 ("Start with phase 0 please") |
| Spec | Revision 3 |
| Result | **Built.** `pnpm verify` passes on this machine: 13 checks, 14 test files, 62 tests, about 3 minutes. |
| Not done yet | The first CI run on GitHub, because there is no repository yet. **Nothing is committed.** |

## In short

- **The skeleton works:** the API, the dashboard and the guard app, the shared packages and the database layer. One command, `pnpm verify`, runs everything CI runs.
- **The database itself enforces tenant separation.** Connected as `app_runtime`, organization A can neither read nor write organization B's rows. Reads are proven on fresh and reused connections, through raw SQL and through Kysely; writes through raw SQL.
- **Every security check has been shown to fail when its mechanism is broken.** On the first day this caught a real problem: the test runner reported success while five tests were failing. It is fixed, with a second guard (finding 1).
- **No product features, as planned.**
- **Two High advisories have no fix published yet.** Both are in the guard app's build tools and ship nowhere. They are allow-listed until 2026-11-07, with reasons (finding 6).
- **Needed from you:** OK to commit with your git name and email, a GitHub repository, confirmation of D-11, and answers to Q-13 and Q-18–Q-21. The full list is the checklist at the end.

## Exit criteria

| Criterion (PLAN) | Result | Evidence |
|---|---|---|
| `pnpm verify` passes locally | ✓ | all 13 steps, 2026-10-08 |
| … and in CI once the remote exists | not yet run | needs the GitHub repository |
| The RLS proof blocks cross-tenant reads under `app_runtime` | ✓ | ADV-T06, below |
| ADV-X01, X02 and X07 pass; every negative control turns its check red | ✓ | 4 of 4 controls turned red for the expected reason |
| The generated documentation has no drift | ✓ | settings, permissions, error codes, OpenAPI, ERD, database types |
| `REPORT.md` with deviations and the human checklist | ✓ | this file |

## What was built

1. **Monorepo** (ARCH §3):
   - `apps/api`, `apps/web`, `apps/mobile`;
   - `packages/contracts`, `domain`, `db`, `config`;
   - `tools/simulator` (empty).

   Strict TypeScript that Node 24 runs directly, with no build step. ESLint with spec rules as errors, Prettier and Vitest. `.gitattributes` keeps LF line endings.
2. **`packages/contracts`:**
   - the error catalog;
   - the role → permission map;
   - the settings schema, with every cross-field rule from PROD §8.3;
   - audit actions and route-policy types.

   Spec-consistency tests compare these with the spec tables.
3. **`packages/db`:**
   - migration `0001_foundation`: the grants, `app.current_org_id()`, and `organizations` with RLS;
   - a migration runner with checksums;
   - the four database roles;
   - `withTenant()` and `withTenantTransaction()`;
   - the table registry and the schema linter;
   - the startup role check and the readiness check;
   - the ERD generator, and Kysely with generated types.

   The test harness:
   - real PostgreSQL 17 in a child process, with no Docker;
   - a fresh database per test file;
   - fixture tables and the negative-control hooks.

   `pnpm db:up` provides a persistent local database.
4. **`apps/api`**, on Fastify:
   - `/api/v1/health` and `/api/v1/ready`;
   - the route registry, which refuses a route without a policy;
   - the error envelope, and request IDs;
   - `X-Server-Time` from the injected clock;
   - security headers on every response;
   - a redacting logger whose lines carry `request_id`;
   - the startup role check;
   - OpenAPI generation.
5. **`apps/web`**, on Next.js 16:
   - one page in the brand colours and type;
   - baseline security headers;
   - `/api` proxied to the API in development, so both share one origin.
6. **`apps/mobile`**, on Expo SDK 57 with the New Architecture, for guards only. It has one dark placeholder screen. It typechecks, lints and bundles for Android. The app identifiers are placeholders (Q-20).
7. **Verification:**
   - `pnpm verify` (steps below);
   - the GitHub Actions workflow, which runs `pnpm verify` on Linux against `postgres:17`, plus a gitleaks job over the whole history.
8. **Docs:**
   - `CLAUDE.md`, `docs/THREAT_MODEL.md`, `docs/EXTERNAL_DEPENDENCIES.md`, and the `docs/testing/device-matrix.md` template;
   - generated: the ERD, settings, permission matrix, error codes, OpenAPI and traceability.
9. **Environments:** `infra/README.md` describes development, test, staging and production. The configuration takes `CELL_REGION`. `.env.example` has development values. Terraform moved to Phase 1 (deviations).

**Run by hand on this machine:** the documented development flow. `pnpm db:up` worked, including a restart on existing data, followed by `pnpm api:dev` and `pnpm web:dev`. Health and readiness answered 200 through the dashboard's `/api` proxy, with the security headers present. Neither server was reachable from the local network.

## `pnpm verify`

| Step | Checks |
|---|---|
| scope | no workspace package uses `@sentry/*` |
| format | Prettier |
| lint | ESLint; warnings fail |
| typecheck | 7 projects; Next.js types are generated first, so a fresh clone works |
| tests | unit and integration tests, against PostgreSQL 17 as `app_runtime` |
| docs | generated docs match the code (ADV-X04) |
| dbtypes | generated database types match the migrated schema (D-10) |
| trace | test IDs exist in SEC; every ID due this phase has a test (ADV-X03) |
| negative | each security check turns red when its mechanism is broken (ADV-X02) |
| audit | no unreviewed High or Critical advisory |
| licences | every licence is allowed or a reviewed exception |
| web | `next build` |
| mobile | `expo export` for Android |

## Tests by ID

| ID | What it proves here | Where |
|---|---|---|
| ADV-T06 | For **every tenant table in the registry** (today `organizations` and three fixture tables): as `app_runtime` with A's context, zero rows of B. With no context, zero rows and no error, on a fresh connection and on one that already served a tenant. The same through Kysely. The test is generated from the registry and fails if a table lacks seed rows for both organizations. | `packages/db/test/rls.test.ts`, `kysely.test.ts` |
| ADV-T04, INV-13 | The database rejects a child row that points at another organization's parent, even for the table owner. This is the database half; the API half comes with the Phase 2 endpoints. | `rls.test.ts` |
| INV-01 (database half) | RLS also blocks writes: `app_runtime` cannot insert a row for another organization. | `rls.test.ts` |
| INV-05 | `app_runtime` cannot UPDATE or DELETE append-only rows. | `rls.test.ts` |
| ADV-X01 | The clean schema passes the linter. Every rule in SEC's definition is caught: an unclassified table, RLS off, RLS forced, no policy, a nullable `organization_id`, a missing `UNIQUE (organization_id, id)`, a foreign key without `organization_id`, UPDATE or DELETE granted on an append-only table, and a registry entry with no table. | `schema-lint.test.ts` |
| ADV-X02 | Four negative controls (next section). | `scripts/negative-controls.ts` |
| ADV-X03 | Every cited ID exists in SEC; every ID due through Phase 0 has a test. | `scripts/traceability.ts` |
| ADV-X04 | Settings defaults, error codes and audit actions equal the spec tables; the ERD and other generated docs match the code. | `spec-consistency.test.ts`, `erd.test.ts`, `scripts/generate-docs.ts` |
| ADV-X07 | The startup role check refuses the table owner, a superuser and a role with BYPASSRLS. The API, started for real, refuses the owner and another runtime role, and starts as `app_runtime`. Workers will reuse the same check. | `runtime-role.test.ts`, `apps/api/test/startup.test.ts` |
| ADV-A09, INV-12 | Every mounted route has a policy and a cross-tenant fixture entry. Mounting a route without a policy throws. Today this covers only the health routes. | `route-registry.test.ts` |

Other tests:

- **Logging (SEC §15):** redaction of tokens, codes, coordinates, incident text and phone numbers; every request's log lines carry `request_id`.
- **API responses (SEC §10):** every response carries the security headers and is not cached.
- **Settings (PROD §8.3):** every cross-field rule has a failing example.
- **Permissions:** dispatchers never get location history or alert resolution; guards get only their own records.
- **Migrations:** they run only as the owner, and an applied migration that was later edited is refused.
- **Health and readiness:** readiness reports NOT_READY without internal details.
- **Clock:** the fake clock.

## Negative controls (ADV-X02)

| Deliberate break | Check that must fail | Result |
|---|---|---|
| RLS switched off on a tenant table | ADV-T06 | red ✓ |
| UPDATE granted on an append-only table | schema linter (ADV-X01) | red ✓ |
| A route mounted without a policy | route meta-test (ADV-A09) | red ✓ |
| `Date.now()` planted in domain code | lint | red ✓ |

A control counts only if the failure output names the expected check, so a crash for another reason doesn't pass.

## Problems found and fixed during the phase

1. **The test runner reported success with failing tests.** The first negative control stayed green: Vitest exited with code 0 while five tests failed. The cause was `embedded-postgres`, which installs a process exit hook that replaces the exit code. This is exactly the failure from your previous product: a check that silently does nothing. Two fixes:
   - the database server now runs in a child process, where its hook can't touch the test runner;
   - `pnpm verify` and the negative controls also read the test summary and fail on any "failed" count.
2. **The reused-connection trap is real** (review M-01). On PostgreSQL 17.10, a connection that served a tenant reports the setting as `''` rather than unset afterwards, which was confirmed. Without `NULLIF` the next query would error; with it, it returns zero rows. A test covers this.
3. **The cross-tenant test listed its tables by hand.** A tenant table added later could have been silently skipped, so the list is now generated from the registry. The test also fails when a table has no rows for one of the organizations, so "no rows from B" can't pass with nothing to hide.
4. **API responses had no security headers.** Found in the hand-run check: the dashboard's headers don't apply to `/api`, and in AWS the load balancer sends `/api/*` straight to the API. The API now sends its own headers, tested.
5. **`pnpm db:up` failed on its second run.** It always created a new cluster, which PostgreSQL refuses in a non-empty directory. It now reuses the existing data. Found by running the documented commands exactly as written.
6. **Two High advisories in the guard app's build tools:**
   - node-forge, in the Expo CLI;
   - braces, in the Metro bundler.

   Neither ships: the API and the dashboard don't use them, and a scan of the compiled guard-app bundle found none of their code. No fixed version is on npm yet. Both are allow-listed until 2026-11-07, and the audit fails on that date unless they are reviewed. Allow-list entries now need a reason and a review date, and expire at most 90 days after review.
7. **A licence check that would have broken CI.** Linux installs sharp's libvips under a different licence string than Windows does. Every Linux-only package was checked before the first CI run.
8. **Tool-generated agent instructions.** The Expo template added `AGENTS.md`, a `.claude/settings.json` that enabled a plugin, and a licence file. `next dev` wrote its own `AGENTS.md`. All are removed, and Next.js's generation is switched off. Agent rules live in `CLAUDE.md`, under your control.
9. **Smaller fixes:**
   - a second `react-dom` version (one React is now enforced);
   - the dashboard dev server listened on the local network (it is now localhost only);
   - a test cited INV-13 for what is really INV-01 (the titles are corrected, so the traceability table is accurate);
   - an encoding error from a Windows tool in one `package.json`.

## Deviations from the plan

| Plan | What happened | Why | Follow-up |
|---|---|---|---|
| Docker Desktop for the test database | Embedded PostgreSQL 17, with no Docker. CI uses the official `postgres:17` image. | It works on this machine without installing anything. | **You no longer need Docker.** |
| Terraform written in Phase 0, not applied | Moved to Phase 1 | Without an AWS account it can't be checked with `terraform plan`, and unchecked infrastructure code is drift. | Phase 1, against the staging account |
| ESLint 9 | ESLint 10 | Current version | — |
| Secret scanning in `pnpm verify` | CI only (gitleaks over the whole history) | It needs Docker or the gitleaks program locally | SEC §13 also asks for a pre-commit scan: install gitleaks (checklist) |
| OpenAPI generation in `packages/contracts` | In `apps/api/src/openapi.ts`, from the mounted routes; the schemas still come from contracts | Only the API knows which routes exist | — |
| "Builds of all three apps" | The API has no build step; its check is the typecheck plus the startup tests | Node runs TypeScript directly | — |
| ADV-X07: API and workers | API only | Workers don't exist yet; they will call the same `verifyRuntimeRole()` | Phase 2–3 |
| ADV-T04 | Database half only | The API endpoints arrive in Phase 2 | Phase 2 |
| — (added) | Licence allow-list; exact versions for runtime and native dependencies; API security headers; `request_id` in logs | Required by SEC §10, §14 and §15, and cheap now | — |

## New dependencies (SEC §14)

All new, because the repository is new. Versions are exact for runtime and native dependencies. Maintenance figures were checked against npm on 2026-10-08. "Latest release" is the package's most recent publish date.

**Runtime**

| Package | Version | Used by | Purpose | Maintenance | Licence |
|---|---|---|---|---|---|
| fastify | 5.12.5 | api | HTTP server | OpenJS Foundation; latest release 2026-09-16 | MIT |
| pino | 10.4.0 | api | structured logs with redaction | Fastify's logger; 2026-10-02 | MIT |
| zod | 4.6.5 | contracts, api | request validation; JSON Schema for OpenAPI | 2026-09-13 | MIT |
| kysely | 0.29.6 | db | typed SQL query builder (D-10) | 2026-09-16 | MIT |
| pg | 8.23.1 | db | PostgreSQL driver | 2026-09-30 | MIT |
| next | 16.4.0 | web | dashboard framework | Vercel; 2026-10-06 | MIT |
| react, react-dom | 19.2.3 | web, mobile | UI | Meta; 19.3.0 exists, but 19.2.3 is what React Native 0.86 uses | MIT |
| expo, expo-status-bar | 57.0.27, 57.0.1 | mobile | app runtime and build tools (SDK 57) | Expo; 2026-10-06 | MIT |
| react-native | 0.86.3 | mobile | native UI | Meta; Expo SDK 57's version (0.87.1 exists) | MIT |

**Build and test only**

| Package | Version | Purpose | Maintenance | Licence |
|---|---|---|---|---|
| typescript | 6.0.3 | type checking | Microsoft; 7.0 exists but the lint tooling supports only up to 6.0 | Apache-2.0 |
| eslint, @eslint/js, typescript-eslint, globals | 10.12.0, 10.0.1, 8.71.1, 17.13.0 | lint, including the spec rules | all released 2026-07 to 2026-10 | MIT |
| prettier | 3.9.9 | formatting | 2026-09-23 | MIT |
| vitest | 5.0.3 | tests | 2026-09-30 | MIT |
| @types/node, pg, react, react-dom | 24.x, 8.23.1, 19.2.x | type definitions | DefinitelyTyped; 2026-10 | MIT |
| embedded-postgres | 17.10.0-beta.17 | real PostgreSQL 17.10 for local tests and `pnpm db:up`, without Docker. "beta" is the package's own version label. | **One maintainer**; latest release 2026-06-05; first published 2022 | MIT |
| kysely-codegen | 0.20.0 | database types generated from the schema (D-10) | **One maintainer**; latest release 2026-02-16 | MIT |

The two single-maintainer packages are development tools only. If either is abandoned, the fallbacks are Docker or the CI image for the database, and hand-written or catalog-generated types for codegen.

**Native permissions:** our code requests none. The complete list, including template and library defaults, is known only after the first native build. That is Phase 0B, where the permission allow-list check (ADV-X08) applies.

**Licences:** 589 installed packages. All are permissive except three reviewed exceptions, listed in `security/licence-policy.json`:

- lightningcss (MPL-2.0), build time only;
- sharp's image binaries (LGPL-3.0 parts), used on our servers;
- caniuse-lite (CC-BY-4.0), build data.

**Advisories:**

- 2 High, allow-listed until 2026-11-07 (finding 6);
- 1 moderate in `uuid@7`, inside Expo's iOS project tooling. It is reported and doesn't block, per policy, and that `uuid` version is deprecated.

## Agent decisions

They are recorded in `docs/DECISIONS.md` under "Phase 0 · engineering choices"; veto any of them in the diff.

- **Toolchain:**
  - Node runs TypeScript directly;
  - TypeScript 6.0 and ESLint 10;
  - pnpm 11 with a flat `node_modules`, and install scripts only for listed packages;
  - one React version;
  - exact versions for runtime dependencies;
  - `next-env.d.ts` is not committed;
  - build-tool telemetry is off in automated runs.
- **Database:**
  - PostgreSQL 17 everywhere;
  - the in-repo migration runner;
  - the `app.current_org_id()` helper;
  - embedded PostgreSQL in a child process.
- **Process:**
  - tool-generated agent files removed or switched off;
  - placeholder app identifiers (Q-20);
  - dispatchers can view shifts (**Q-21 asks you to confirm**, because it is an authorization question);
  - the licence policy and the advisory exceptions;
  - API security headers;
  - secret scanning in CI only.

## Known gaps

- **CI has never run.** Everything so far has been tested on Windows only, so Linux-specific problems will show on the first push.
- **gitleaks may flag the development-only database passwords** in `.env.example` and `packages/db/src/roles.ts`. They are deliberately public and only work on a local database. If flagged, they get a gitleaks allow-list entry; real credentials never do.
- **CI pinning:** GitHub Actions are pinned by version tag, not by commit, and the gitleaks image uses `:latest`. Both get pinned once the repository exists.
- **Dependabot** hasn't been confirmed to understand pnpm 11 lockfiles. Check after the first run.
- **Strict Content Security Policy** (nonces) comes with the first real screens, in Phase 1. Today the dashboard sends the baseline headers.
- **`org_id` in log lines** (SEC §15) needs the request context, in Phase 1.
- **The pre-commit secret scan** (SEC §13) needs gitleaks installed on this machine.
- **The permission allow-list for native builds** (ADV-X08) comes in Phase 0B.

## Human checklist

1. **Review the diff.** Nothing is committed:
   - the three specs: Revision 3 against the staged Revision 2;
   - all of Phase 0.
2. **Say "commit"** and give the git author name and email for this repository.
3. **GitHub:** run `gh auth login` and I'll create a private repository, or create one and send me the URL. The first CI run follows the first push.
4. **Confirm D-11:** PostgreSQL also runs the background jobs and the realtime fan-out.
5. **Answer Q-13, Q-18, Q-19, Q-20 and Q-21** in `docs/OPEN_QUESTIONS.md`.
6. **Optional: try it.**
   - `pnpm install`, then `pnpm verify` (about 3 minutes).
   - Or copy `.env.example` to `apps/api/.env`, run `pnpm db:up`, `pnpm api:dev` and `pnpm web:dev` in three terminals, and open http://127.0.0.1:3000.
7. **Optional:** install gitleaks (`winget install gitleaks`) so a pre-commit secret scan can be added.
8. **Long-lead actions** (unchanged):
   - the wordmark vector file;
   - a D-U-N-S number, then the Apple and Google organization accounts;
   - an SMS aggregator and sender ID;
   - the pilot device census;
   - the legal review.
9. **For Phase 0B and Phase 1:**
   - an AWS account (staging and production);
   - an Expo account for cloud builds;
   - three or four pilot guards' Android phones, plus your iPhone with an Apple Developer membership.

## Next

Phase 0B (the tracking spike) and Phase 1 (identity and tenancy) can run in parallel, but only after your go-ahead. Each starts with its own `PLAN.md`. Phase 0B is the first build you can install on a phone.
