# Fable launch audit, pass 1: what was fixed, and how it is proven

Fable audited commit 8854af8 (Phases 0–9) and reported 26 findings (L-01 to L-26), four High. This is the answer, finding by finding, against `main` at bb6a9ad (Phase 10 part 2) plus these changes. Written 2026-11-09.

- **Fixed** means a test or check now fails on the old code and passes on the new; "mutation-checked" means it was also run with the fix removed, and failed.
- **Verify** marks a claim no test here can prove: it needs AWS, a device or a person.
- The questions only the owner can answer are in `docs/DECISIONS.md`, "Fable launch audit, pass 1".

Nothing here has been applied to AWS or committed.

## Summary

| Finding | Severity | Status |
| --- | --- | --- |
| L-01 dashboard CSP | High | Fixed |
| L-02 WAF can refuse an SOS | High | Fixed (SOS part decided by INV-15; Q3 for veto) |
| L-03 photo bucket not versioned | High | Fixed (versioning, copy to the backup region); Object Lock is Q2 |
| L-04 PostgreSQL error details in logs | High | Fixed |
| L-05 PostgreSQL logs bind parameters | Medium | Fixed, and error DETAIL too |
| L-06 `TRUST_PROXY=true` | Medium | Fixed |
| L-07 responses not checked against schemas | Medium | Fixed outside production; detection widened |
| L-08 fixture entries are unchecked strings | Medium | Fixed; one missing test written |
| L-09 RLS test runs as one role | Medium | Fixed |
| L-10 audit gate fails open | Medium | Fixed |
| L-11 disabled guard's SOS waits for ever | Medium | **Owner decision (Q1)** |
| L-12 alarm holes | Medium | Fixed (most were already fixed by Phase 10) |
| L-13 operator script | Medium | Fixed (log stream); access is **Q5** |
| L-14 ECR can expire the running image | Medium | Fixed |
| L-15 production baseline not enforced | Medium | Fixed |
| L-16 device key not hardware-bound | Medium | **Owner decision (Q4)** |
| L-17 ID gate stuck at phase 3 | Low | Fixed |
| L-18 checks without negative controls | Low | Fixed: 7 new controls, 13 in all |
| L-19 CI and image pinned by tag | Low | Fixed |
| L-20 fastify, fast-uri advisories | Low | Fixed |
| L-21 allow-list matched by ID alone | Low | Fixed |
| L-22 state key, image deps, data events, pre-commit | Low | Partly: two need spending (owner), two not done |
| L-23 release script | Low | Fixed |
| L-24 rate limits per instance | Low | Documented in runbook 07 |
| L-25 documentation drift | Low | Fixed |
| L-26 over-the-air updates | Unknown | Settled: none possible, and a test keeps it so |

## Findings

