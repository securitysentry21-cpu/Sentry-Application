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

- **Committing.** Yes; commits are local. Commit identity: the repository account's GitHub no-reply address (`339630571+securitysentry21-cpu@users.noreply.github.com`), so neither the owner's name nor their Gmail enters a history that may become public. **Not pushed:** the repository is public, and pushing would publish the code, the threat model and the security design. Make the repository private, then push (or tell me to).
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
