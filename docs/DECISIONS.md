# DECISIONS.md — decision log

This log records every product, architecture and security decision (ARCH §0.3–§0.4). Each entry gives the context, options, trade-offs, recommendation and status. Decision numbers are global across the three specs (`D-nn`).

| Status | Meaning |
|---|---|
| APPROVED | The product owner has decided. Binding: the specs must match it. |
| PROPOSED | A recommendation is written and waiting for the product owner. Not binding. |
| OPEN | Needs information before a recommendation can be made. |
| REJECTED | The product owner turned the proposal down; the reason is recorded. |
| SUPERSEDED | Replaced by a later decision, which the entry links to. |

Decisions not listed here keep the status shown in the spec appendices (OPEN unless marked). Spec Revision 3 (2026-10-08) applies everything below.

---

## Owner answers — 2026-10-08

**Round 1** answered questions 1–6 in `docs/SPEC_REVIEW_R2.md` §10.

| # | Question | Answer |
|---|---|---|
| 1 | Legal entity | A registered company in Pakistan. |
| 2 | Phones | Guards use their own phones, one each. |
| 3 | Supervision | Both: a control room and duty officers in the field. |
| 4 | Pilot | A pilot customer is lined up. Its guards use their own phones. |
| 5 | Data residency | Flexible: each client chooses. |
| 6 | Guard sign-in | One SMS, or a popup notification, is acceptable. |

**Round 2** approved or rejected the proposals that followed.

| Question | Answer |
|---|---|
| How to build per-client data residency | Cells, launching with one. |
| Guard sign-in | Invitation SMS once, then popups. |
| Architecture proposals | Yes to D-33 and to the pilot once tracking is proven. No to D-35. Keep the outbox, the SSE replay buffer, the per-organization sequence (initially) and the async geofence worker. **Addition:** show tracking health separately from location (D-36). |
| The rest of the review | Apply all. |

**Round 3** answered the open questions.

| Question | Answer |
|---|---|
| Q-15 Where the data lives | Any cloud service is fine; it must be secure. |
| Q-13 Pilot size | About 1,000 guards. |
| Q-11 Budget | Quality matters more than price, but save money where possible. |
| Q-16 Data passing through providers abroad | Acceptable; not a dealbreaker. |
| Q-08 Devices | Most guards use Android. |
| Q-14 Mobile data | Guards pay for their own data. |
| Q-07 Languages | Only Urdu and English, mostly English. |
| Q-10 Name and wordmark | "SENTRY" is final for now. The wordmark was made with OpenAI's image generator; a vector file exists. |

**Round 4** settled the remaining questions and raised one of the owner's own.

| Question | Answer |
|---|---|
| Supabase, Firebase or AWS? | AWS kept; see the comparison in D-37. |
| Q-08 Testing and devices | An iPhone is available for testing; most guards use Android. **Duty officers use the web app.** |
| Q-13 Pilot sites | Many sites across one very large housing colony, about 312,000–313,000 kanals. |
| Map | A map showing guards' positions, like Google Maps. |

**Round 5:** guards will be both stationed at posts and on roaming patrols (Q-18). The owner then asked to start building.

**Round 6** (after the Phase 0 report). The owner went away for five hours and delegated every open question: "If there is any questions for me, I want you to decide for me instead, think of this like you are co founder."

| Question | Answer |
|---|---|
| GitHub repository | `https://github.com/securitysentry21-cpu/Sentry-Application` (public, empty) |
| Q-13 Pilot date | In 10 days: about 2026-10-18 |
| Q-18 Patrol beats | "I leave the patrol decision to you, I would like some sort of boundaries" → D-38 |
| Q-19 Colony size | About 400 km² |
| Scope | "Go ahead with all of the phases that we can build … the web app, and the framework for the mobile app" |

## Decided under delegation · 2026-10-08 (round 6)

Made as a co-founder would make them, while the owner was away. Each is reversible; review and veto in the diff.

- **Committing.** Yes; commits are local. Commit identity: the repository account's GitHub no-reply address (`339630571+securitysentry21-cpu@users.noreply.github.com`), so neither the owner's name nor their Gmail enters a history that may become public. **Pushed on 2026-10-08** to `securitysentry21-cpu/Sentry-Application`. The owner chose to keep the repository public, knowing that this publishes the code, the threat model and the security design.
- **D-01 · identity provider: Amazon Cognito, reached through standard OpenID Connect.** SEC §5 requires a mature provider; the application never stores passwords, so first-party password sign-in is ruled out.
  - Cognito user pools are regional, so each cell keeps its own sign-in data. Our first cell is eu-central-1 (D-13, D-37); Clerk was recommended before AWS was chosen, and is US-hosted.
  - Cognito sits in the AWS account we are opening anyway, which means no extra vendor and no extra contract.
  - It does TOTP MFA and passkeys. MFA is required for every dashboard user at the pool level, which covers the Owner and Administrator MUST and the Supervisor SHOULD.
  - It is cheap at our scale.

  The API speaks plain OIDC (authorization code with PKCE), so switching providers is a configuration change. Development and tests use a built-in development sign-in, which the API refuses to enable in production.
- **D-11 · PostgreSQL only** for jobs, pub/sub and rate-limit counters: approved.
- **D-07 · location library.** The pilot build uses `expo-location` with `expo-task-manager` (free, maintained by Expo), behind the `LocationSource` interface. The Phase 0B soak tests on the pilot's phones decide whether to switch to Transistorsoft.
- **D-12 revised · map: MapLibre GL JS with OpenFreeMap vector tiles** (OpenStreetMap data), behind the `MapProvider` interface, instead of Google Maps. The owner asked for "something like Google Maps".
  - It needs no account, key or billing; we have none yet, and it can be tested today.
  - Polygon drawing works through Terra Draw, while Google's Drawing Library has been retired.
  - It is free at any number of dashboard map loads.

  Risk: OpenFreeMap is a free service without an SLA. Before scaling past the pilot, serve our own tiles (Protomaps PMTiles on S3 and CloudFront, a few dollars a month) or move to a paid provider. There is no satellite view; it can be added later with a paid imagery provider.
- **D-38 (Q-18) · boundaries.** A site's boundary is either a **circle** (posts and gates, 50–5,000 m) or a **polygon drawn on the map** (patrol beats: 3–200 points, at most 100 km², no self-crossing).
  - Geofence rules treat both the same way: inside only if the fix is inside and further than its accuracy from the edge; outside only if outside by more than its accuracy; otherwise uncertain (PROD §8.4).
  - The colony (about 400 km²) is modelled as many sites under one client, each a post or a beat.
- **Q-19.** About 400 km² (roughly 99,000 acres, or 790,000 standard kanals). Each organization gets a default map view setting.
- **Q-13 · pilot about 2026-10-18.**
  - Pilot 0 needs Phases 1–4 (D-34) and human device tests.
  - The pilot app is distributed as a directly installed Android build (EAS internal distribution), not through Play, which avoids Play's review time and the closed-testing gate.
  - SOS stays off for pilot guards until the Phase 8 exit tests pass (ARCH §22).
  - **Blockers only the owner can clear:** the AWS account, the legal review (EXT-17, before any real guard data), and the device census.
- **Q-20 · app identifier** `pk.sentryops.guard`, for both Android and iOS. It can still change until the first store submission.
- **Q-21 · dispatchers can view shifts** (view only), as built.
- **No SMS aggregator yet.** Guard enrollment codes are shown in the dashboard, as a code and a QR code, for the supervisor to hand to the guard in person. SMS goes behind an `SmsProvider` interface and switches on when EXT-10 is done. Member invitations work the same way: the dashboard shows the invitation link to send by hand until an email provider is chosen.
- **Device key (ARCH §5.3).** The P-256 key pair is generated on the phone and the private key is kept in the secure store (Keychain or Android Keystore-encrypted storage). It is not yet generated inside the Secure Enclave or Keystore hardware, which needs a native module; revisit with Phase 0B.

## Fable launch audit, pass 2 · fixes and open questions · 2026-11-09

Fable audited commit 666e688 (the pass-1 fixes and Phase 10) and re-checked L-01 to L-26. It reported ten new findings, L-27 to L-36, two Medium and eight Low. Its verdict: real guards at the 50-guard stage once SOS has capacity of its own (L-27) and the Terraform tests hold (L-29). Both are done, as far as they can be without spending or changing INV-15. The fixes, finding by finding: `docs/phases/phase-10/FABLE-PASS-2.md`.

**Fable on the pass-1 questions.** It agrees with every recommended option (Q1 (a), Q3 as built and now narrowed, Q4 (a) with the native key before SOS is switched on, Q5 as recommended), with one condition. Q2 (a), versioning only, is enough **only if the CloudTrail data events spend (L-22) is approved with it**: otherwise a deleted or overwritten photo is recoverable for 35 days, but nothing tells anyone to recover it. It would approve both small L-22 spends before real guards.

**The owner's answers (2026-11-09): Q6 (a), strip; Q7 one API task for now.** Q7's WAF rule is not answered yet; it matters only once production, and so its WAF, exists.

