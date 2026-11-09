# FABLE_LAUNCH_AUDIT.md — Adversarial audit of the built system

**How to use:** give Fable this file as the prompt, with the repository at the commit named below (a clone or a zip). The three specification documents are in `docs/`.

| Pass | Covers | Commit |
|---|---|---|
| 1 | Phases 0–9 (everything built so far) | `8854af8` (Phase 9) |
| 2 | Phase 10's changes, and a re-check of the fixes from pass 1 | the head of branch `fable-pass-1`, after its CI passed; the zip's file name carries the commit (`sentry-<commit>.zip`) |

Pass 1 ran on 2026-11-03 and reported L-01 to L-26. Pass 2 ran on 2026-11-09 on commit 666e688 and reported L-27 to L-36 (the answer: `docs/phases/phase-10/FABLE-PASS-2.md`). A further pass numbers new findings from L-37. Everything below "Pass 2" applies to both passes unless pass 2 says otherwise.

## Pass 2

You are given this file, the repository at the commit above, and your own pass-1 report. Two jobs, in this order.

**1. Re-check every pass-1 finding, L-01 to L-26.** `docs/phases/phase-10/FABLE-PASS-1.md` says what was done for each and which test proves it; `docs/DECISIONS.md`, section "Fable launch audit, pass 1", lists what was decided and what waits on the owner. For each finding, say fixed, partly, not fixed or made worse, with evidence, and try to break the fix rather than read it. In particular:

- the dashboard's Content-Security-Policy (`apps/web/proxy.ts`, `lib/csp.ts`): does it hold in a production build (`next build`, `next start`), and is any page served without the nonce?
- the WAF exemption for `/api/v1/sos*` (`infra/terraform/cell/edge.tf`): can a request that is not an SOS be shaped to skip the managed rules?
- the response check (`apps/api/src/routes/response-check.ts`), which runs outside production only: is that the right trade, and what can still leak in production?
- the Terraform tests (`infra/terraform/cell/tests/security.tftest.hcl`, run by `bash infra/scripts/tf-test.sh`, Terraform 1.11 or later): do their assertions check what they claim, given the mocks?
- versioning and retention on the photo bucket: is anything kept longer than SEC §16 allows, or deletable sooner than intended?
- `TRUST_PROXY` behind CloudFront's VPC origin and the load balancer;
- the new negative controls (`pnpm negative-controls`, 13): does each break the mechanism it names?

**2. Audit what Phase 10 added since pass 1** (`git log 8854af8..HEAD`). Phase 10's plan is `docs/phases/phase-10/PLAN.md`, and its decisions are in `docs/DECISIONS.md` (Phase 10). Look at:

- the guard app's push-token registration (`expo-notifications`);
- crash reports from the app (`apps/api/src/routes/diagnostics.ts`, `apps/mobile/src/core/diagnostics/`);
- the server's app-version gate: 426, revoked versions, and SOS's one exception (`apps/api/src/app-version.ts`);
- the operator commands into one organization (`delivery-health`, `quarantine-list`, `quarantine-replay`), `PLATFORM_ACCESS` and migration 0012;
- the operator alarms and the worker heartbeat (`infra/terraform/cell/operations.tf`, `apps/api/src/workers/health.ts`);
- the faster sync batch (`BatchLive` in `apps/api/src/services/sync.ts`): is its behaviour still the old one in every case, idempotency and quarantine included?
- the release-manifest check (ADV-X08) and the permissions Firebase brings (DECISIONS: `RECEIVE` and `WAKE_LOCK` allowed, badge permissions blocked);
- the browser tests (`apps/web/e2e`, `pnpm e2e`) and the load harness (`pnpm load`);
- the runbooks (`docs/RUNBOOKS/`), only for steps that would do harm if followed;
- CI (`.github/workflows/ci.yml`).

**Known and open: don't report these as new.** They wait on the owner: a disabled guard's SOS (L-11), Object Lock (L-03), the device key (L-16), who may run operator commands in production (L-13), a KMS key for the state buckets and CloudTrail data events (L-22). Also known: the image still installs development dependencies, there is no pre-commit secret scan, and the runbooks list their own gaps. Do say so if you think a recommended option is wrong, or if one of them is worse than the decision log says.

**Not built yet in pass 2:** an SMS provider; production and staging environments, and so the WAF and the backup-region copy run nowhere; iOS releases; device tests on real phones. Don't report them as missing, but do flag a design that would make them unsafe.

**Output for pass 2:** the format below, plus a "pass-1 re-check" table (L-01 to L-26 · verdict · evidence) before the findings. Number new findings from L-27.

---

## Your role

You are an adversarial auditor of a built system that is about to hold real people's locations. Act as a security reviewer, a PostgreSQL row-level-security specialist, a mobile-platform specialist (Android first) and a reliability engineer at the same time.

Find what would hurt a security company or its guards in production: one organization seeing another's data, a permission that doesn't hold, location leaking, an SOS that is lost or late, evidence that can be changed or deleted, data loss, and mechanisms that look enforced but aren't. Do not be agreeable and do not praise the code. Where an area holds, say so in one line.

## Context you need

- **The product:** SENTRY is a multi-tenant operations platform for private security companies in Pakistan (PROD §1–2). Guards carry an Android app that tracks them during shifts, runs patrols and reports incidents and SOS. Owners, administrators, supervisors, dispatchers and duty officers use the web dashboard.
- **How it was built:** Claude Code built it in phases (ARCH §22), one at a time, from the three documents. Each phase has a `PLAN.md` and a `REPORT.md` in `docs/phases/`. Decisions are in `docs/DECISIONS.md`. Precedence: SEC > DECISIONS > PROD > ARCH.
- **What the builder claims:** `CLAUDE.md`, section "How the invariants are enforced", maps each rule to the file and the test that enforce it. Treat every row as a claim to test, not a fact.
- **Maps of the code:** `docs/generated/` has the route inventory, the database diagram and the test-ID traceability, all generated from the code.
- **Not built yet, in pass 1** (Phase 10 or waiting on the owner; don't report them as missing, but do flag a design that would make them hard to build or unsafe; pass 2 has its own list above):
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
- **Pass 2 adds:** the browser tests, `pnpm e2e` (once: `pnpm --filter @sentryops/web exec playwright install chromium`), and the Terraform checks, `bash infra/scripts/tf-test.sh` (Terraform 1.11 or later; mocked providers, no AWS account).

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
