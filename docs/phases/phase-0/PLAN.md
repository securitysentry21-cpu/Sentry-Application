# Phase 0 — Architecture foundations · PLAN

| | |
|---|---|
| Status | **Approved 2026-10-08** ("Start with phase 0 please") and built. Results and deviations: `REPORT.md` |
| Date | 2026-10-08 |
| Spec | Revision 3 (`docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_AND_INVARIANTS.md`) |
| Phase rules | ARCH §0.2 and §22 |

## Goal

Phase 0 delivers an empty but working skeleton, with the security mechanisms already enforced and tested. Every later phase then builds on foundations that are already proven. **No product features are built in this phase.**

## Scope

1. **Monorepo.** Uses pnpm workspaces and the layout in ARCH §3:
   - `apps/api`, `apps/web`, `apps/mobile`;
   - `packages/contracts`, `packages/domain`, `packages/db`, `packages/config`;
   - `tools/simulator`, as an empty placeholder.

   Tooling:
   - TypeScript strict, ESLint with real rules, Prettier and Vitest.
   - Lint bans `Date.now()` and `new Date()` in `packages/domain` and in services.
   - Lint bans raw SQL outside `packages/db` and the repositories.
   - `.gitattributes` keeps LF line endings, because development is on Windows while CI runs on Linux.
2. **`packages/contracts`.** Contains:
   - the error catalog (ARCH Appendix B);
   - the role → permission map (PROD §3.2);
   - the settings schema, with its defaults and the validation rules from PROD §8.3 and Appendix B;
   - route-policy types;
   - OpenAPI generation.
3. **`packages/db`.** Contains:
   - plain SQL migrations and a small migration runner;
   - the database roles `migrator`, `app_runtime`, `system_worker` and `retention_worker`;
   - the RLS pattern: ENABLE plus a `NULLIF` policy (D-33);
   - the composite-key pattern;
   - the table registry that the schema linter reads;
   - Kysely with `kysely-codegen` types;
   - test fixtures.
4. **`apps/api`.** A Fastify skeleton with:
   - `/api/v1/health` and `/api/v1/ready`;
   - the route registry, so that a route without a policy cannot be mounted;
   - the error envelope and request IDs;
   - an injectable clock;
   - a logger whose redaction is unit-tested (SEC §15);
   - the startup role check (D-33).
5. **`apps/web`.** A Next.js skeleton: one page in the brand colours and type (`design/README.md`), served from the same origin as the API through a development proxy.
6. **`apps/mobile`.** An Expo skeleton (SDK 57, New Architecture) for guards only. It compiles and lints. Tracking belongs to Phase 0B.
7. **Verification.** One command, `pnpm verify`, runs everything CI runs, so the same checks work locally before a GitHub remote exists. The checks:
   - typecheck, lint, unit tests;
   - integration tests on PostgreSQL 17, connected **as `app_runtime`**;
   - migration validation;
   - OpenAPI drift;
   - dependency audit and secret scanning;
   - the schema linter (ADV-X01);
   - negative controls (ADV-X02);
   - ID traceability (ADV-X03);
   - generated-docs drift (ADV-X04);
   - the runtime-role startup check (ADV-X07);
   - the route-registry meta-test (ADV-A09);
   - a check that no workspace package uses the `@sentry/*` scope;
   - builds of all three apps.

   A GitHub Actions workflow runs the same command.
8. **Docs.**
   - `CLAUDE.md`: the condensed rules, commands and invariant pointers.
   - `docs/THREAT_MODEL.md`: STRIDE per component (SEC §3).
   - `docs/EXTERNAL_DEPENDENCIES.md`: the live ARCH §20 register, with an owner and status per item.
   - Generated: the ERD, the settings table, the permission matrix and the error-code table.
   - `docs/testing/device-matrix.md`: a template.
9. **Environments.**
   - Configuration for development, staging and production, with a cell parameter.
   - The AWS setup in ARCH §19.8, written as Terraform but not applied. It is applied once the AWS account exists, with Phase 1.

**Not in Phase 0:** sign-in and organizations (Phase 1); product tables beyond `organizations`; tracking (Phases 0B and 4); deploying to AWS.

