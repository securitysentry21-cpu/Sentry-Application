# FABLE_LAUNCH_AUDIT.md — Adversarial audit of the built system

**How to use:** give Fable this file as the prompt, with the repository at the commit named below (a clone or a zip). The three specification documents are in `docs/`.

| Pass | Covers | Commit |
|---|---|---|
| 1 | Phases 0–9 (everything built so far) | `8854af8` (Phase 9) |
| 2 | Phase 10's changes, and a re-check of the fixes from pass 1 | named at the end of Phase 10 |

---

## Your role

You are an adversarial auditor of a built system that is about to hold real people's locations. Act as a security reviewer, a PostgreSQL row-level-security specialist, a mobile-platform specialist (Android first) and a reliability engineer at the same time.

Find what would hurt a security company or its guards in production: one organization seeing another's data, a permission that doesn't hold, location leaking, an SOS that is lost or late, evidence that can be changed or deleted, data loss, and mechanisms that look enforced but aren't. Do not be agreeable and do not praise the code. Where an area holds, say so in one line.

## Context you need

- **The product:** SENTRY is a multi-tenant operations platform for private security companies in Pakistan (PROD §1–2). Guards carry an Android app that tracks them during shifts, runs patrols and reports incidents and SOS. Owners, administrators, supervisors, dispatchers and duty officers use the web dashboard.
- **How it was built:** Claude Code built it in phases (ARCH §22), one at a time, from the three documents. Each phase has a `PLAN.md` and a `REPORT.md` in `docs/phases/`. Decisions are in `docs/DECISIONS.md`. Precedence: SEC > DECISIONS > PROD > ARCH.
- **What the builder claims:** `CLAUDE.md`, section "How the invariants are enforced", maps each rule to the file and the test that enforce it. Treat every row as a claim to test, not a fact.
- **Maps of the code:** `docs/generated/` has the route inventory, the database diagram and the test-ID traceability, all generated from the code.
- **Not built yet** (Phase 10 or waiting on the owner; don't report them as missing, but do flag a design that would make them hard to build or unsafe):
  - an SMS provider (texts fail visibly with `SMS_NOT_CONFIGURED`);
  - the guard app registering its push token;
  - crash reports from the app;
  - runbooks and load tests;
  - browser end-to-end tests;
  - the CI check of the release build's Android manifest (ADV-X08);
  - production and staging environments;
  - iOS releases.
- **Waiting on people:** device tests on real phones (ADV-O05 and the matrix), the legal review, a native Urdu speaker's review.
- **The test environment on AWS** holds test data only. Don't touch it or any real service. Work from the code and local runs.

## How to run it

- **Tools:** Node 24 and pnpm 11, then `pnpm install`.
- **Everything CI runs:** `pnpm verify`; add `--skip=audit` when offline.
- **Tests:** `pnpm test`. A local PostgreSQL 17 starts by itself, with no Docker needed.
- **A local stack with demo data:** `pnpm db:up`, `pnpm api:dev`, `pnpm web:dev`, then `pnpm demo`. The API needs `apps/api/.env`; copy `.env.example`.
- **Proof that each security check can fail:** `pnpm negative-controls`.

## What to hunt, in priority order

1. **Tenant isolation.** Any path where organization A reads or changes organization B's data. Look at:
   - the RLS policies in `packages/db/migrations/`, and `withTenant()` / `withTenantTransaction()`;
   - every use of the `system_worker`, `retention_worker` and `migrator` connections, and whether a request can reach one;
   - the realtime streams;
   - reports and exports that take IDs as parameters;
   - object-store keys for photos and exports;
   - the outbox and the operator CLI.
2. **Authorization.** Route policies (`defineRoute`), the permission map, guard-self ownership, the role differences (Supervisor, Dispatcher, Duty officer), membership and role changes (INV-03), location-history access with its audit and reason (INV-14, D-21), and who may download exports.
3. **Location privacy.** Any way coordinates leave the server without the permission and audit SEC requires: responses, realtime events, exports, logs, error messages, notifications, the phone's local storage.
4. **SOS.** Can an SOS be lost, delayed, rate-limited or refused in each of these cases: a suspended organization, an old app version, an expired session, a replaced phone, no network? Look at:
   - the device-signature path (replay, clock window, raw body);
   - the delivery states shown to the guard (INV-10);
   - escalation;
   - notification idempotency, throttling and drill isolation.
5. **The guard app.** Look at:
   - the device-bound session and its key storage;
   - the sync protocol (idempotency, order, duplicates, quarantine);
   - the time model and capture-time estimation;
   - mock-location flags;
   - what the phone keeps and for how long;
   - permissions, and the disclosure and consent flow.
6. **Evidence and retention.** Can a guard's incident or its photos be changed (INV-05)? Are append-only tables really append-only? Can retention delete evidence or an open record, cross tenants, or be triggered by a request? For exports: formula injection (ADV-W02), link lifetime and file deletion.
7. **Files.** The signed upload and view links, the type, size and pixel checks, metadata removal, and who can reach originals.
8. **The dashboard.** HTML sinks (ADV-W01), CSRF, cookies, the content security policy, the same-origin proxy, and the session and membership re-checks on live streams.
9. **Mechanisms that look enforced but aren't.** Tests that would pass with the bug present, lint rules that don't run, meta-tests that skip routes, negative controls that don't cover the check they claim, and test titles citing an ID they don't prove.
10. **Infrastructure** (`infra/terraform/`, `infra/scripts/`). IAM least privilege for each task role, how secrets are handled and logged, network exposure, encryption keys, bucket policies, the edge (CloudFront, the load balancer), the image build, and paused mode.
11. **Bad days.** A database failover, a worker crash in the middle of a batch, an outbox backlog, a provider outage, clock skew. Does the system recover, and does it say what it doesn't know (PROD §19)?
12. **Dependencies.** Licences, advisories and pinned versions (SEC §14).

## Rules

- Read the code, run the tests, and prove findings with a failing test or a command where you can. Put the proof in your output; don't commit it.
- Label every finding:
  - `Proven (test or command)`;
  - `Reasoned (file:line)`;
  - `Unknown: needs a human or a device`.
- Verify any platform or policy claim against current official sources, with the date checked.
- Prefer the smallest fix. Don't redesign the product or add features.
- Cite `file:line` and the IDs involved (`INV-04`, `ADV-T06`, `SEC §16.5`).
- Keep each finding short.

## Output format

1. **Verdict:** would you put real guards on this once Phase 10 is done? One paragraph.
2. **Findings table:** ID (L-01…) · category (TENANCY / AUTHZ / PRIVACY / SOS / MOBILE / EVIDENCE / FILES / WEB / MECHANISM / INFRA / OPS / DEPS) · severity · `file:line` · what goes wrong, as a concrete scenario · evidence label · proof · smallest fix.
   - **Critical:** cross-tenant exposure, a lost SOS, an authentication or authorization bypass, evidence that can be changed.
   - **High:** a SEC rule broken under realistic conditions.
   - **Medium and Low:** everything else, by impact.
3. **Mechanism table:** for each row of `CLAUDE.md` "How the invariants are enforced": holds / partly / doesn't, and why.
4. **Test quality:** tests that would still pass with the bug they guard against.
5. **Questions for the product owner:** only those whose answer changes what gets built.
