# Fable launch audit, pass 2: what was fixed, and how it is proven

Fable audited commit 666e688 (the pass-1 fixes and everything Phase 10 added) on 2026-11-09. It re-checked L-01 to L-26 (18 fixed, the rest partly fixed, documented or waiting on the owner as recorded) and reported ten new findings, L-27 to L-36: two Medium, eight Low. Its verdict: real guards at the 50-guard stage, once two things are done: SOS capacity (L-27) and Terraform tests that really hold (L-29). This is the answer, finding by finding, on branch `fable-pass-1`. Written 2026-11-09.

- **Fixed** means a test or check now fails on the old code and passes on the new. **Mutation-checked** means it was also run with the fix removed, and failed.
- **Verify** marks a claim no test here can prove: it needs AWS, a device or a person.
- The questions only the owner can answer are in `docs/DECISIONS.md`, "Fable launch audit, pass 2".

Nothing here has been applied to AWS or committed.

## Summary

| Finding | Severity | Status |
| --- | --- | --- |
| L-27 SOS shares one pool with sync; no capacity kept for it | Medium | Fixed without spending: its own pool, and 503 instead of 500. Owner (Q7): one API task for now; the WAF rule still open |
| L-28 the WAF exemption covers the dashboard's SOS screens too | Low | Fixed: the four guard routes only |
| L-29 Terraform tests pass with the mechanism broken | Medium | Fixed: structural assertions, and 10 mutations CI runs |
| L-30 two skipped paths served without a CSP | Low | Fixed |
| L-31 a data exception's message quotes the value | Low | Fixed |
| L-32 runbooks: stale "no versioning", a silent SOS outage, `apply -auto-approve` | Low | Fixed |
| L-33 "only `replayed_at` may change" not in the linter | Low | Fixed, and for incidents (INV-05) too |
| L-34 the canary's private key in the operator's log | Low | Partly: the warning names it; the clean fix is listed below |
| L-35 the release build fetches fonts from Google | Low | Fixed: fonts in the repository |
| L-36 the CSP checked only under `next dev` | Low | Fixed: `pnpm verify` checks the production build |
| Pass-1 residuals Fable named | – | L-15, L-18 and §5 #4 fixed; L-07's production half built after the owner's answer (Q6); others below |

## Findings

### L-27 · SOS capacity (Medium)

**What was wrong.** The SOS routes are never rate-limited and skip the WAF (INV-15), but they shared the API's single pool of 10 connections with sync. In a reconnection storm the pool ran out, and an SOS answered `500 INTERNAL_ERROR` and waited for the phone's backoff. The load harness had already seen that pool answer 500 under 16 concurrent uploads (`docs/testing/load-baseline.md`, note 4).

**What was done (nothing here costs money).**

- The API opens a second pool of 3 connections (`SOS_POOL_SIZE`, `apps/api/src/server.ts`) that only the routes with `policy.sos` use, from the session and device lookups to the commit (`routes/registry.ts`). A storm can take all 10 others and an SOS still gets a connection. Each API task now holds up to 13 connections.
- A request that finds no connection, a database that refuses or drops connections, or the password-rotation window answers `503 NOT_READY` (ARCH §15.1: "dependency unavailable"), not 500 (`errors.ts`, `databaseUnavailable`). Ordinary requests get `Retry-After: 5`; the phone's sync engine already honours it. An SOS gets no `Retry-After`, because the phone's SOS lane already retries on its own 2-second backoff, and a header could only hold it back.
- The load harness now runs with the same SOS pool, so its SOS figures are the API's.

**Proof.** `apps/api/test/sos-capacity.test.ts`: with every connection of the main pool held, `GET /me` answers 503 with `Retry-After: 5` while `POST /sos` answers 200 RECEIVED and its status reads. With the SOS pool held too, an SOS answers 503 without `Retry-After`. When the connections are free again, everything answers. Mutation-checked twice: routing SOS back to the shared pool makes the SOS answer 503; removing the 503 mapping makes `GET /me` answer 500. Both are now negative controls.