**L-01 · dashboard CSP (SEC §10).**
- **What changed.** `apps/web/proxy.ts` sets a policy from `apps/web/lib/csp.ts` on every page, with a nonce that is new for each response. Scripts run only with that nonce (plus `'strict-dynamic'` for Next's own chunks), with no eval outside `next dev`. The network reaches only the dashboard's own origin and `tiles.openfreemap.org`. Images may come from the photo bucket (the web task's new `PHOTO_ORIGIN`). No plugins, `<base>`, frames or framing. The root layout waits for the request, so no page is prerendered without a nonce.
- **Proof.**
  - `apps/web/test/csp.test.ts` (8 tests): the policy, the nonce, and the proxy's matcher.
  - `apps/web/e2e/csp.spec.ts`: signs in, opens the dashboard and the live map, and fails on any refused resource. Mutation-checked: with `worker-src 'none'` it failed on MapLibre's worker.
  - All 5 browser tests pass.
  - A production build (`next build` and `next start`) was loaded in Chromium by hand: every script carried the nonce, React hydrated, and nothing was refused.
- **Verify.** Photos under the policy in AWS: the test environment's bucket host is passed to the web task, but no signed-in page with photos has been opened there.

**L-02 · WAF and SOS (INV-15).**
- **What changed.** All three managed rule groups skip `/api/v1/sos*`. The two groups that read bodies also skip `/api/v1/sync/`. Paths are compared URL-decoded and normalized, so `/api/v1/sos/../guards` is still inspected.
- **Proof.** The Terraform test `no_managed_waf_rule_sees_an_sos` fails against the original `edge.tf`.
- **Verify.** The WAF exists only in production, which isn't built.

**L-03 · evidence durability.**
- **What changed.**
  - The photo bucket is versioned. Older versions expire after `db_backup_retention_days` (35 days in production); export files' older versions after a day.
  - No task role may remove a version.
  - In production (`backup_copy_enabled`), photos (`org/`) are replicated to the backup region with retention's delete markers, so the copy never outlives SEC §16.
- **Proof.** Terraform test `photo_bucket_keeps_versions_and_copies_them`, mutation-checked with versioning suspended.
- **Verify.** First apply on test: enabling versioning on the existing bucket. Replication is untried anywhere (production only).

**L-04 · PostgreSQL error details in logs (SEC §15).**
- **What changed.** Errors are logged by an allow-list: type, message, stack, an identifier-shaped code (as `errorCode`), and the constraint, table and column names. Never `detail`, `where`, `internalQuery` or `hint`.
- **Proof.** `apps/api/test/logger.test.ts` logs a real `pg` `DatabaseError` through pino and through the logger Fastify builds. Run against the old logger, it leaked `24.8607`.

**L-05 · PostgreSQL's own log (SEC §15).**
- **What changed.**
  - `log_parameter_max_length = 0` and `log_parameter_max_length_on_error = 0`.
  - Also `log_error_verbosity = terse`. Not in Fable's report: an error's DETAIL is the failing row, the same leak as L-04, one layer down.
  - The log group is created by Terraform and kept 30 days.
- **Proof.** Terraform test `database_logs_keep_no_values`.
- **Verify.** That RDS accepts the three parameter names (it says so only at apply). The test environment's log group already exists and must be imported once; the command is in `infra/README.md`.

**L-06 · client address (SEC §9, §17.2).**
- **What changed.** `TRUST_PROXY` is now `false` or a list of proxy addresses or ranges; `true` is refused. The cell passes the VPC range.
- **Proof.**
  - `apps/api/test/trust-proxy.test.ts`: the address is the load balancer's view whatever the client writes, also through CloudFront; a connection from outside the range is believed about nothing.
  - Terraform test `the_api_believes_only_the_load_balancer`.
- **Verify.** After the next release to test, that a session's IP is the real client's. If CloudFront's VPC-origin connections came from outside the VPC range, the API would see CloudFront's address. That fails closed: limits would be shared, not bypassed.

**L-07 · responses against their schemas.**
- **What changed.**
  - Outside production, `apps/api/src/routes/response-check.ts` parses every JSON response against its route's schema. A key the schema does not declare, or a response that does not parse, fails the request. Production is unchanged (DECISIONS: a strict check there could turn an accepted SOS into a 500).
  - The ADV-X05 schema walk now also sees prefixed coordinate fields (`startLatitude`) and GeoJSON `coordinates`.
- **Proof.**
  - The whole API suite runs with the check on. It found one real disagreement, the export link schema refusing local `http://127.0.0.1` links (corrected; no leak).
  - A new test spreads a row with coordinates into a response: 500 under test, and mutation-checked (with the check off it returned 200).
  - Negative control: an untagged `startLatitude/startLongitude` schema turns ADV-X05 red.

**L-08 · cross-tenant fixtures.**
- **What changed.** The meta-test now checks each entry: the test files it names exist, and it cites an INV/ADV ID those files cite, or quotes a test title they hold, word for word. Eleven entries cited neither and now do.
- **What was missing.** For one entry, `POST /me/push-token`, no test proved the claim, so `notifications.test.ts` gains "ADV-A10 a push token goes on the caller's own phone, never another guard's or organization's" (two organizations; a body naming another device, organization or guard is refused).
- **Proof.** Mutation-checked: a made-up title fails the meta-test.

**L-09 · every role against every tenant table (ARCH §4.3).**
- **What changed.**
  - The generated read test also runs as `retention_worker` with A's context: A's rows or none.
  - Every `retention_worker` policy on a tenant table must read `app.current_org_id()`.
  - `system_worker` holds SELECT only, on exactly the sweep columns its migrations granted (listed in the test), and only SELECT policies.
- **Proof.** Two negative controls: a `using (true)` retention policy, and a new `system_worker` grant. Each turns its test red.

**L-10 · audit gate.**
- **What changed.** The decision moved to `scripts/lib/audit.ts`. A report that is an error, or lacks advisories and metadata, fails.
- **Proof.**
  - `scripts/test/audit.test.ts` (a new `scripts` test project).
  - Fable's command reproduced: the old script passed `{"error":…}` with exit 0; the new one fails.
  - Negative control.

**L-12 · alarms.**
- **What Phase 10 had already fixed.** Worker heartbeat (a dead worker alarms), job lag, API health, RDS CPU and storage, the 5xx rate.
- **What changed.** The five other worker loops' failure lines (outbox dispatcher, detectors, photos, exports, retention) now raise `worker-loop-failed`. A loop failing every round still reports on time, so job lag never showed it.
- **Proof.** `worker-health.test.ts` checks that every `failed('…')` line in `worker.ts` is counted by a Terraform filter. Against the old `notifications.tf` it named the five.

**L-13 · operator script.**
- **What Phase 10 had already fixed.** `PLATFORM_ACCESS` is written by every look into a company; the runbooks exist; the script runs only the operator CLI.
- **What changed.** `infra/scripts/operator.sh` deletes the task's log stream however it ends, after stopping a task still running, and says so when it cannot. It also waits up to 30 minutes, not the CLI's 10.
- **Proof.** Run against a fake AWS CLI in three cases (normal, a failed log read, an expired session); the old script deleted nothing on a failed read.
- **Owner question.** Who holds `ecs:RunTask` and `iam:PassRole` in production is Q5.

**L-14 · ECR lifecycle.**
- **What changed.** `release.sh` tags what it releases `release-<sha>`, and the first lifecycle rule keeps the newest 50 of those. AWS's rule (checked 2026-11-09): an image a higher-priority rule matches cannot be expired by a lower one.
- **Proof.** Terraform test `released_images_are_kept`.
- **Verify.** The image the test environment runs now (bb6a9ad) is untagged until its next release; tag it by hand, or release, before about 30 more commits reach main.

**L-15 · production baseline.**
- **What changed.** Production refuses to plan without its domain, `alerts_email` and `fcm_service_account`.
- **Proof.** Three Terraform runs expect each refusal; a fourth plans the test environment without any of them.

**L-17 · ID gate.**
- **What changed.** `status.json` gains `builtThrough: "10"` and `runByPeople: ["ADV-O05"]`, so `verify` enforces every ID through phase 10 and names ADV-O05 as still to be run on a device. `runByPeople` accepts only SEC's device tests.
- **Proof.** With ADV-Q09 removed from its test, the new gate failed and the old one passed ("through phase 3").

**L-18 · negative controls.**
- **What changed.** Seven new controls:
  - an unscoped retention policy;
  - a stray `system_worker` grant;
  - an untagged coordinate;
  - redaction without phone numbers;
  - `dangerouslySetInnerHTML` in the dashboard;
  - raw SQL in a route;
  - an audit endpoint answering with an error.
- **Proof.** All 13 controls turn their checks red.

**L-19 · supply chain in CI.**
- **What changed.**
  - Every action is pinned to a commit with its version beside it.
  - gitleaks is pinned to v8.30.1 by digest, and no checkout keeps its git token.
  - The base image is pinned by digest.
  - Dependabot now covers Docker and Terraform.
  - CI's Node matches the image's (24.16.0).
- **Verify.** In CI only; this machine cannot run GitHub's runners.

**L-20 · dependencies.** fastify 5.12.6; fast-uri 3.1.9 and 4.2.3 through scoped overrides. `pnpm audit` now reports no advisory in the API's tree (one allow-listed High in the Expo CLI; four lower ones in mobile and lint tooling).

**L-21 · allow-list.**
- **What changed.** An entry covers only its exact `name@version`, reached through the dependency paths it names. The zod entry now names `>@expo/cli>zod`.
- **Proof.** Unit tests: the same advisory in `apps__api`, or another version, blocks.

**L-22 · four small items.**
- **Not built, needs your OK to spend.** The KMS key for the state buckets, and CloudTrail data events on the photo bucket (DECISIONS).
- **Not done.** Trimming the image's development dependencies (needs an image build to prove the services still start; no Docker here), and a pre-commit secret scan (needs gitleaks installed on this machine).

**L-23 · release script.**
- **What changed.**
  - `release.sh` applies a saved plan, and only if it changes nothing beyond task definitions, the services and the database's running state.
  - It waits up to 60 minutes for migrations.
  - CI no longer cancels runs on `main`, so every green commit gets its image.
- **Proof.** Syntax checked, and the plan filter run on a sample plan.
- **Verify.** The script has not been run against AWS since the change; the next release is its first run.

**L-24 · rate limits.** Runbook 07 now says that limits multiply with API tasks, that only an enrollment code's own attempt count is durable, and to move the counters into PostgreSQL above 2 tasks.

**L-25 · documentation drift.** CI's comments name `cell/github.tf` and `release.sh <environment> <commit>`. `infra/README.md` names `exports/` and the new bucket, edge and log behaviour. The versioning promised by ARCH §19.6 and §19.8 is now built.

**L-26 · over-the-air updates.** `expo-updates` is not installed, so no update can reach a phone. `apps/mobile/test/app-config.test.ts` now fails if it is added, or if the config gains an update URL, because adding OTA updates is an owner decision (SEC §20 #29).

## The new Terraform tests

`infra/terraform/cell/tests/security.tftest.hcl` plans the whole cell against mocked AWS, `random` and `tls` providers: no account, no credentials, nothing created. It has 9 runs. `infra/scripts/tf-test.sh` runs `fmt`, `validate` and the tests, and CI's new `terraform` job runs it before the image job. It needs Terraform 1.11 or later (1.16.5 here and in CI).

- **New action.** `hashicorp/setup-terraform` v3.1.2, pinned to a commit.
  - Purpose: installs Terraform in CI.
  - Maintained by HashiCorp; MPL-2.0 licence; no permissions beyond the job's `contents: read`.
- No runtime or app dependency was added.

## What was run

| Check | Result |
| --- | --- |
| `vitest run`, all projects | 89 files, 823 tests passed |
| browser tests (`playwright test`) | 5 passed, with the new CSP test |
| `negative-controls.ts` | 13 of 13 turned their checks red |
| `infra/scripts/tf-test.sh` | fmt and validate clean; 9 of 9 runs passed |
| production build of the dashboard in Chromium | by hand; no refusal |
| `operator.sh` with a fake AWS CLI | 3 cases, as above |
| `pnpm verify` | see the hand-over message |

**Not run.**
- No Terraform plan against AWS: it needs your `aws login`. Read that plan before applying; it adds resources, replaces the task definitions and changes the parameter group.
- `release.sh` and `operator.sh` have not run against AWS.
- No production image build.
- No device tests.