## Schema changes

- The four database roles. `migrator` owns all tables.
- `organizations`, including `data_region`. It is a real table, needed by Phase 1.
- Fixture tables for the RLS proof, created in test databases only: a tenant table, a child table with a composite foreign key, and an append-only table.

## Endpoints, screens, jobs

- **Endpoints:** `GET /api/v1/health` and `GET /api/v1/ready` (ARCH §15.3).
- **Screens:** one placeholder page on the web, and one placeholder screen in the mobile app.
- **Jobs:** none.

## Tests by ID

| ID | What it proves here |
|---|---|
| ADV-T06 (fixtures) | As `app_runtime` with organization A's context, no rows from B are visible. With no context, zero rows are returned and no error is raised, on both a fresh connection and a reused one. |
| ADV-T04 (fixtures) | The database rejects a child row that points at another organization's parent. |
| ADV-X01 | The schema linter fails on an unclassified table, a missing policy, a non-composite foreign key, or an UPDATE grant on an append-only table. |
| ADV-X02 | Each negative control turns its check red: RLS switched off, an append-only grant widened, a lint error planted, a route mounted without a policy. |
| ADV-X03 | Every test ID refers to a real INV or ADV ID. |
| ADV-X04 | The generated tables match the code. |
| ADV-X07 | The API refuses to start as `migrator`, with `BYPASSRLS`, or as a table owner. |
| ADV-A09 | Every registered route has a policy. In Phase 0 that covers only the health routes. |
| Unit | Logger redaction (SEC §15); the settings validation rules (PROD §8.3). |

## Decisions

**Needed from the owner:**

- **D-11:** PostgreSQL for jobs and pub/sub (pg-boss, LISTEN/NOTIFY). This is what the kept outbox design assumes. Please confirm.

**Agent-decided.** These are recorded in `docs/DECISIONS.md` and listed in `REPORT.md`:

- Node 24 LTS and pnpm 11.
- TypeScript strict, ESLint 9 with `typescript-eslint`, Prettier and Vitest.
- A small in-repo migration runner for plain SQL files, instead of another dependency.
- Workspace packages use the scope `@sentryops/*`, linked with `workspace:*` so pnpm never fetches them from npm.
- gitleaks for secret scanning.
- PostgreSQL 17 locally, in CI and on RDS, so every environment runs the same version.

## What the owner needs to provide

| Item | Blocks |
|---|---|
| **Docker Desktop**, with the WSL 2 backend | Running the PostgreSQL integration tests on this machine |
| **A private GitHub repository** for CI. I can create it with the GitHub CLI after you run `gh auth login`, or you create it and send the URL. | CI in the cloud. Everything also runs locally. |
| **OK to commit**, plus the git author name and email for this repo | A baseline commit of the Revision 3 docs before any code |

## Risks

- **Windows and Linux differences** in paths and line endings. Mitigated by `.gitattributes`, by CI on Linux, and by Docker for the database.
- **Expo and pnpm monorepos** can trip the Metro bundler's module resolution. Mitigated by following Expo's monorepo guide, with an isolated or hoisted linker for the mobile app if needed.
- **Scope creep.** Phase 0 adds no product features; anything else goes to `docs/OPEN_QUESTIONS.md`.

## Exit criteria

- `pnpm verify` passes locally, and in CI once the remote exists.
- The RLS proof blocks cross-tenant reads under `app_runtime`.
- ADV-X01, X02 and X07 pass, and every negative control turns its check red.
- The generated documentation has no drift.
- `docs/phases/phase-0/REPORT.md` is written, with any deviations and the human checklist.

## Next

Phase 0B (the tracking spike) and Phase 1 (identity and tenancy) run in parallel after Phase 0. Phase 0B is the first app you can install on a phone. It needs:

- an Expo account, for cloud builds;
- three or four of the pilot guards' Android phones, picked from the device census;
- your iPhone and an Apple Developer membership;
- a small server for the phones to upload to, which runs on the AWS account.

It tests both profiles: a stationed guard and a moving patrol.