**Not done: owner question Q7.**

- Fable's WAF rate rules on the SOS path. A rule that limits SOS requests would rate-limit SOS acceptance, which INV-15 forbids, so it needs your decision, not mine.
- Two API tasks in production. That costs money.
- A flood of unauthenticated SOS requests can still fill the 3 SOS connections. Each refused request costs one device lookup.

### L-28 · the WAF exemption's breadth (Low)

**What was wrong.** `STARTS_WITH /api/v1/sos` also exempted the dashboard's `GET /sos/:id`, `acknowledge`, `resolve` (free text) and every `/sos-drills` route from the managed rules.

**What was done.** Each of the three managed rule groups now skips the guard's four SOS routes and nothing else: `^/api/v1/sos(/[0-9a-fA-F-]{36}/(status|locations|cancel-request))?$`. The pattern is defined once, as `local.sos_guard_paths` in `edge.tf`. It is still matched after URL-decoding and path normalization. INV-15 protects SOS *acceptance*, which the dashboard routes are not. Narrowing the exemption could only make the WAF see more, so this was built rather than asked (agent-decided, for veto).

**Proof.**

- `route-registry.test.ts`, "INV-15 the WAF skips exactly the guard's SOS routes": it reads the pattern from `edge.tf` and matches it against every mounted route (with lower- and upper-case IDs). Every `policy.sos` route must match, and nothing else may. A path that is no route (`/sos/`, `/sosx`, `/sos/<id>`, `/sos/<id>/status/extra`, a `..` path, `/sos-drills/current`) must not match either.
- Mutation-checked: the old prefix fails (`GET /sos/:id` would skip the WAF), and a pattern without `cancel-request` fails.

### L-29 · the Terraform tests did not hold what they claimed (Medium)

**What was wrong.** Fable proved four mutations passed all nine runs:

- A: the scope-down read the query string instead of the path.
- B: `EXACTLY` instead of `STARTS_WITH`.
- C: older photo versions never expire. `alltrue([])` is true, so this passed.
- D: the copy bucket had no lifecycle at all.

**What was done.**