- **Q6 · L-07 · responses in production. Decided: (a), built 2026-11-09** (`stripResponse` in `routes/response-check.ts`). It drops undeclared keys and sends the handler's own values, so a schema's defaults or transforms change nothing; a strict schema's undeclared keys are dropped the same way. The question as asked: Outside production, every response is parsed against its schema and an undeclared key fails the request. In production nothing is checked (decided in pass 1, so that a strict check can never turn an accepted SOS into a 500). Fable's point: a handler branch no test reaches can still send a whole row, coordinates included.
  - (a) **Strip in production** (Fable's recommendation, and mine): parse each response; if it parses, send the parsed object, so undeclared keys are dropped. If it does not, send the handler's result unchanged and log one `response-mismatch` line. It never causes a 500. Costs: a parse of every response, the sync batch's answer being the largest. Before building it, a test must show no response schema transforms a value, so stripping removes keys and changes nothing else.
  - (b) Keep "no check in production", recorded as a knowing choice.
- **Q7 · L-27 · the parts of SOS capacity that cost money or touch INV-15. Decided: one API task for now; the WAF rule open.** Built without either: the SOS routes' own 3 connections, and `503 NOT_READY` instead of 500.
  - **Two API tasks in production** (`api_desired_count = 2`). One task is also a single point of failure while it restarts or crashes. Costs a second API task's running price in production; nothing changes on `test`. Recommended. **Owner: one task for now** (`api_desired_count` stays 1); revisit before production carries real guards.
  - **A WAF rule on the SOS path.** Fable suggests limits per device and per IP address. Any limit that blocks is a rate limit on SOS acceptance, which INV-15 forbids, and a per-IP limit can trip in a real mass emergency: many guards behind one carrier address, each SOS also sending its positions. Options:
    - (i) none, as INV-15 stands;
    - (ii) a rule that only **counts**, by IP address, plus an alarm, so a flood is seen and a blocking rule can be added in minutes if one comes. It refuses nothing. It adds one rule to the WAF's monthly charge (AWS lists $1 per rule per month; check before applying). Recommended;
    - (iii) a blocking per-IP flood rule (Fable starts at 5,000 per 5 minutes). This changes INV-15, so SEC first.

**Agent-decided, 2026-11-09, for veto.**

- **The WAF skips only the guard's four SOS routes (L-28)**, matched by a pattern after decoding and normalizing. Before, it skipped everything starting `/api/v1/sos`. INV-15 protects SOS acceptance; the dashboard's SOS screens, acknowledge, resolve and drills are not that, and now keep every managed rule. This narrows Q3's exemption and never widens it.
- **SOS capacity without spending (L-27):**
  - the API keeps 3 connections for the SOS routes beside its 10 (13 per task);
  - a request that finds no connection, or a database that refuses connections, answers `503 NOT_READY`. Ordinary requests carry `Retry-After: 5`; an SOS carries none, so the phone's own 2-second SOS backoff decides when it retries.
- **Only class-22 PostgreSQL messages are replaced in logs (L-31).** Class-23 messages name constraints, tables and columns, never values, and operators need them.
- **Fonts are files in the repository (L-35):**
  - Inter's Latin subset, as Google served it;
  - Orbitron's unmodified upstream file, since its licence reserves the name and Google's subset is a modified version.
  
  Both are SIL OFL 1.1, with the licence beside them. Latin Extended characters now fall back to the system font.
- **The production build's CSP is checked by `pnpm verify` (L-36).** Next's built-in global error page is always prerendered without a nonce; it is accepted by name: its text shows, its retry button does not work.
- **The canary key (L-34): the warning only, for now.** Before production's canary is made, `create-canary` should take a public key made on the operator's computer, so the private key never enters AWS. Giving the API's role write access to the worker's secrets, Fable's other option, was not taken.
- **Production cannot turn off its WAF or its backup-region copy** (pass 2 on L-15).
- **Runbooks apply the plan that was read** (`tf.sh <env> apply-plan <file>`, L-32), and runbook 05 warns that the database-password window refuses SOS connections for a few minutes.
- **A replay of a disabled guard's quarantined items stays allowed.** The items were captured while the guard was working, and disabling a guard revokes their sessions, not their past data.

## Fable launch audit, pass 1 · fixes and open questions · 2026-11-09

Fable audited commit 8854af8 (Phases 0–9) and reported 26 findings, L-01 to L-26, four of them High. The owner brought the report back on 2026-11-09; the fixes are listed finding by finding in `docs/phases/phase-10/FABLE-PASS-1.md`, each with the test that proves it. What follows is what was decided along the way.

**Waiting on the owner (STOP: SOS, evidence, authorization).** Nothing below is built until answered.

- **Q1 · L-11 · a disabled guard presses SOS.** Today the API answers 401 (on the session and on the device-key path), the phone takes 401 for a network problem and shows "waiting for network" on a working network, and nobody is alerted. INV-15 is silent on disabled guards.
  - (a) **Accept and alert, as for a suspended organization** (recommended): the SOS is stored and the ladder runs, the alert marked "guard disabled". A false alarm costs a phone call; a refused one may cost a life, and the guard may be disabled by mistake.
  - (b) Refuse with a distinct code (`GUARD_DISABLED`, 403), and the phone shows the refusal and the call/SMS fallback (PROD §11.7) at once.
  - Either way the phone must stop showing "waiting for network" for a refusal; that part is a bug, fixed with whichever you choose.
- **Q2 · L-03 · can an original photo ever be changed or deleted, except by retention?** Built now: the bucket is versioned, so an overwrite or delete (a bug, a stolen API role) leaves the original recoverable for the backup window (35 days in production), and no task role may remove a version. Someone with the AWS account's administrator rights still can.
  - (a) Versioning only (as built). Recommended for the pilot.
  - (b) S3 Object Lock, compliance mode, on originals, for the organization's incident retention: not even an administrator can delete them before it ends. Retention then cannot delete early either, an organization that shortens retention keeps old photos until their lock ends, and test data cannot be cleaned up. Ask the lawyer whether evidence handling needs it before real incidents are relied on in court.
- **Q3 · L-02 · the WAF and the SOS path.** Built: no managed WAF rule sees `/api/v1/sos*` (IP reputation included: one flagged carrier address would block every guard behind it), and the rules that read bodies skip sync batches. SEC decides the SOS half (INV-15: only a revoked version may refuse an SOS), so this is built rather than asked; veto it if you want the WAF in front of SOS anyway, knowing it can refuse one. The API still validates every field and checks the device signature.
- **Q4 · L-16 · the device key.** The phone's private key and tokens are in `expo-secure-store` (Keystore-encrypted storage), not a hardware-bound, non-exportable Keystore key as D-30 and ARCH §5.3 describe (recorded above under "Device key"). On a rooted phone the key can be copied, and a copied key signs SOS requests from anywhere for as long as the device is ACTIVE.
  - (a) Accept it for the pilot, knowingly (recommended): SOS is off for pilot guards, so the signature path is not in use; sessions are still device-bound and revocable.
  - (b) Build the native Keystore key before the pilot release.
  - Either way, the native key comes before SOS is switched on for anyone.
- **Q5 · L-13 · who may run operator commands in production.** `operator.sh` runs only the operator CLI, and every look into a company writes `PLATFORM_ACCESS` (Phase 10); the log stream that can hold an invitation link is now deleted however the script ends. But anyone with `ecs:RunTask` and `iam:PassRole` in the production account can run any command in the API's image with its secrets. Recommended: in production only you hold those rights (no other IAM user or role), and the break-glass procedure SEC §4.6 asks for is "the owner runs `operator.sh`, with a reason"; confirm, or name who else.
- **Spending (L-22), each yours to approve:** a customer-managed KMS key for the Terraform state buckets (about $1 a month per environment; today they use S3's own keys, and the state holds every generated secret), and CloudTrail data events on the photo bucket, so an overwrite or a presigned read leaves a storage-side trail (cents a month at pilot volume). Neither is built.

**Agent-decided, 2026-11-09, for veto.**

- **The dashboard's Content-Security-Policy (L-01):** scripts only with a per-response nonce, `'strict-dynamic'`, no eval outside `next dev`; the network only to the dashboard's own origin and OpenFreeMap's one tile host; images also from the photo bucket (the web task's new `PHOTO_ORIGIN`); no plugins, `<base>`, frames or framing. Inline styles stay allowed (React renders style attributes; styles cannot run code; SEC §10 asks for no inline scripts). Cost: every page now renders per request (no prerendered pages), a little more CPU on the web task.
- **Responses checked against their schemas outside production only (L-07).** In tests, `next dev` and the browser tests, a response with a key its schema does not declare fails the request. Production sends what the handler returns, because a strict check there could turn an accepted SOS into a 500 that the phone retries for ever. (Changed by the owner's answer to pass 2's Q6: production now drops undeclared keys, still without ever failing.) The check found one real disagreement: the export download link's schema refused the local store's `http://127.0.0.1` links (`z.httpUrl()`); it now matches the photo links' `z.url()`, http(s) only.
- **Older photo versions live as long as database backups (L-03):** `db_backup_retention_days`, 35 days in production, 1 in test; export files' older versions one day. So retention's deletions are complete within the window SEC §16 already discloses for backups.
- **The client's address (L-06):** `TRUST_PROXY` is now a list of proxy addresses or ranges (the VPC's, `10.20.0.0/16`), never `true`. Verify on the test environment after the next release: a session's IP should be the real client's, not a CloudFront address.
- **Released images are kept (L-14):** `release.sh` adds a `release-<sha>` tag, and the newest 50 released images are never expired.
- **`release.sh` applies only the release (L-23):** it saves the plan and stops when it changes anything beyond task definitions, the services and the database's running state; other drift is applied on its own, after reading it.
- **Production refuses to plan without its domain, `alerts_email` and `fcm_service_account` (L-15).** The last means production cannot be applied before the Firebase project exists, which TODO already puts first.
- **The ID gate checks through the built phase (L-17):** `status.json` gains `builtThrough` (10) and `runByPeople` (`ADV-O05`, a device test). `current` stays at 3 until the device tests run.
- **Dependencies (L-20):** fastify 5.12.6 (the fixed release, a month old) rather than 5.12.8 (a week old); fast-uri 3.1.9 and 4.2.3 through scoped overrides inside fastify's own ranges, to be removed when a fresh install resolves them alone.
- **No over-the-air updates (L-26):** `expo-updates` is not installed, and a test now fails if it is added. A fingerprint runtime version would stop only native changes, and tracking is JavaScript, so adding OTA updates is an owner decision first.

**Not done, and why.** The production image still installs development dependencies (L-22): trimming them needs an image build to prove the services still start, and this machine has no Docker. No pre-commit secret scan (L-22): it needs gitleaks installed on this machine; CI scans the whole history on every push, but in a public repository a pushed secret is already out.

## Phase 10 · hardening and launch · owner decisions 2026-11-02

The owner approved Phase 10 ("After all this, we proceed to phase 10"). Three questions, about privacy, process and cost, answered the same day, each as recommended:

- **Crash reports from the guard app (ARCH §18.6): our own server only.**
  - The app sends its own error reports to our API: no names, phone numbers, locations or incident text, scrubbed as the logs are (SEC §15). It also notes when it was last closed unexpectedly.
  - No new company receives data from the guard's phone.
  - Native crash details come from Google Play's own crash reports once the app is on Play. The directly installed pilot app (D-34) has none.
  - **Agent-decided (2026-11-08), for veto:** accepted reports are written to the API's service log only (the CloudWatch log group, kept 30 days, then deleted), not to a table. SEC §16.2 limits stored device diagnostics to the `device_status_events` fields, so a new table would have needed an owner decision on retention too. A report holds the error's class name, the function, file base name and position of up to 12 frames of our own code, app and OS version, platform, a fatal flag and a time, plus the organization and device IDs from the session. It never holds the error's message. Cost of this choice: no dashboard for crash rates; operators read the log (runbook) and an alarm watches for a burst.
