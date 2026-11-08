# Phase 10 — Hardening and launch · PLAN

| | |
|---|---|
| Date | 2026-11-02 |
| Go-ahead | The owner, 2026-11-02: "After all this, we proceed to phase 10." |
| Read | everything; mainly PROD §17–§18; ARCH §18–§22; SEC §13–§18 |
| Exit | PROD §18, the definition of done for V1 |

Phase 4's device tests are still open, so `status.json` stays at Phase 3, as for Phases 5–9.

**This phase is different.** Most of its exit needs people and accounts, not code: device tests on real phones, the legal review, a native Urdu speaker, the SMS provider, store accounts and approvals, a domain and the Paid plan. The code comes first, in an order that unblocks those long waits. Each item below says what it waits for.

## Where V1 stands against the definition of done (PROD §18)

| Done when | Now | Phase 10 adds | Waits for |
|---|---|---|---|
| Critical workflows work end to end on staging and production | The test environment runs Phase 9 (released 2026-11-02); there is no staging or production yet | browser tests of the critical flows; simulator scenarios; production built | domain and Paid plan (owner) |
| Every adversarial test in SEC §18 passes | 124 IDs have tests; INV-03, 04 and 11 are now cited by the tests that prove them. ADV-X08 (release build manifest) is written, with its tests and a negative control; its CI job has not yet run. Only ADV-O05 (phone rebooted, a device test) has none | the CI job's first run, and any fixes it needs | ADV-O05: the device tests |
| Background tracking passes the device matrix | not run; the sheet is ready (`docs/testing/device-matrix.md`) | builds and checklists | phones and people (owner) |
| Offline, out-of-order and duplicates proven | integration tests (Phase 4) | "offline 30 min" and "reconnection storm" through the real API | — |
| GPS accuracy and stale locations shown honestly | Phases 5–6 | freshness transitions in the browser tests | — |
| SOS end to end, including offline, escalation, the silent-phone check and drills; the synthetic SOS runs in production | server and dashboard done (Phase 8). Texts can't be sent (no provider). The guard app doesn't register for pushes yet. The canary is off | the phone's push registration; the provider's sender once one is chosen; the canary in production | Firebase (today's guide); SMS provider (EXT-10); production |
| QR replay, file access, tenant isolation, authorization tested | done (Phases 1–9) | — | — |
| Audit logs, retention, evidence preservation | done (Phase 9); the first retention run on AWS logged 2026-11-02 | — | — |
| Migrations, staging, production deployment, monitoring and runbooks work; a restore drill done | migrations run by `release.sh`; a post-release smoke test (`smoke.sh`); alarms for the SOS pipeline only; no runbooks; a restore drill on test passed 2026-11-02 (`docs/testing/restore-drills.md`) | the other operator alarms; the nine runbooks | the drill on production before launch: production |
| Performance targets met in load tests (ARCH §18.3) | nothing | a load harness; a baseline run on this computer | a production-sized run: production |
| Privacy policy and guard disclosure final in every language; legal review | the disclosure is in the app (English, Urdu); no policy | drafts for review | a lawyer; a native Urdu speaker (owner) |
| External approvals granted; store listings approved | none | listing texts, Data safety answers, review notes, a demo organization for reviewers | D-U-N-S, Play and Apple organization accounts, Expo account (owner) |
| All decisions closed; no open Critical or High audit findings | decisions closed; no audit of the built code yet | an audit brief; fixes | Fable (owner) |

## Scope, in order

### A. Code and checks (no outside dependency)

1. **Guard pushes on the phone (D-26).** The app gets its Firebase token, registers it (`POST /me/push-token`) and renews it when it changes. Shift notices and "SOS acknowledged" arrive as notifications, on their own Android channels. It needs `expo-notifications` (a native change, so a new development build) and the Firebase app file at build time, kept out of the public repo.
   - **Status 2026-11-08:** written and unit-tested (7 tests, mutation-checked). `src/core/push/registrar.ts` registers the token; `expo-notifications` 57.0.22 added; the server's FCM sender names the `sos` and `shift` channels. **Untried on a phone** (needs the Firebase files, the Expo account and a cloud build). The first `android-manifest` CI run shows which permissions Firebase adds to the merged manifest (expected: `com.google.android.c2dm.permission.RECEIVE`, perhaps `WAKE_LOCK`, which SEC pitfall 32 makes a decision, not a formality).
2. **ADV-X08 in CI.** Written 2026-11-08. The `android-manifest` job generates the Android project from the config, has Gradle merge the release manifest and fails if the monitoring declaration is missing or a permission isn't on the allow-list (ARCH §19.3). It also checks the location service's foreground type (EXT-31), the target level (EXT-06) and that backups and plain HTTP are off. Unit tests and a negative control prove the check can fail. **It can only run in GitHub's CI** (it needs the Android SDK), so its first run is still to come and may need a fix or a review of a permission a library adds. The iOS Info.plist check waits for a macOS build, with the Apple account.
3. **Traceability through Phase 10.** INV-03, 04 and 11 cited by the tests that prove them. The script gets a `--through <phase>` option, so the remaining gaps show before the device tests let `status.json` move.
4. **Browser tests (ARCH §21.1).** Playwright against a local stack. Sign-in; an SOS arrives with its alarm, is acknowledged and resolved; freshness changes on the live map; an export is downloaded.
   - **Status 2026-11-08:** built and passing (`pnpm e2e`, `apps/web/e2e/`, Playwright 1.65.0, dev dependency only). A script starts a throwaway PostgreSQL, the API, the worker and the dashboard, and seeds a company with a guard on shift. Four tests in a real Chromium: a member signs in; a person with no company sees nothing of any; an SOS arrives with its full-screen alarm, is acknowledged and resolved; a CSV export is requested, built by the worker and downloaded with its byte order mark. A CI job `browser-tests` runs them (not yet a condition of the image job). **Not covered yet:** freshness changing on the live map (needs WebGL in the headless browser), Urdu/RTL screens, the phone-width layout.
5. **Load and simulator harness (ARCH §19.2, §21.2).** Simulated guards go through the real API: enrolled devices, signed batches, heartbeats.
   - **Scenarios:** 100 guards on a normal night, a guard leaving the site, 30 minutes offline, an SOS sent while offline, a reconnection storm (1,000 phones each uploading a 60-minute backlog within 2 minutes), 500 dashboard streams.
   - **Measures:** it measures the ARCH §18.3 targets and counts rows to prove nothing was lost.
   - **Runs:** a baseline on this computer, labelled as such; the real run needs production-sized infrastructure.
   - **Status 2026-11-08:** built (`pnpm load`, `apps/api/load/`). Scenarios run: reconnection storm, dashboard snapshot, normal night, 100-item batches, 30 minutes offline, guard leaving the site, SOS under load. The first baseline found a 100-item batch taking 0.73 s (target 0.3 s); the sync pipeline was reworked to ask the database about six times less (same behavior, proven by tests that pass on old and new code), and the second run measured 0.11 s and a storm drained in 25 s instead of 137 s. Baselines in `docs/testing/load-baseline.md`. **Not yet:** 500 dashboard streams; a production-sized run.
6. **Operator alarms (ARCH §18.4).** Job lag over 2 minutes, ingest errors over 2%, provider failures over 5%, database health and certificate expiry, in Terraform. A few alarms past the free ten cost $0.10 a month each; they are listed before they are applied.
   - **Status 2026-11-08:** written in `infra/terraform/cell/operations.tf` (job lag, worker silent, provider failure rate, API error rate, no healthy API task, database CPU and storage, certificate expiry, crash-report burst) with a worker heartbeat (`workers/health.ts`, tested). `terraform validate` passes. **Not applied:** about a dozen new alarm metrics, roughly $1 a month at CloudWatch's published rate; applying needs the owner's OK and an `aws login`.
7. **Crash reports from the guard app (ARCH §18.6), to our own server only** (owner decision 1).
   - The app reports its own errors to the API, scrubbed like the logs (SEC §15): no names, numbers, locations or incident text.
   - It notes when it was last closed unexpectedly.
   - No new company gets data. Native crash details come from Google Play once the app is there.
   - **Status 2026-11-08:** done and tested on both sides (API route with a strict contract, 4 tests; phone builder, queue and unexpected-close marker, 13 tests; both mutation-checked). Stored in the API's service log only (30 days), not in a table (SEC §16.2); recorded in `DECISIONS.md` for veto.
8. **Runbooks (ARCH §18.7, `docs/RUNBOOKS/`).** The nine named there. Each says how you notice, what to check, the commands, how to confirm it's fixed and who to tell. Missing operator commands get added and tested: replaying quarantined sync items, an organization's delivery health, and revoking an app version. Each runbook is tried on the test environment where it can be.
   - **Status 2026-11-08:** the nine runbooks and an index are written (`docs/RUNBOOKS/`), every command checked against the repository. **None has been tried on the test environment yet** except the restore drill. Operator commands added and tested: `delivery-health`, `quarantine-list`, `quarantine-replay` (reason required, `PLATFORM_ACCESS` audit row). "Revoking an app version" needed more than a command: the server did not enforce minimum or revoked versions (ARCH §15.2, INV-15); it does now, and `mobile_revoked_versions` is a Terraform variable. 25 gaps are listed in `docs/RUNBOOKS/README.md`.
9. **Restore drill (ARCH §19.6).** A script restores the database to a new instance from a point in time. It checks the copy (migrations, row counts, RLS on, the runtime roles), measures the time against the 4-hour target and deletes the copy. **Done on test 2026-11-02, passed** (`infra/scripts/restore-drill.sh`, `docs/testing/restore-drills.md`). Production's drill runs before launch.

### B. Documents for people to review (drafts; people sign off)

10. **Legal drafts:**
    - a privacy policy and terms of service;
    - a data-processing agreement for customers (they control their guards' data, SENTRY processes it);
    - the list of sub-processors;
    - the guard disclosure checked against the app's text, in English and Urdu.
   - **Status 2026-11-08:** first drafts written in `docs/legal/` with the lawyer's questions in its README. The guard-disclosure check found several places where the in-app text says less than the product does (see `docs/legal/GUARD_DISCLOSURE_CHECK.md`). The drafts are not advice and need the lawyer.
11. **Store material:**
    - Play's Data safety answers, its background-location declaration and the script for its video;
    - the App Store's privacy answers and review notes, which describe SOS as alerting the company's control room (EXT-21);
    - the listing texts;
    - the demo organization for reviewers (PROD §17, no real people).
   - **Status 2026-11-08:** drafted in `docs/store/` (Play Data safety, declarations and demo-video script, App Store privacy answers, listings in English and Urdu, review notes). Store forms change often: each answer is marked to be re-checked on the form itself.
12. **The audit brief for Fable:** what was built, where each invariant is enforced and how to run everything. It points at code and tests, not at conclusions.

### C. Waiting on the owner (each unblocks something above)

- **Firebase project** (guide given 2026-11-02): A1 tested on a phone.
- **Expo account:** the first cloud build with pushes.
- **SMS provider (EXT-10):** SOS texts. Its sender is written once the provider is chosen.
- **A lawyer and a native Urdu speaker:** B10 made final.
- **D-U-N-S, then Play and Apple organization accounts:** B11 submitted. iOS waits for the Apple account (D-26), so Android goes first.
- **Domain, Paid plan and "activate advanced features":** production is built, the production-sized load test runs and the canary runs in production. Costs are shown before anything is created.
- **Device tests:** ADV-O05 and the matrix; then `status.json` moves.
- **Fable audit:** fixes, then a check of the fixes.

## Tests

- **ADV-X08:** the new CI job and its negative control.
- **Browser tests:** of the critical flows (A4).
- **Load targets (ARCH §18.3):** reported from the local baseline; a pass/fail gate only on production-sized infrastructure.
- **Restore drill:** the measured restore time and the checks.
- **Operator commands:** each new one tested on the embedded database (tenant rules included).
- **Phone:** unit tests for token registration and renewal.

## Decisions

**Owner decisions (2026-11-02, `docs/DECISIONS.md`), each as recommended:**

1. **Crash reports:** our own server only (A7).
2. **The Fable audit:** the owner runs it, now on Phases 0–9 and again at the end on Phase 10's changes. Claude Code writes the brief (B12) first, so the audit can start while the rest of the phase is built.
3. **AWS test environment:** Phase 9 released there and the restore drill run there (about $0.30 of credit), then paused again.

**Agent-decided (listed for veto in the report):**

- `expo-notifications` for the push token: Expo's own module (MIT). It returns the phone's Firebase token, so no Expo push service is involved (D-26).
- Playwright (Apache-2.0, Microsoft) for browser tests, as a development dependency only.
- The load harness is our own Node script, with no new dependency.

## Not in this phase

- PDF exports, legal holds, and anonymizing a departed guard's records (as in Phase 9).
- iOS pushes and an iOS release, until the Apple account exists.