- The WAF run now rebuilds, from the plan's structure, what each rule group skips: for every statement under the `not` (and under its `or`), the kind of match, the pattern or search string, its positional constraint, the part of the request it reads and its transformations. It compares the result, rule by rule, with the exact expected set. A new rule group, a lost `not`, another field, constraint, pattern or transformation each changes the result.
- The photo-bucket run now requires one enabled rule, in the bucket and in its copy, with no tag or `and` filter, that expires older versions after exactly `db_backup_retention_days` and cleans delete markers. It also checks that the copy is versioned.
- `infra/scripts/tf-mutations.sh` (run by `tf-test.sh`, so by CI's `terraform` job) breaks each mechanism in a scratch copy of the cell. `terraform test` must then fail in the run named:
  - Fable's A–D;
  - E: the exemption widened back to `/api/v1/sos*`;
  - F: normalization replaced;
  - G: a fourth rule group with no exemption;
  - H: the copy not versioned;
  - I and J: production allowed to turn off its WAF or its backup copy.

**Proof.** `bash infra/scripts/tf-test.sh`: 11 runs pass, then "Every mutation is caught" (10 of 10), with Terraform 1.16.5. The harness also fails when a substitution changes nothing, or when the tests fail in a different run than the one named, so a mutation that stops applying cannot pass silently.

**Limit.** A lifecycle rule's `prefix` is computed by the provider and unknown in a mocked plan, so a prefix added to the all-keys rule would not be caught. A tag or an `and` filter would be.

### L-30 · `/favicon.ico` and `/_next/image` without a CSP (Low)

**What was done.** `next.config.ts` sends `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` on the two paths the proxy skips that can still answer with a page (`NOTHING_POLICY_PATHS`, `lib/csp.ts`). The other two skipped paths never serve a page: `/_next/static/` (hashed files) and `/api/` (the API sets its own policy).

**Proof.**

- `csp.test.ts`, "gives every path it skips a policy too…": the matcher's exclusions must equal exactly the paths with the nothing-policy plus the two never-a-page paths, so a new exclusion fails until it is classified. `next.config.ts` must send the policy on each.
- The production check below fetches both paths from `next start`.

### L-31 · PostgreSQL data exceptions quote the input (Low)

**What was done.** `serializeError` (`logger.ts`) replaces the message of any SQLSTATE class 22 error with the condition's name (`invalid_text_representation`, …). It also drops the stack's first line, which repeats the message, and keeps the frames. The worker's loop-failure lines now go through the same allow-list (`failureLine`), not `error.message`.

Class 23 (constraints) was left alone, which narrows Fable's suggestion: PostgreSQL's class-23 messages name only constraints, tables and columns. The values are in `detail`, which is never logged, and the existing L-04 test relies on the constraint message. No migration raises its own errors.

**Proof.** `logger.test.ts`, "a data exception is logged by its condition, never the value it quotes": both pino and the worker's line drop `+923001234567` and keep `errorCode`, the condition and the frames. Mutation-checked.

### L-32 · runbooks (Low)

- **(a)** Runbook 08 claimed photos have "no versioning". It now says how to restore a deleted or overwritten photo while its older version lasts (`list-object-versions`). Runbook 03 and gap G10 had the same stale claim; G10 is now "nothing alarms on a deletion" (CloudTrail data events, L-22).
- **(b)** Runbook 05's database-password rotation now has a warning above step 1: until step 3's new tasks are up, new connections fail, an SOS included (it answers 503 and the phone retries). Do it at the quietest hour, tell the control rooms, and have step 3's commands typed in advance. Step 3 now gives those commands.
- **(c)** No runbook says `apply -auto-approve` any more. `tf.sh` gained `apply-plan <file>`, and runbooks 04, 05 and 09 save the plan (`plan -out=…`), read it, and apply that file, so whatever drifted since is never applied unread.

### L-33 · the replay grant's guard (Low)

**What was done.** The table registry gained `runtimeUpdates`, the exact columns `app_runtime` may update. `lintSchema()` (ADV-X01) compares it with `has_column_privilege`, so a grant through PUBLIC or another role counts too. It is set for `quarantined_items` (`replayed_at`) and for `incidents`, whose INV-05 column grant (migration 0010) had the same gap.

**Proof.** The linter's "catches each kind of violation" test plants `grant update on quarantined_items to app_runtime` and expects the problem. A new negative control plants the same grant in a clean database and the clean-schema test fails, naming the eight columns.

### L-34 · the canary's private key (Low, partly)

**What was done.** `operator.sh`'s cleanup warning, printed when it cannot delete the task's log stream, now names `CANARY_DEVICE_KEY`: "treat that key as exposed and make a new canary". On success the stream is deleted, as before.

**Not done.** The clean fix is for the operator to make the key pair on their own computer and give `create-canary` only the public key, so the private key never enters AWS. That changes the command and runbook 05. It belongs before production's canary is created, which has not happened. Fable's alternative, letting the task write the worker secret itself, would give the API's role write access to the worker's secrets, so it was not taken.

### L-35 · fonts from Google at build time (Low)

**What was done.** `app/layout.tsx` uses `next/font/local` with two committed files in `apps/web/app/fonts/`, each with its SIL Open Font License beside it:

- Inter's Latin variable subset, the file Google served (no reserved font name);
- Orbitron's unmodified upstream variable font from the google/fonts repository. Orbitron's licence reserves the name "Orbitron", so Google's subset, a modified version, is not redistributed.

The build now fetches nothing. One visible difference: characters outside Inter's Latin subset (Latin Extended, such as `ł`) now fall back to the system font. Google's CSS used to bring a separate file for them.

| File | SHA-256 |
| --- | --- |
| `inter-latin-variable.woff2` (48,256 bytes) | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `Orbitron-wght.ttf` (38,576 bytes) | `f42db2dd16e642258e35782916eceb1dcdbea06fb958d77ad71dc5963587e8fd` |

### L-36 · the production build's CSP (Low)

**What was done.** `scripts/check-production-csp.ts` runs in `pnpm verify` right after `next build`, so CI's `verify` job runs it too. It checks:

- that the build prerendered no HTML page;
- that `next start` serves eight pages signed out (`/`, `/sign-in`, `/dashboard`, `/live`, `/sos/:id`, `/guards/:id/history`, `/sites/:id/print`, a 404) with a policy whose `script-src` holds a nonce and no `unsafe-*`, and with every `<script>`, script preload and stylesheet carrying that response's nonce;
- that `/favicon.ico` and `/_next/image` get the nothing-policy (L-30).

The browser test (`e2e/csp.spec.ts`) now also checks the nonce on every script the server sent, not only the header.

**Proof.** Mutation-checked: a build without `await connection()` and without the new headers made the check fail on 22 scripts and styles without the nonce, and on both paths. The real build passes.

**Accepted.** Next 16 always prerenders its built-in global error page (`_global-error.html`, shown only when the root layout itself crashes). Its scripts carry no nonce and are blocked; its text, plain HTML, still shows. The check allows that one file by name.

## Pass-1 residuals Fable named

- **L-15:** production now refuses `waf_enabled = false` and `backup_copy_enabled = false` (validations, two `expect_failures` runs, mutations I and J).
- **L-18:** three more negative controls, 17 in all. Each breaks the real mechanism in the source for one run and restores it, via the new `mutated` helper in `scripts/negative-controls.ts`:
  - the response check switched off;
  - an SOS refused below the minimum version;
  - SOS routes back on the shared pool;
  - with a fourth for L-33's grant.
  
  The production CSP check and the Terraform tests are proven by their own mutations (above), not by `pnpm negative-controls`, because each needs a build or Terraform.
- **§5 #4:** the retention-policy check now requires the organization check to be the whole policy expression, or a top-level `AND` term, as PostgreSQL prints it. The control now plants `organization_id = app.current_org_id() or true`, which the old substring check passed.
- **L-07 (production half):** the owner chose Q6 (a), and it is built. In production a response keeps only the keys its schema declares, at any depth, with the handler's own values; a strict schema's undeclared keys are dropped too. A response that still does not match is sent as it is, with one `response-mismatch` log line naming the route, status and path, never a value. Nothing in production fails for it. Proof: `route-registry.test.ts`, the spread-row test (production now drops the coordinates) and "in production a response keeps only what its schema declares…" (a strict schema, nested arrays, a wrong type, and the log line without values); a negative control puts the unstripped result back and the test fails.
- **L-08:** left as Fable accepted it. A fixture's ID only has to appear in the named file; the generated `:id` probe is the real control.
- **§5 #9 (pre-release versions):** not changed. `X-App-Version` is the app's own claim, so the gate protects against honest old builds, not a forged client (DECISIONS, Phase 10).
- **Operator replay and a disabled guard:** not changed. Disabling a guard revokes their sessions, not their phone. A replay re-runs only items that phone captured earlier, while the guard was working, and the pipeline's shift rules still apply.
- **Verify on AWS at the next release to `test`:** L-06 (a session's IP is the client's) and L-14 (the running image carries a `release-*` tag).

## The owner's answers, built (2026-11-12)

The owner chose every recommended option for the pass-1 questions and for Q7's WAF rule. What each one built, with its proof (each test was also run against the old code and failed):

- **Q1, a disabled guard's SOS (L-11): accepted and marked.**
  - The API accepts an SOS from an ACTIVE phone whatever its guard's status, on the session or the device-key path (`context.ts`). Every other route still refuses a disabled guard. Terminating a guard retires the phone, so a terminated guard cannot send one.
  - The alert's summary ends "guard disabled" and its details carry `guardDisabled`. The pushes and texts begin "Guard account disabled: confirm who is calling.", and so do the dashboard's alarm, its bar and its browser notification.
  - On the phone, a 401 on the SOS lane now shows "SOS not accepted by the server yet — call your supervisor. Still trying." and offers the call and SMS at once, instead of "waiting for network". It keeps trying, because a phone whose clock the server cannot yet correct also gets 401.
  - Proof: `apps/api/test/sos.test.ts` (a suspended guard: other routes 401, a signed SOS RECEIVED and its status readable, the alert, the list and every delivery marked, an active guard's not); `apps/mobile/test/sos.test.ts` (the reducer, and the lane against the fake server); `apps/web/test/alarm.test.tsx`; a negative control.
  - The new Urdu line waits for the native speaker's review with the rest.
- **Q2, photos: versioning only**, as built. Fable's condition, the CloudTrail data events, is a spending item still open.
- **Q3, the WAF and SOS:** as built, narrowed by L-28.
- **Q4, the device key: accepted for the pilot.** SOS stays off until the hardware-bound key exists. A Terraform run (`sos_stays_off_until_the_device_key_is_hardware_bound`) and mutation M fail if the API's `FEATURE_SOS` is set true.
- **Q5, operator access: the owner's login only.** `scripts/test/terraform-iam.test.ts` fails if any role the cell creates may run, start, change or enter an ECS task, register a task definition or pass a role, if an AWS-managed policy other than ECS's task-execution policy is attached, or if the cell creates an IAM user. A negative control adds `iam:PassRole` to CI's image role. The account's own IAM users are outside Terraform: keep none but the owner's in production.
- **Q7, the WAF rule: counting only.** In production, the `sos-flood-count` rule counts an address sending more than 2,000 requests in 5 minutes to the guard's SOS routes, and blocks nothing. The `sos-flood` alarm emails the operator; runbook 01, "SOS flood alarm", tells an attack from a mass emergency.
  - The Terraform run `sos_floods_are_counted_never_blocked` checks the action, the key, the limit, the pattern, the field and the normalization. Mutations K (block) and L (query string) are caught.
  - The rule's first version showed the harness at work: mutations A and F, which break the first SOS pattern in `edge.tf`, landed on the new rule and were not caught. The rule's field and normalization are now asserted too, and A and F are anchored on a managed group again.

Still the owner's: the two spending items (a KMS key for the state buckets; CloudTrail data events on the photo bucket).

## What was run

All on 2026-11-09, on this Windows machine:

- `pnpm verify` passed every step:
  - format, lint, typecheck;
  - 828 tests in 90 files (after the owner's Q6 change);
  - the generated docs and database types;
  - the ID gate;
  - all 18 negative controls red (the 18th puts back the unstripped production response, Q6);
  - the audit and the licences;
  - both builds;
  - the new production CSP check: eight pages with every script and stylesheet nonced, both skipped paths with the nothing-policy.
- `pnpm e2e`: 5 of 5 browser tests passed, the stricter CSP test included.
- `bash infra/scripts/tf-test.sh` (Terraform 1.16.5, mocked providers): format and validate passed, 11 runs passed, 10 of 10 mutations caught.
- Each new test was run against the old code, or with the fix removed, and failed, as listed above.

On 2026-11-12, after the owner's answers were built:

- `pnpm verify` passed every step: 842 tests in 93 files, and all 20 negative controls red.
- `pnpm e2e`: 5 of 5 browser tests passed.
- `bash infra/scripts/tf-test.sh`: 13 runs passed, and 13 of 13 mutations were caught.

Not run here: anything against AWS, the `android-manifest` job (it needs the Android SDK, which CI has), and device tests.