- **Agent-decided, 2026-11-08, for veto: the server now enforces app versions as ARCH §15.2 and INV-15 already say.** Until now the API only listed the minimum and revoked versions in `GET /mobile/config`, and the phone gated itself, so a revocation could not stop a build that ignored it.
  - An app below the minimum gets 426 `APP_VERSION_UNSUPPORTED` on guard routes, except: `GET /mobile/config`, the sync upload, incident photo upload and completion, crash reports, and the SOS routes (already-captured data and SOS keep going, INV-15).
  - A version on the revoked list gets 426 on every guard route except `GET /mobile/config`, SOS and uploads included. That is INV-15's one exception, and it means **a revoked build cannot send an SOS**: revoke only to stop a flaw worse than that, and say so in the runbook.
  - The version comes from `X-App-Version`. An app that sends none, or something that is not a version, is not gated, so this protects against honest old builds, not a forged client.
  - Revoking is a Terraform variable (`mobile_revoked_versions` in the environment's tfvars) and an apply; it takes effect when the services have restarted (minutes).
- **Agent-decided, 2026-11-08; owner kept it the same day ("I go with your decision on wake lock"): what Firebase pushes add to the Android manifest** (found by the ADV-X08 CI job's first real run, which merged the manifest with Gradle and found 19 permissions the libraries add).
  - **Allowed:** `com.google.android.c2dm.permission.RECEIVE` (Firebase Cloud Messaging, D-26) and `android.permission.WAKE_LOCK`. FCM holds a wake lock for the moments it handles a push, and removing the permission would make its message handling throw. SEC pitfall 32 forbids *holding* a wake lock through a shift, as a heartbeat source or a library default; declaring the permission does not hold one, and the heartbeat still rides on location callbacks. **Open check, on the device tests:** the wake-lock figure in Play's vitals (EXT-46). If the owner reads pitfall 32 as forbidding the permission itself, the alternative is to block it and give up reliable push delivery while the phone sleeps.
  - **Blocked** (removed from the merged manifest): 16 launcher app-icon-badge permissions from `badgin` (a dependency of `expo-notifications`; the app never sets a badge) and Play's install-referrer permission from `expo-application`.
- **Agent-decided, 2026-11-08, for veto: the platform operator's commands into one organization** (`delivery-health`, `quarantine-list`, `quarantine-replay`).
  - Each needs a `--reason` and writes a `PLATFORM_ACCESS` audit row (an action SEC §17 lists and nothing used yet) in the organization's own log, before reading or changing anything.
  - They run as `app_runtime` inside that organization's tenant transaction, and print counts, ages, IDs and codes only: never coordinates, incident text, phone numbers or the content of a quarantined item.
  - A replay runs the item through the same pipeline as a phone's upload, as that phone. It refuses a phone revoked as LOST, COMPROMISED or by an administrator, and holds a REPLACED phone to its replacement time (ADV-A08).
  - `quarantined_items` stops being listed as append-only (ARCH §6.1's list never included it); the runtime role gets UPDATE on its `replayed_at` column only (migration 0012).
- **The Fable audit: the owner runs it, now and at the end of Phase 10.**
  - Claude Code writes a neutral brief: what was built, where each rule is enforced, how to run everything. It points at code and tests, not at conclusions.
  - The owner gives Fable the brief with the repo, as with the pre-build audit.
  - Findings on Phases 0–9 are fixed during Phase 10; a second pass checks Phase 10's changes.
- **The test environment on AWS: Phase 9 released there and the restore drill run there,** about $0.30 of credit, then paused again. This comes on top of the Phase 8 and 9 Terraform additions approved the same day (under $0.10 a month).

## Phase 9 · reports, exports and retention · owner decisions 2026-11-02

The owner approved Phase 9 ("commit and push phase 8 and then proceed to phase 9"). Three gaps touching retention, privacy and access to exports, asked under the STOP rule and answered the same day:

- **What "operational records" are, and when their 12 months start** (PROD Appendix B, `retention.operational_months`). As recommended:
  - everything that isn't location (90 days), device status (30 days) or audit (24 months) is an operational record: shifts with their events, patrol rounds and scans, alerts with their events, incidents with their notes and photos, SOS with its presses, notification records, export records and drills;
  - each is deleted 12 months after it closed: the shift ended; the alert, incident or SOS was resolved or dismissed; the round closed. Nothing is deleted while it is still open;
  - guard, site, checkpoint, route and member profiles aren't records. They stay until someone removes them.
- **Positions stored on records.** As recommended:
  - after the location period (`retention.location_days`, 90 days) the position is removed from a shift's start and end, from a checkpoint scan and from the live state. The record keeps its times, distances and results for its 12 months;
  - positions on incidents, SOS and their photos are evidence and stay as long as the incident or SOS (SEC §16.5).
- **Who may download a finished export:** anyone allowed to export, that is any Supervisor, Administrator or Owner of the organization. This was not the recommendation (the recommendation was the requester only). SEC still applies to each kind of export at download:
  - a guard's data export stays with Owners and Administrators (SEC §16.6);
  - an export containing location needs location-history access, and the reason when the organization requires one (SEC §16.4);
  - every download is audited (`EXPORT_DOWNLOADED`).

**Agent-decided while building Phase 9 (2026-11-02).** These fill gaps the spec left, each with the simplest option that keeps its rules. Review and veto in the diff.

- **Every export runs in the background,** not only "large ones and any with location" (PROD §15.2). One path is simpler, keeps "one at a time per person", and every file gets the same 15-minute link and 7-day life. The attendance CSV built in the request is gone.
- **Exports holding location** (the location report, a location history, a guard's data):
  - they need location-history access as well as the export permission;
  - a request writes `LOCATION_HISTORY_EXPORTED` with the reason, besides `EXPORT_REQUESTED`;
  - a download asks for the reason again when the organization requires one, since under owner decision 3 the person downloading may not be the one who asked.
- **A guard's data** (SEC §16.6):
  - a ZIP of four CSV files: profile, shifts, location, and the incidents they reported;
  - it holds everything still kept, so the 92-day limit doesn't apply;
  - a new permission, `exports.guard_data`, gives it to Owners and Administrators.
- **The location report:**
  - it needs location-history access and the reports permission, writes `LOCATION_REPORT_VIEWED` first, asks for the D-21 reason, and holds no coordinates;
  - "unknown" time is any stretch longer than `freshness.location_stale_after_s` with no fix;
  - excursions follow the live geofence rules. One is "detected late" when the fix that confirmed it arrived more than 5 minutes after it was taken;
  - distance is measured between usable fixes;
  - the page shows at most 200 shifts and an export 5,000. Beyond that the report says it was cut short;
  - a shift whose track was deleted under retention is labelled so, not shown as "unknown".
- **The other reports:**
  - incidents leave drills out unless asked for. Times to acknowledge and resolve count from receipt;
  - site activity has one row per site and local date, in the site's own zone. A start counts as late after `shift.late_alert_after_minutes`, and cancelled shifts aren't counted;
  - patrols count "missed" only for closed rounds. Their flags are OUT_OF_ORDER, SENT_LATE (a scan that arrived more than 5 minutes after it was made) and SUSPICIOUS.
- **Retention, in detail:**
  - each record's 12 months start when it closed: an alert when resolved or dismissed, an incident or SOS when resolved, a round when it closed, a shift when it ended, a drill when it ended;
  - export records go 12 months after they were made; their files go after 7 days;
  - quarantined sync items go after 30 days, never later than location;
  - the evidence window runs from an incident's occurred time to its reported time, ±30 minutes. For an SOS it runs from the press to the resolution, ±30 minutes, plus the SOS's own trail;
  - anything still referenced by a kept record stays: an open alert keeps its shift. Photos leave the store before their rows;
  - the run is due from 03:00 local once a day. A run that failed half-way is due again, and the last complete run is its `RETENTION_RUN` row;
  - a new settings rule: `retention.location_days` ≤ 30 × `retention.operational_months`, so location never outlives its shift;
  - in production the worker refuses to start without its retention connection.
- **Exports, in detail:**
  - an export left running for 30 minutes by a stopped worker is tried again, 3 times at most, then FAILED;
  - the list shows the newest 200;
  - a download link is http(s) only and served as an attachment.
- **Dashboard** (built by a helper agent from a written brief; reviewed):
  - the Location tab loads only on "Show report";
  - the reason never goes into the address;
  - "Your export is ready" shows on the Exports page.

## Phase 8 · incidents and SOS · owner decisions 2026-11-02

The owner approved Phase 8 ("Go for phase 8. The two decisions we will go with your recommendations."):

- **D-18 · gallery photos allowed, labelled:**
  - a guard may attach photos from the phone's gallery as well as the in-app camera;
  - each photo records where it came from, and the dashboard shows "From gallery";
  - the gallery opens only through the system photo picker, so the app never browses the library (SEC §16.2).
- **D-26 · direct push:**
  - the guard app gets pushes straight from Firebase Cloud Messaging, not through Expo's push service, which means one less third party on the SOS path (SEC §13);
  - the dashboard uses standard Web Push (VAPID);
  - iOS guard pushes (APNs) wait for the paid Apple account.

Four gaps touching SOS and privacy, asked under the STOP rule and answered the same day, each as recommended:

- **SOS text numbers.** Dashboard members are invited by email, so the system had no phone number for the SOS texts of PROD §11.4. An Owner or Administrator enters each member's number on the Members page, audited as `MEMBER_PHONE_CHANGED` (added to SEC §17.1). The number is kept on the membership, not the user, so a person in two organizations can't have one organization redirect the other's SOS texts.
- **Incident location.** Everyone who can see an incident sees where it was reported: Owners, Administrators, Supervisors and Dispatchers, and the guard on their own reports. It marks where the incident happened, reported deliberately during a shift. It is tagged `INCIDENT_LOCATION`, and the coordinate meta-test (ADV-X05) allows that tag only on routes that need an incident permission.
- **Drill participants.** A drill reaches only the members picked when it starts, the person starting it by default (ADV-S10). Only they get its alarm, pushes and texts, marked "[DRILL]". Everyone else sees it in the alert list, marked DRILL, without an alarm.
- **Pressing SOS again after acknowledgement.** The SOS becomes unacknowledged again: the dashboard alarm returns and the ladder restarts from its first step, because the guard still needs help.

**Agent-decided while building Phase 8 (2026-11-02).** These fill gaps the spec left, each with the simplest option that keeps its rules. Review and veto in the diff.

- **SOS delivery:**
  - an SOS notification is tried 3 times (again after 15 s and 45 s), any other 5 times over about 30 minutes;
  - each step of the ladder sends its own actions. Each repeat after the last step ("repeat until acknowledged") goes again to everyone the ladder has reached so far, and to the emergency contacts if any step texted them;
  - with no SMS provider (until EXT-10) a text is recorded as FAILED `SMS_NOT_CONFIGURED`, never as sent;
  - outside production a text to a number not on `SMS_ALLOWED_NUMBERS` is SUPPRESSED, never sent;
  - the operator alarm for an SOS left unacknowledged fires after 10 minutes. Drills are left out.
- **An SOS alert is resolved only on the SOS,** with its type and note (`POST /sos/:id/resolve`). Resolving it through `/alerts` answers 409, so an SOS can't be closed without the resolution PROD §11.4 asks for.
- **Drills:**
  - one drill at a time (`DRILL_ALREADY_RUNNING`), for 5 to 240 minutes;
  - an alert names its drill (`drillId`), and `GET /sos-drills/:id` says who takes part, also after the drill has ended. A dashboard opened late therefore still knows whether a drill SOS is its own;
  - a drill alert with no drill is from a demo or canary organization, and alarms every member there.
- **The SOS position on the stream.** INV-14 audits every read of location history, and the SOS page's trail is history. So:
  - a batch of SOS positions publishes a "position only" event carrying the newest position, live like the live map's;
  - the page moves the marker without reloading, and reloads (and audits `SOS_VIEWED`) only when the SOS itself changes;
  - every role that reads alerts also reads SOS events and live positions, and a test keeps it that way.
- **The dashboard alarm can't be configured off.** PROD §11.5 makes the staffed dashboard the primary receiver, and the alarm rings for every open critical alert until someone acknowledges it. So the SOS settings refuse `dashboardAlarm: false` on any step, rather than accepting a setting that would do nothing.
- **One rule for phone numbers:** E.164 with 8–15 digits, for members' SOS numbers as for the emergency contacts and "Call supervisor".
- **Rate limits:**
  - a guard's incidents: 20 an hour. Beyond that the phone gets RETRY and sends them later, so nothing is lost;
  - incidents recorded from the dashboard: 120 an hour per person;
  - photo upload slots: 30 an hour per guard.
- **Incidents on the phone:**
  - the title is optional. The server titles an untitled report by its type ("Theft");
  - "When did it happen?" offers now, 15 or 30 minutes, or 1, 2, 4, 8, 12 or 24 hours back. The phone never sets it more than 24 hours back or in the future, and the server checks again;
  - "My reports" lists the guard's reports of the last 14 days (50 at most), with their status and photos;
  - the list shows only the guard's own notes. The spec lets guards add notes; it doesn't let them read the supervisors' notes, which stay in the dashboard;
  - a guard may add a note after the report is closed, since corrections are notes (PROD §10.2);
  - during an open SOS off shift, a report is filed under the SOS, with no shift (INV-08).
- **"Checkpoint problem"** (PROD §7.7) is on the patrol screen. The guard picks a checkpoint of this shift's rounds. That files a LOW report of type OTHER, titled "Checkpoint problem: <name>" and linked to the checkpoint. It doesn't count as a visit, and its severity can't be changed on the phone.
- **Photos on the phone:**
  - every photo, from the camera or the gallery, is re-encoded on the phone as a JPEG (long edge at most 2,048 px, quality 0.8) before upload, which drops its metadata, the GPS position included;
  - the server's rule for a GPS position inside a photo (kept only when the photo's time falls in the shift or SOS) therefore applies only to a photo that still carries one;
  - the gallery opens only through the system photo picker, so the app asks for no storage or media permission. Those permissions, `ACCESS_MEDIA_LOCATION` and the picker's microphone stay blocked in the build;
  - HEIC is recognised by its bytes but refused as unreadable. The phone always sends JPEG.
- **An uploaded original can't be replaced.** The signed upload carries `if-none-match: *`, a conditional write S3 enforces, so the same link can't overwrite the original in its remaining minutes. If an earlier try already landed, the phone gets 412 and completes anyway, and the server checks the hash of what is there.
- **Keys in AWS:**
  - the Web Push key pair is generated by Terraform;
  - only the worker, which sends, holds the private key. The API faces the internet and only tells browsers the public key, so it can't be used to forge an SOS push to a control room;
  - task credentials are renewed 20 minutes before they expire, so a 15-minute upload link never outlives the credentials that signed it.
- **Dashboard (built by a delegated agent, reviewed):**
  - notification setup is at Settings › Notifications under "This device", open to every role, since Settings itself is for Owners and Administrators;
  - the alarm's Acknowledge uses `POST /alerts/:id/acknowledge` (the same roles as `sos.ack`), because its answer stops the alarm at once;
  - the push service worker sends the delivery receipt only after the notification is shown;
  - the home-screen manifest has no icon yet: the only brand asset is the wide wordmark (design open item 4).

## Phase 7 · patrols · owner decisions 2026-11-02

The owner read how scanning will work and approved Phase 7 ("Go ahead with Phase 7"), with the three decisions it needs, as recommended:

- **D-16 · per shift:** each guard on duty gets their own patrol runs; guards at the same site don't share them.
- **D-17 · QR-only scans count, always labelled:** a valid scan whose location can't be confirmed counts and is labelled "QR only". An organization can turn this off (`patrol.count_unconfirmed_as_completed`).
- **D-24 · map pin in V1:** a checkpoint's position is set with a map pin in the dashboard; calibrating it on site with the app is V1.1.

**Agent-decided while building Phase 7 (2026-11-02).** These fill gaps the spec left, each with the simplest option that keeps its rules. Review and veto in the diff.

- **Scans arrive only through `POST /sync/batch`,** in the main lane, online and offline alike. ARCH §15 also listed `POST /checkpoint-scans`; it isn't built:
  - a scan sent beside the queue could overtake an offline shift start still waiting in it (ARCH §8.6), and be judged against no shift;
  - one path keeps verification identical online and offline (ARCH §11.2).

  The sync reply carries each scan's outcome (`results[].scan`), and the phone keeps it on the scan's receipt. ARCH §11.2 and §15 are updated.
- **"Clearly outside" is checked before "poor accuracy".** ARCH §11.2 listed poor accuracy first, which would count a scan made 2 km away with a 100 m fix as "QR only". PROD §9.3 defines OUTSIDE_RADIUS as "clearly outside the checkpoint radius even allowing for accuracy", and ADV-Q02 says a photographed label scanned far away doesn't count; both rank above ARCH. So:
  - a fix with known accuracy whose distance minus accuracy is beyond the radius is OUTSIDE_RADIUS, however poor that accuracy;
  - a stale fix, a fake one (by policy), unknown accuracy, or a checkpoint without a position still give LOCATION_UNCONFIRMED.

  ARCH §11.2 is updated.
- **Run windows.** A run takes scans captured from its due time to the end of its window. A checkpoint's scan attaches to the run of its one active scheduled route whose window holds the capture time. Scans outside every window, of on-demand routes, or of checkpoints in no route are recorded with their outcome but count toward no run.
- **Route limits:**
  - an interval of 10–720 minutes;
  - a completion window of at least 5 minutes and no longer than the interval, so a route's runs never overlap;
  - a first-run offset of 0–720 minutes;
  - at most 200 checkpoints;
  - a scheduled route needs at least one required checkpoint.
- **Run changes:**
  - runs not yet due are replaced when the shift is extended or the route changes, and their numbers continue;
  - runs already due are never touched;
  - a route created mid-shift gets runs from then on, not for the hours already passed;
  - a run under way when its route's checkpoints change continues against the new list;
  - a route that stops being scheduled (made on demand or inactive, or left with no required checkpoint) cancels its run under way, so an administrator's change never raises an alert against the guard. CANCELLED therefore also means "no longer owed", not only "the shift ended before it was due" (PROD §9.2).
- **An active route's checkpoints are active.** An inactive checkpoint can't be added to an active route, and a checkpoint can't be switched off while it is a stop of one. Its label would be refused (INVALID_QR), so those rounds could never complete. To retire a checkpoint, take it off its routes first. (Found while reviewing the dashboard.)
- **Closing:**
  - the worker closes a run 2 minutes after its window ends, so a scan made at the last moment can still arrive;
  - at shift end, runs not yet due are CANCELLED, and the one under way closes with what was scanned.
- **Late scans.** Offline scans that arrive after their run closed still update it (e.g. MISSED → COMPLETED). Its CHECKPOINT_MISSED alert stays open: PROD §12.1 says that alert never resolves by itself, so a person sees it next to the run's final state.
- **Duplicates without a run** (on-demand routes): "already counted in the same run" becomes the same shift.
- **Implausible travel** compares the positions of the two checkpoints with the time between the scans, against the previous counting scan in the shift.
- **Rate limit** (SEC §9, 60 scans per guard per minute): counted from the scans received in the last minute. Beyond it a scan gets RETRY and the phone sends it again, so nothing is lost.
- **What leaves the server:**
  - a scan's result names the checkpoint only when it belongs to the guard's own site;
  - it gives a distance, rounded to 5 m, only for OUTSIDE_RADIUS;
  - dashboard responses carry distances and accuracy, never a guard's coordinates.
- **Outside a shift** a scan keeps only the distance band (0–50 m … over 1,000 m), the accuracy and flags. A check constraint in the database refuses coordinates or a distance on any visit without a shift (INV-08).
- **The D-17 setting is editable from the dashboard** (`patrol.count_unconfirmed_as_completed`), as the owner was told when approving D-17.
- **No new realtime event.** The Patrols page reloads every 60 s and when it regains focus. CHECKPOINT_MISSED alerts reach dashboards live, as alert events.
- **Guard app:**
  - it reuses the enrollment scanner (the camera permission has been in the build since Phase 2) and adds a light switch;
  - it takes the on-demand fix the way incidents do;
  - it keeps the last copy of the rounds, for viewing offline;
  - nothing is scanned, and no location taken, outside the active shift (INV-08).
- **Not built: iOS temporary full accuracy.** The pilot is Android (D-34). An approximate fix gives "QR only", never a wrong verification.
- **Q-22 · the message for an old label · approved by the owner (2026-11-02): "Old QR code is good."** PROD §5.4 and §7.7 showed "Old QR code — report to supervisor" for a replaced (rotated) label; PROD §9.3 showed one message for every unrecognised label. The owner chose the separate message:
  - a rotation keeps the hash of the label it replaces (`checkpoint_retired_labels`, migration 0009, append-only);
  - a scan of one of the organization's own replaced labels is still INVALID_QR (ADV-Q05) and counts for nothing, but it is stored with the reason `OLD_LABEL`, and the guard sees "Old QR code — report to supervisor". The dashboard says "Old label (replaced)";
  - the lookup runs in the scanning organization's tenant context, so another organization's labels, old or current, still answer exactly like unknown ones (ADV-T08). Any other unrecognised code says "Unknown QR code";
  - labels replaced before this change were not kept, so they still say "Unknown QR code". No real checkpoint had been replaced yet.

## Phase 6 · live operations dashboard · agent-decided 2026-11-01

The owner asked for Phase 6 to start while Phase 4's device tests are still open (2026-11-01: "can you start working on phase 6 aswell to save time?"). `status.json` stays at Phase 3, as for Phase 5. These are the gaps the spec left, each filled with the simplest option that keeps its rules. Review and veto in the diff.

- **The dashboard reads the stream with `fetch()`, not `EventSource`.** EventSource can't send headers, and the organization comes only from `X-Organization-Id`, never a query string (ARCH §4.1). So the stream goes through the same request pipeline as every other call, and no stream tickets are needed. The wire format is still standard SSE.
- **Stored events hold IDs only; the API adds the current state when it sends them.** One read per organization on each API instance serves all of that organization's dashboards. Otherwise every dashboard would fetch each guard's state for each event: about 17 requests a second per dashboard at 1,000 guards. A replayed event therefore carries the current state, which is what a reconnecting dashboard needs.
- **Membership is re-checked by polling, not by a membership-change event.** Every 30 s each stream re-runs the full request check: session, membership, organization status and permission. A stream that fails it closes. This meets ADV-T02's 60 s for every way access can end: sign-out, removal, suspension, a role change, or an edit made directly in the database. Streams are also cycled every 30 minutes (ARCH §14).
- **Sequence:**
  - the dispatcher numbers each organization's events under a transaction-level advisory lock for that organization;
  - pruning always keeps the newest event, so the sequence never restarts and a position older than the buffer is always recognised (`resync`);
  - outbox rows carry an insertion-order column, so changes made in the same millisecond keep their order.
- **The dispatcher follows the detectors' pattern.** It lists the organizations with pending rows as `system_worker`, then moves each organization's rows as `app_runtime` in its own tenant transaction.
- **Monitoring coverage (PROD §11.5) counts rows in `stream_connections`.** There is one row per open stream, touched every 30 s; a row not seen for 90 s doesn't count, and the worker removes it. So the count stays right across several API instances. Desktop or phone is what the dashboard reports (`?client=`); it grants nothing.
- **Limits on open streams:**
  - at most 10 per user (a few tabs and a phone);
  - a stream with more than 1 MB waiting to be sent is dropped, and replays when it reconnects.
- **Home page counts (PROD §14.2):**
  - "on site" means the geofence says INSIDE; "off site" means a departure is confirmed. A suspected departure, an uncertain fix or no fix yet counts in neither, so nothing is guessed;
  - "tracking problems" means the phone reports its tracking service stopped, a permission problem, or a location permission short of "Allow all the time";
  - "shifts not started" means scheduled shifts whose start time has passed;
  - open incidents wait for Phase 8.
- **Location history (PROD §14.5):**
  - thinning keeps, in priority order, the first and last points, both sides of every gap, then flagged points, and spreads the rest of the 2,000 evenly;
  - a kept point is marked as a break when any gap of more than 5 minutes lies between it and the previous kept point;
  - a shift's range is its start − 60 s to its end + 60 s (ARCH §9.2); a free range is at most 24 hours;
  - the reason is limited to 500 characters;
  - the audit metadata names the range, never a coordinate;
  - one view reads at most 100,000 points (24 hours at one fix a second);
  - nothing loads until the user presses "Show history", because every view is audited.
- **D-21 · approved by the owner (2026-11-01):** built as recommended and as SEC §16.4 already states. The reason field is always shown, optional by default, and mandatory when the organization turns on `privacy.require_history_access_reason` in Settings. The owner: "the mandatory option is fine".
- **D-22 · rejected by the owner (2026-11-01):** the owner sees no use in guards seeing their own location history. Guards see their own shift history in the app, not their location trail. The `location.history.read.own` permission is removed. A guard's own data, location included, still reaches them through an export by an Owner or Administrator (SEC §16.6); the legal review (EXT-17) may revisit this.
- **Map (D-12 revised):**
  - markers cluster, and a cluster takes its worst member's colour, so an offline guard is never hidden;
  - accuracy circles show from zoom 14;
  - details open in a plain-text panel instead of map popups (ADV-W01).
- **The dashboard imports types only from `packages/contracts`,** so zod stays out of the browser bundle.
- **`pnpm demo --crowd=N`** adds up to 2,000 guards to check the Live map at pilot scale. One process plays every phone, so the demo turns rate limits off. It runs only in development.

## Phase 5 · alerts and geofence · agent-decided 2026-10-08 (round 6 delegation)

Gaps in the spec that Phase 5 had to fill. Each is the simplest option that keeps the stated rules; review and veto in the diff.

- **Two settings rules added.** `tracking.stationary_fix_interval_s ≥ tracking.max_interval_s`, and `sync.upload_interval_s ≤ sync.heartbeat_interval_s`. PROD §8.3 promises that thresholds are validated so a healthy phone never trips them. The property test (ADV-AL05) found two settings that broke that promise, though each passed the existing rules:
  - a stationary interval shorter than the moving interval made a healthy moving phone look stale;
  - an upload interval longer than the heartbeat made it look offline between uploads.
- **The geofence evaluator runs with each sync batch,** in the same transaction, after the points are stored, rather than as a separate outbox worker. Evaluation is immediate and adds no new moving parts. A failure is caught and the batch still commits; the watermark doesn't move, so the next batch evaluates the same points again.
- **Late data (PROD §8.4).** A departure and its return that arrive in the same delivery (an offline backlog) are recorded as shift events marked `detectedAfterSync`, with no live alert. If the backlog ends with the guard still outside, the alert opens and is marked `detected_late`.
- **Condition alerts and the people who close them.** Detectors re-check conditions every 60 s. If a person resolves or dismisses a condition alert while the condition still holds, it stays closed for that episode. The episode starts at:
  - DEVICE_OFFLINE: the last contact;
  - LOCATION_STALE: the last fix;
  - TRACKING_DISABLED and LOW_BATTERY: the last good device report;
  - SHIFT_NOT_STARTED: the scheduled start;
  - SHIFT_OVERRUN: the scheduled end.

  A new episode raises a new alert.
- **Reopening within the suppression window** (PROD §12.3) restores ACKNOWLEDGED if the alert had been acknowledged, so a flapping condition doesn't keep re-alarming a dispatcher who is already on it.
- **"Two consecutive detector runs" for LOCATION_STALE** means the fix was already older than the threshold one run interval ago (age > threshold + 60 s). It is stateless, and the same as two runs when the worker runs every minute.
- **Freshness alerts resolve on the next detector run** (within 60 s), not in the sync request that restores contact.
- **"In contact" for LOCATION_STALE** means heard from within `freshness.offline_after_s` (5 min), the point where the dashboard already shows the phone OFFLINE. Running the demo showed that a phone that simply went silent got "Location stale" at 8 minutes, before "Device offline" at 10. A silent phone is an offline matter; stale is for a phone that keeps reporting but has no fresh fix.
- **New error code `ALERT_INVALID_TRANSITION` (409),** added to ARCH Appendix B. It covers resolving or dismissing an alert that is already closed, and dismissing an SOS or critical incident.
- **Alert actors reference `users`,** as `audit_logs` and `shift_events` do. A manual resolve also records the acknowledgement if nobody had acknowledged.
- **Sync, from the guard-app build's findings:**
  - When a SHIFT_START is quarantined, that shift's later points and end get RETRY, in the same batch and in later ones, until the start is replayed. Otherwise they would be judged against a shift that hasn't started, and lost. The phone treats QUARANTINED as final, so the hold has to persist on the server.
  - The sync reply lists every shift the batch mentions, heartbeats and device reports included, so the phone always learns the server's state (ARCH §8.8).
- **Mock locations and implausible jumps** open SUSPICIOUS_LOCATION (MEDIUM, never auto-resolves). One alert per shift; repeats count on it.
- **Not built in Phase 5:** web push, push to guards, the escalation ladder and notification deliveries (Phase 8, with SOS); CHECKPOINT_MISSED (Phase 7); INCIDENT_* (Phase 8); DEVICE_CHANGED.

## Phase 4 completion · agent-decided 2026-10-08 (round 6 delegation)

- **A replaced phone drains, it doesn't stay signed in (ARCH §5.4).** When a different phone is enrolled, the old phone's sessions are kept, but:
  - for 72 hours it may call only `POST /sync/batch`;
  - only items captured before the replacement are accepted;
  - it may refresh while it drains.

  A re-enrollment on the same phone still revokes its old sessions, and LOST, COMPROMISED and ADMIN still end everything at once.
- **Attendance report:**
  - a shift counts on the local date it was scheduled to start (the site's time zone for a one-site report, the organization's otherwise);
  - figures are empty, not zero, until a shift has started or ended;
  - the CSV is built in the request, because it holds no coordinates and is small. Only exports with location run in the background (PROD §15.2);
  - it needs `exports.create`, and is audited as `EXPORT_REQUESTED`.
- **Coordinates in responses are tagged** (`GUARD_LOCATION` or `SITE_GEOMETRY` in the contract), so the ADV-X05 meta-test can tell a guard's position, which is personal data, from a site's boundary, which is configuration. An untagged coordinate fails CI.
- **Phase status.** `status.json` stays at Phase 3. Phase 4's exit includes human device tests on the pilot's phones, ADV-O05 among them, and claiming the phase complete before they run would be false. Counting Phases 4 and 5 as due, the traceability check passes except for ADV-O05.

## Infrastructure · agent-decided 2026-10-09

The first cell, in Terraform (`infra/`), following ARCH §19.8. The choices the spec left open:

- **A test environment on the Free plan first (owner's choice, 2026-10-09).** The owner keeps the AWS account on the Free plan, with its $100 credit, until production. A smaller `test` environment runs there: the same module with the standby database, the backup copy and WAF switched off, at about $70 a month. It is for test data and device tests only, **never real guards**: when the credit runs out, or after six months, AWS suspends the whole account immediately. Before the first real guard, the owner moves to the Paid plan and `production` is built in its own account. The Free plan rules out AWS Organizations (joining one forces the Paid plan), so the owner signs in as an IAM user with MFA, and the CLI uses `aws login`: browser sign-in, temporary credentials, no access keys.
- **The first account is of AWS's simplified type** (AWS's "new experience", in limited release; found 2026-10-09). AWS manages its organization policies:
  - they allow only Sydney (ap-southeast-2, chosen from the Pakistan contact address), and block GuardDuty and IAM OIDC providers;
  - IAM users can't sign in to the console.

  So the test environment runs in Sydney, without GuardDuty, and CodeBuild builds the server image inside the account instead of GitHub CI. It holds test data only, so the EU residency rule for real data (D-13) is not affected. The CLI signs in with `aws login`, as the owner's AWS Builder ID session; Terraform uses it through a `credential_process` profile. Production needs the Paid plan plus AWS's "activate advanced features", which is irreversible and unlocks Frankfurt and every service. The other route is a new account through "Sign up for AWS (advanced)".
- **No domain until production (owner's choice).** Without a domain the test environment's address comes from CloudFront (`https://<id>.cloudfront.net`, AWS's certificate). The load balancer is internal, reached through a CloudFront VPC origin inside AWS's network. The domain is required before the first real guard, because the guard app has the server address built in. While on the Free plan it is bought outside AWS: Free-plan accounts reportedly can't register domains, and AWS credits never pay for them.

- **Accounts (production).** An AWS Organization with one member account, `sentry-production`; a staging account later, when changes need testing against real infrastructure. The owner signs in through IAM Identity Center with MFA; the root user has MFA and no access keys.
- **No NAT gateway.** The service tasks sit in public subnets with public addresses, and their security groups accept traffic only from the load balancer. The database is in private subnets with no route to the internet. This saves about $35 a month plus data charges. Revisit (private subnets with NAT or VPC endpoints) when traffic grows.
- **One image for every service,** built on GitHub's Arm runners after `pnpm verify` passes on `main`. It is pushed with a GitHub OIDC role that can only push images, and only from `main`. The repository is public, so pull requests from forks must never match: their tokens name `refs/pull/…`.
- **Releases are deliberate** (`infra/scripts/release.sh <environment> <commit>`): the migrations run first as a one-off task, and the services move only if they succeed. The released tags are committed in `infra/terraform/env/<environment>.release.tfvars`, so the repository says what each environment runs.
- **Cognito sign-up.** People may create their own account, with a verified email and authenticator-app MFA required for everyone. An account alone grants nothing: access comes only from an invitation, which the API accepts only from the verified email it was sent to. Until there is an email domain (EXT-15), Cognito sends from its default address, limited to 50 emails a day.
- **WAF:** AWS's IP-reputation, common and known-bad-inputs rule sets. The common set's rule against request bodies over 8 KB only counts, because sync batches can be up to 2 MB. There is no per-IP rate rule: many guards share one mobile-carrier address, and the API limits guards by device instead (SEC §9).
- **Database:** `db.t4g.micro`, Multi-AZ, for Pilot 0 (about 50 guards); raise it before the 1,000-guard rollout. RDS manages its administrator password; the four role passwords are generated by Terraform and kept in Secrets Manager. Connections verify the server against the RDS certificate authorities shipped in the image.
- **No file bucket yet.** Nothing stores files until incidents (Phase 8).
- **Personal values stay out of the repository.** It is public, so the alerts email goes in a git-ignored `local.auto.tfvars`.
- **Found while preparing the setup:**
  - The role setup would have failed on RDS: only a true superuser may name SUPERUSER or BYPASSRLS in `ALTER ROLE`, even to clear them. It now sets them only when run as a superuser, and always checks afterwards that no role has them. A test runs it as an RDS-like administrator.
  - The server announced disclosure version `2026-10-08`, but the guard app ships version `1` and can only record acceptance of text it showed. A real phone could never have started tracking. The version is now one shared constant, and a guard-app test fails if a build doesn't ship it.
- **Found while creating the test environment:**
  - The Free plan refuses an RDS backup retention of 35 days (`FreeTierRestrictionError`). The test environment keeps 1 day, which is enough for test data; production keeps 35.
  - A CloudFront VPC origin isn't admitted by a security-group rule for the VPC's own address range. The load balancer must admit CloudFront's managed prefix list, or its service-managed security group (`CloudFront-VPCOrigins-Service-SG`). We use the group, which is the stricter option.
  - The operator CLI prints the owner's invitation link, so the operator script deletes that task's log stream once it has shown the output (SEC §15: logs never keep tokens).

## Index

| ID | Decision | Status |
|---|---|---|
| D-01 | The identity provider serves dashboard users only; provider Amazon Cognito over OIDC | APPROVED (scope); provider DECIDED under delegation, round 6 |
| D-07 | Background location: `expo-location` for the pilot build; Phase 0B evidence decides | DECIDED under delegation, round 6 |
| D-11 | PostgreSQL only for jobs, pub/sub and rate limits | DECIDED under delegation, round 6 |
| D-38 | Site boundaries: circle or drawn polygon | DECIDED under delegation, round 6 |
| D-02 | Guard sign-in: the invitation SMS enrolls the phone; popups afterwards | APPROVED |
| D-04 | Control room and duty officers both use the web dashboard | APPROVED; revised in round 4 |
| D-05 | One device per guard: the guard's own phone | APPROVED |
| D-08 | SMS in V1 | APPROVED |
| D-09 | SSE, keeping the replay buffer and per-organization sequence | APPROVED |
| D-10 | Kysely, plain SQL migrations, generated types | APPROVED |
| D-12 | Map provider: MapLibre GL with OpenFreeMap tiles (was Google Maps) | REVISED under delegation, round 6 |
| D-16 | Patrol runs per shift, not shared per site | APPROVED 2026-11-02 (owner) |
| D-17 | QR-only scans count, always labelled; an organization may turn this off | APPROVED 2026-11-02 (owner) |
| D-18 | Incident photos from the gallery allowed, labelled | APPROVED 2026-11-02 (owner) |
| D-26 | Direct Firebase push for the guard app; Web Push for the dashboard | APPROVED 2026-11-02 (owner) |
| D-21 | Reason for viewing location history: always asked, optional unless the organization requires it | APPROVED 2026-11-01 (owner) |
| D-24 | Checkpoint position by map pin in V1; on-site calibration in V1.1 | APPROVED 2026-11-02 (owner) |
| D-22 | Guard sees own location trail in the app | REJECTED 2026-11-01 (owner) |
| D-13 | Data residency: cells, launching with one | APPROVED; first cell in D-37 |
| D-14 | English and Urdu only, English by default; English dashboard in V1 | APPROVED |
| D-30 | Our own device-bound mobile session | APPROVED |
| D-31 | Moving a guard to a new phone needs a code from the dashboard | APPROVED |
| D-32 | Realtime reconnection by snapshot only | REJECTED |
| D-33 | RLS: ENABLE plus a startup role check, instead of FORCE | APPROVED |
| D-34 | Pilot 0 once tracking is proven, rolled out in stages | APPROVED |
| D-35 | Foreground-only tracking | REJECTED |
| D-36 | Tracking health shown separately from location age | APPROVED |
| D-37 | First cell on AWS in Frankfurt, backups in Ireland | DECIDED (delegated); confirmed in round 4 over Supabase and Firebase |
| — | Review A-04: drop the outbox table | REJECTED |
| — | Review A-06: evaluate geofences inside the ingest transaction | REJECTED |
| — | Review C-01–C-13 and the remaining A, M and P items | APPROVED ("apply all") |
| — | Phase 0 engineering choices (toolchain, test database, dependency exceptions) | Agent-decided 2026-10-08; veto in the diff |
| — | Phase 6 choices (stream client, event enrichment, revalidation, coverage, history thinning) | Agent-decided 2026-11-01; veto in the diff |
| — | Phase 7 choices (scans through sync, verification order, run windows and changes, closing grace, late scans) | Agent-decided 2026-11-02; veto in the diff |
| Q-22 | A replaced checkpoint label says "Old QR code — report to supervisor" | APPROVED 2026-11-02 (owner) |
| — | Phase 8 gaps: members' SOS numbers, incident location, drill participants, a second SOS press | APPROVED 2026-11-02 (owner) |
| — | Phase 9 gaps: operational records, positions on records, who downloads exports | APPROVED 2026-11-02 (owner) |

---

## D-01 · Identity provider · APPROVED (scope) 2026-10-08

The identity provider serves dashboard users only, because guards enroll per D-02. Dashboard users sign in with email, plus MFA through an authenticator app or a passkey, so no SMS is needed.

The recommended provider is Clerk. That choice is not yet decided: confirm its MFA options on the chosen plan before Phase 1.

## D-02 · Guard sign-in · APPROVED 2026-10-08

**Decision.** The invitation SMS is the only SMS a guard normally receives. It contains an install link and an enrollment code.

1. On Android, the Play install referrer carries the code through installation (to verify in Phase 2). On iOS, the guard opens the link again or types the code.
2. Redeeming the code binds the guard's own phone to our device-bound session (D-30).
3. There is no password and no code at sign-in or at each shift.
4. Later confirmations arrive as in-app or push popups.
5. A new phone needs a new code (D-31).

**Security.**

- Codes are single-use, stored hashed and valid for 7 days.
- Each code is bound to the organization, the guard and the phone number.
- Redemption attempts are rate-limited (SEC §5, §9).

**Limit.** This proves possession of the enrolled phone, not who is holding it. Patrol scans and duty-officer visits are the counter-measures; biometrics are out of scope.

## D-04 · How supervisors receive alerts · APPROVED 2026-10-08, revised in round 4

**Decision (round 4).** The control room and the duty officers both use the web dashboard; duty officers use it on their phones. There is no supervisor mode in the native app, which is now for guards only. This supersedes the first version of the decision, which put a supervisor mode in the app for duty officers.

**Consequences.**

- The dashboard must work well on a phone browser: live map, alerts, SOS acknowledgement and guard detail (PROD §14.7). It installs to the home screen and receives web push.
- The mobile app gets simpler: one role, one store-review story, no Critical Alerts entitlement (EXT-07) and no full-screen-intent question (EXT-35).
- Duty officers are not tracked.

**SOS reach (agent-decided; veto if you disagree).** SOS falls under the STOP protocol, so this needs your eye. Web push and SMS both follow a phone's silent and Do Not Disturb settings, and neither can force a sound; a native app's alarm channel could. To compensate:

- SOS sends an SMS to Supervisors, the duty officers, at 0 s instead of 60 s, alongside the dashboard alarm and web push (PROD §11.4).
- The control room's dashboard, which is staffed, is the primary receiver, and monitoring coverage warns when nobody is connected.
- If pilot data shows duty officers acknowledging SOS too slowly, a native alarm for them is the next step. It is not in V1.

## D-05 · Devices per guard · APPROVED 2026-10-08

Each guard uses their own phone, with one ACTIVE device per guard. Shared phones and site phones are out of V1.

The outbox stays partitioned by user as a safeguard, because a guard can still lend their phone. Personal phones raise the stakes on privacy, on mobile data (guards probably pay for it, Q-14) and on permissions.

## D-08 · SMS in V1 · APPROVED 2026-10-08

This follows from D-02 and D-04. SMS carries:

- guard invitations;
- new-phone codes;
- SOS escalation.

It goes through a Pakistani aggregator with sender-ID registration (EXT-10). Non-SOS SMS counts toward the organization's monthly cap.

## D-09 · Realtime transport · APPROVED 2026-10-08

The transport is SSE. The owner chose to keep the replay buffer and the per-organization sequence ("keep initially").

To make that design correct, the single outbox dispatcher assigns the sequence after commit (ARCH §14). If the sequence were assigned inside the business transaction, transactions committing out of order would let a reconnecting client skip events. The replay buffer lives in the `realtime_events` table, so any API instance can replay it.

## D-10 · Database access and migrations · APPROVED 2026-10-08 (via "apply all", review A-08)

The stack is Kysely, plain SQL migration files and `kysely-codegen` types. UUIDv7 IDs are generated in the API.

## D-12 · Map provider · APPROVED 2026-10-08

**Decision.** Google Maps Platform, for the dashboard's live map, for placing sites (with satellite view) and for location history. This is the owner's preference, and it fits the "quality first" guidance.

- Use current APIs only: Advanced Markers with clustering, never the deprecated `Marker`. This is the "discontinued third-party API" lesson.
- Browser keys are restricted by referrer and API, with quotas and budget alerts on (EXT-13).
- Before Phase 2, confirm the pricing at expected dashboard usage and the terms on storing geocoding results.
- The live map must stay smooth with 1,000 guards spread across a very large colony, including on duty officers' phones. That means clustering, filters by site, and a performance test with 1,000 markers in Phase 6.

## D-13 · Data residency · APPROVED 2026-10-08

**Decision.** Cells, launching with one.

- Each cell is one complete deployment per data region, with its own database, files, API and workers.
- Each organization lives in exactly one cell, chosen when it is provisioned.
- A second cell is a deployment, not a rewrite.
- Cells use only portable building blocks: containers, PostgreSQL and S3-compatible storage (ARCH §1.1). That keeps a Pakistan-hosted cell possible on a local provider.
- Moving an organization between cells is not offered in V1.

**What the promise covers.** The cell's database, files and backups stay in the region. These providers still process limited data abroad:

- the identity provider: dashboard users' names and emails;
- push notifications: device tokens and lock-screen text;
- maps: tile and geocoding requests;
- error tracking: scrubbed error reports.

SMS stays in Pakistan through a local aggregator. The legal review (EXT-17) confirms the wording.

**Evidence for the first cell's region (checked 2026-10-08):**

| Option | What it means | Finding |
|---|---|---|
| Pakistan, on a hyperscaler | — | Not possible. None of AWS, Azure, Google, Oracle, Alibaba or Huawei has a cloud region in Pakistan, live or announced. |
| Pakistan, on a local provider | QCloud (PTCL / DETASAD / iVolve) | The only provider found that claims managed PostgreSQL (14–17) with 35-day point-in-time recovery, plus S3-compatible storage and Kubernetes. These are vendor claims. Before relying on it, test a real restore and confirm the `btree_gist`, `citext` and `pgcrypto` extensions. |
| Gulf | UAE, Bahrain, Qatar | Lowest latency (Karachi→Dubai about 21 ms). War risk is real: in September 2026 AWS reported that some data held only in Bahrain is unrecoverable, and one UAE zone was still inaccessible. |
| Europe | Frankfurt | About 120 ms from Karachi, which is fine for this product: batched uploads, and SSE well inside the 2 s SOS target. |
| India | Mumbai | About 250 ms from Karachi. |

**Law.** No law found in force requires a private company's employee location data to be stored in Pakistan:

- the Cloud First Policy binds federal public-sector bodies;
- the Personal Data Protection Bill is still a draft;
- State Bank and PTA rules bind banks and telecoms.

In-country storage could become necessary if the bill is enacted, or if a public-sector, bank or telecom client imposes it by contract.

**First cell:** AWS in Frankfurt, with backups in Ireland (D-37). The owner accepts that some data passes through providers abroad (round 3). A Pakistan cell is added for the first client who requires in-country storage; QCloud is its candidate, after a real point-in-time restore test and an extension check.

## D-14 · Launch languages · APPROVED 2026-10-08 (via "apply all", review P-04)

- **Guard app:** English and Urdu from the first screen, with direction-aware layouts and Noto Nastaliq tested on low-end phones in Phase 2.
- **Dashboard:** English only in V1, but i18n-ready.
- **No other languages** (round 3). English is the default; a guard picks Urdu on first launch or later in settings.

## D-30 · Our own device-bound mobile session · APPROVED 2026-10-08

- **Key pair:** created in Keystore / Secure Enclave at enrollment; it never leaves the phone.
- **Tokens:** short-lived access tokens, and refresh tokens that rotate on every use and are stored hashed. Presenting an already-rotated refresh token revokes the whole session.
- **Sync engine:** refreshes without any provider SDK.
- **SOS fallback:** an SOS signed with the device key is accepted even when the session has expired (INV-15).

## D-31 · A new phone needs a code from the dashboard · APPROVED 2026-10-08

Supervisors, Administrators and Owners can issue the code, so a phone that breaks at night doesn't wait for an administrator. An SMS to the guard's number alone never moves the account, because numbers get recycled. `DEVICE_CHANGED` (LOW) opens.

## D-32 · Realtime reconnection by snapshot only · REJECTED 2026-10-08

The owner kept the replay buffer and per-organization sequence. The ordering gap that motivated the proposal is closed instead by assigning the sequence after commit (see D-09).

## D-33 · RLS: ENABLE plus a startup role check · APPROVED 2026-10-08

- **Mode:** RLS is enabled, not forced, on every tenant table. Policies read the context through `NULLIF(current_setting('app.org_id', true), '')`.
- **Startup check:** the API and workers refuse to start unless connected as a runtime role without `BYPASSRLS` that owns no tables (ADV-X07).
- **Why not FORCE:** forcing would make data migrations run by the table owner silently match zero rows.

## D-34 · Pilot 0 · APPROVED 2026-10-08

- **Who and where:** an Android pilot with the lined-up customer.
- **When:** only once tracking is proven, meaning the Phase 4 exit tests pass and the device-matrix subset runs on the customer's guards' own phones (the ARCH §21.4 gate).
- **What it includes:** a minimal live view showing tracking health and location age, plus the attendance report.
- **Rollout (round 3):** the pilot organization has about 1,000 guards. It starts with a few sites (about 50 guards) and extends to the rest once that stage meets the tracking-reliability gate (ARCH §21.4). Problems that only show up on certain phones then surface while they affect 50 people, not 1,000.
- **SOS:** no SOS button until Phase 8's exit criteria pass end to end.

## D-35 · Foreground-only tracking · REJECTED 2026-10-08

**Owner's reason:** "fundamentally mismatched with a professional guard-monitoring product".

**Consequences:**

- The app keeps requesting "Allow all the time" (PROD §7.3–§7.4).
- The Play background-location review (EXT-05) stays on the critical path, so the first submission goes in at the end of Phase 4.
- The declaration must justify why a foreground service started by the guard is not enough. The justification is automatic resumption after a reboot or an OS kill during a shift.
- If Play refuses, the fallback is tap-to-resume tracking without the permission, so the tracking code must keep working without it (ARCH §8.2).

**For the record:** under the rejected option, tracking still ran for the whole shift in the background with the screen off. The only difference was the automatic restart after a reboot or OS kill.

## D-36 · Tracking health shown separately from location · APPROVED 2026-10-08 (owner addition)

**The three signals.** For each guard the product shows them separately, never merged (PROD §8.3):

| Signal | States |
|---|---|
| Tracking health (when the server last heard from the phone) | LIVE ≤ 90 s · DELAYED up to 5 min · OFFLINE beyond |
| Location age (the newest usable fix) | CURRENT ≤ 150 s · LAST KNOWN · UNKNOWN |
| Device report | Tracking service state, GPS accuracy, battery and last server acknowledgement, each with its age |

**Rules.**

- A last-known location is never presented as live (INV-09, ADV-U04).
- The `DEVICE_OFFLINE` alert waits for 10 minutes without contact, so brief coverage gaps don't page anyone.
- All thresholds are settings validated against the sampling settings, which fixes review C-01.

## Review A-04 and A-06 · REJECTED 2026-10-08

- **A-04:** the outbox table stays.
- **A-06:** the async geofence worker stays, because geofencing is core.

## Review corrections and remaining items · APPROVED 2026-10-08 ("apply all")

- **Applied as written:** C-01–C-13, A-03, A-07–A-11, M-01, M-03–M-09, P-02 and P-04–P-06.
- **Two adjustments:**
  - **C-01:** its thresholds are folded into D-36's model. The validation formulas are kept.
  - **C-03:** the default heartbeat stays at 60 s (provisional), because tracking health depends on it. Phase 0B measures battery and data at 60, 120 and 180 s and sets the final default. Heartbeats wake on location callbacks, never on a held wake lock.
- **Additions found during Revision 3:**
  - backups are copied to a second region (ARCH §19.6);
  - Apple's privacy-manifest "required reason" APIs are declared for `mono_ms` and `boot_id` (ARCH §8.2);
  - Play's monitoring-tool declaration is added (EXT-20);
  - SOS is worded as an alert to the company's control room, per Apple guideline 5.1.5 (EXT-21).

## D-37 · Cloud provider for the first cell · DECIDED 2026-10-08 (delegated)

**Owner input:** "The data can live in any cloud service … I would like it to be secure." Quality first, but save money where possible.

**Decision.** AWS:

- the first cell in eu-central-1 (Frankfurt);
- database backups and files replicated to eu-west-1 (Ireland);
- ECS on Fargate behind an Application Load Balancer for the API, SSE and workers;
- RDS for PostgreSQL with Multi-AZ and 35-day point-in-time recovery;
- S3, KMS and Secrets Manager.

**Why AWS.**

- Its security tooling is the most mature: accounts, IAM, KMS, CloudTrail, GuardDuty and WAF.
- It meets every requirement natively: the PostgreSQL extensions, point-in-time recovery, cross-region backups, direct connections for LISTEN/NOTIFY, and long-lived containers.
- It needs only the portable building blocks of ARCH §1.1, so a Pakistan cell remains possible.

**Why Frankfurt.**

- About 120 ms from Karachi, which is fine for this product.
- Outside the Gulf, where war damage made some cloud data unrecoverable in 2026.

**Alternatives compared (round 4).**

| Option | Verdict |
|---|---|
| **AWS (kept)** | Hosts everything this design needs in one place: the database, files, and the long-lived API, live-update (SSE) and background-worker processes. It has the strongest security controls: the database sits inside a private network, with KMS encryption, a role per service, CloudTrail, GuardDuty and a web firewall. Costs a few hundred USD a month at pilot scale; Phase 0 costs it properly. |
| Supabase | Managed PostgreSQL and file storage, running on AWS itself, and it fits the RLS design. But the API, SSE and background workers need long-lived processes that Supabase doesn't host, so a second provider would be needed. Its database is reachable over the internet (IP allow-lists help) rather than only from a private network, and cross-region backups aren't built in. Its extras (auto-generated API, Supabase Auth, Supabase Realtime) would go unused. |
| Firebase | A document database with serverless functions. It has no foreign keys, no exclusion constraints, no multi-table transactions and no SQL reporting, which the invariants (INV-04, INV-05, INV-13, INV-14) and the reports depend on. Using it would mean redesigning the product and paying per document read. Only its push service (FCM) is used, for the guard app. |

**Security baseline:** ARCH §19.8.

**Cost controls:**

- Arm (Graviton) instance types;
- a smaller staging environment;
- Savings Plans once usage is stable;
- a monthly bill review.

The legal review (EXT-17) confirms there is no issue with hosting the data in the EU. The owner can veto this choice; nothing has been provisioned yet.

## Pilot scale · consequences · agent-decided 2026-10-08

A 1,000-guard pilot broke three limits that were set for small organizations. All three changes are in Revision 3; veto any of them in the diff.

- **Bulk guard import** from CSV, with a validation preview (PROD §4.2, ARCH §15.3, Phase 2). Creating 1,000 guards one at a time is impractical.
- **Invitation limit** raised from 100 to 1,000 per organization per day (SEC §9). At 100 a day, onboarding would take 10 days. Guard invitations now go only to +92 numbers unless the operator allows another country, which limits SMS abuse.
- **Monthly non-SOS SMS cap** raised from 1,000 to 3,000 (PROD Appendix B). Onboarding alone needs about 1,000–1,500 SMS in the first month. SOS SMS is still never capped.

Also scaled to match: the dashboard snapshot target is now 1,000 active guards in one organization (ARCH §18.3). The load test now includes a 1,000-guard organization and a 1,000-device reconnection storm (ARCH §21.2).

**The pilot site (round 4).** The pilot organization guards one very large housing colony, about 312,000–313,000 kanals.

- At the standard kanal (5,445 sq ft, about 506 m²), that is about 39,000 acres, or 158 km².
- The 331 km² figure mentioned with it would be about 82,000 acres, so one of the two numbers needs checking (Q-19).
- Either way, the colony is far bigger than one geofence circle: the maximum radius of 5 km covers about 79 km². So it is modelled as many sites (posts, gates, sectors) that share the same client.
- How guards are deployed decides the site design (Q-18).

**Deployment (round 5).** There are both stationed guards and roaming patrols. The default design, to confirm by Phase 2:

- each fixed post or gate is a site with a small circle (50–300 m);
- each patrol beat is a site with a larger circle (up to 5 km radius);
- drawn boundaries (polygon geofences, out of scope today) are added only if beats don't fit circles (Q-18).

Phase 0B tests both profiles: a phone standing still at a post, and a moving patrol on foot, motorbike or vehicle, whose battery and data use is higher.

## Guards pay for their own mobile data · 2026-10-08

The 5 MB per 12-hour shift budget, excluding photos, is a hard limit (ARCH §8.10), not a target. Phase 0B's measurements at 60, 120 and 180 s heartbeats decide the heartbeat default within it.

## Cost guidance · 2026-10-08

Quality first, save where possible. A paid component, such as a commercial background-location library licence (D-07) or the best-quality map provider (D-12), is acceptable when the evidence shows it is better.

## Brand · 2026-10-08

- "SENTRY" is final for now.
- The wordmark was generated with OpenAI's image generator; a vector file exists and goes in `design/brand/`.
- Because the artwork is AI-generated, copyright may not protect it. Registering the trademark is what protects the brand, and a designer's vector redraw strengthens the claim. This is reasoned, not legal advice: include it in the legal review (EXT-17), together with the trademark search for "SENTRY".

## Phase 0 · engineering choices · agent-decided 2026-10-08

Made while building Phase 0 (`docs/phases/phase-0/REPORT.md`). Veto any of them in the diff.

**Toolchain**

- **Node 24 runs TypeScript directly** (built-in type stripping), so the API, packages and scripts have no build step. The cost: only TypeScript syntax that can be erased is allowed (no `enum`, `namespace` or constructor parameter properties), and imports name the `.ts` file. The compiler settings enforce both.
- **TypeScript 6.0, not 7.** The lint tooling (typescript-eslint 8.71) supports TypeScript up to 6.0. Move to 7 when it does.
- **ESLint 10** (the plan said 9; 10 is current), type-aware. Lint enforces spec rules: no wall-clock reads in domain code and services (ARCH §3), SQL only in `packages/db` and repositories (ARCH §4.2), no `dangerouslySetInnerHTML` (SEC §8).
- **pnpm 11 with a flat `node_modules`** (`nodeLinker: hoisted`), because the Expo bundler and Next.js resolve modules reliably that way. Install scripts run only for packages on an explicit list (`allowBuilds`). Today that is only the embedded PostgreSQL binaries, whose install script was read first; it only recreates links inside its own folder.
- **Workspace packages are named `@sentryops/*`** and linked with `workspace:*`, so nothing is fetched from npm under our names. `pnpm verify` fails if any package uses `@sentry/*`, which belongs to Sentry.io.
- **One React version (19.2.3)** for the dashboard and the guard app, the version React Native 0.86 ships with. A workspace override enforces it; without it, an Expo web-rendering package pulled in a second, newer `react-dom`.
- **Exact versions for runtime and native dependencies** (SEC §14), such as `fastify`, `pg`, `next` and `expo`. Build tools keep normal ranges; the lockfile pins everything, and CI installs with `--frozen-lockfile`.
- **`next-env.d.ts` is not committed.** Next.js rewrites it on every run and says not to commit it. The typecheck runs `next typegen` first, so a fresh clone works.
- **Build-tool telemetry is off in `pnpm verify` and CI** (`NEXT_TELEMETRY_DISABLED`, `EXPO_NO_TELEMETRY`). Usage statistics have no reason to leave CI.

**Database**

- **PostgreSQL 17 everywhere:** locally, in CI and on RDS.
- **A small in-repo migration runner** for plain SQL files, instead of another dependency. Migrations run only as `migrator`. A migration that was already applied and then edited or deleted stops the run (checksums).
- **Tenant context helper:** `app.current_org_id()` returns `nullif(current_setting('app.org_id', true), '')::uuid`. On a reused connection PostgreSQL reports the setting as an empty string rather than unset, which was confirmed on 17.10. Without `nullif` the cast fails with an error; with it, a query without context returns zero rows (ADV-T06). The context is only ever set for one transaction (`set_config(…, true)`).
- **Local tests need no Docker.** They use embedded PostgreSQL 17 (the real server binaries, installed from npm). CI uses the official `postgres:17` image.
- **The embedded server runs in its own process.** Run inside the test runner, its exit hook replaced the runner's exit code, and a run with five failing tests exited as a pass. As a second guard, `pnpm verify` and the negative controls also read the test summary and fail on any "failed" count.

**Guard app**

- **Tool-generated agent files are removed or switched off:**
  - from the Expo template: `AGENTS.md`, a `.claude/settings.json` that switched on an Expo plugin, and the template's `LICENSE`;
  - in Next.js: the `AGENTS.md` that `next dev` writes, switched off with `agentRules: false`.
  The repository's agent rules live in `CLAUDE.md`. The owner, not a dependency, decides what agents are told and which plugins are enabled.
- **Placeholder app identifiers** (`com.example.sentry.guard`) until Q-20 is answered. Store identifiers can't be changed after the first release.

**Permissions**

- **Dispatchers can view shifts** (`shifts.read`). PROD §3.2 has no "view shifts" row. Dispatchers watch the live map and acknowledge alerts, which needs to know who is on duty where. Guards see only their own shifts. To confirm: Q-21.

**Security process**

- **Dependency audit exceptions** (SEC §14). Two High advisories sit in the guard app's build tools: node-forge in the Expo CLI and braces in the Metro bundler. Neither ships in the app, the API or the dashboard, and no fixed version is published yet. Both are allow-listed until 2026-11-07, with reasons, in `security/audit-allowlist.json`. Allow-list entries now need a reason and a review date, and expire at most 90 days after review.
- **Licence allow-list** (SEC §14), in `security/licence-policy.json`. Permissive licences pass: MIT, ISC, Apache-2.0, the BSD family, 0BSD, BlueOak, Unlicense, CC0 and Python-2.0. Three reviewed exceptions are used unmodified and never ship in the guard app:
  - lightningcss (MPL-2.0): Next.js's CSS compiler, build time only;
  - sharp's image binaries (LGPL-3.0 parts): used by Next.js on our servers;
  - caniuse-lite (CC-BY-4.0): browser-support data for build tools.
  Anything else fails until someone reads the terms.
- **API responses carry their own security headers** (SEC §10), because in AWS `/api/*` goes straight to the API. They also send `Cache-Control: no-store` unless a route opts in, since responses hold one user's data.
- **Secret scanning runs in CI only** (gitleaks, the whole history, on every push). Running it locally needs Docker or the gitleaks program, so it is not in `pnpm verify`. SEC §13 also asks for a pre-commit scan; that waits until gitleaks is installed on this machine (an owner decision; see the Phase 0 report).
- **Terraform moves to Phase 1** (`infra/README.md`). It can't be checked without an AWS account.
