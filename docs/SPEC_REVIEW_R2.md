# Spec Revision 2 — implementation review

| | |
|---|---|
| Date | 2026-10-08 |
| Author | Claude Code (implementation agent) |
| Reviewed | `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_AND_INVARIANTS.md` (Revision 2), `docs/FABLE_PREBUILD_AUDIT.md` |
| Status | **Applied in spec Revision 3 (2026-10-08)**, except four items the owner rejected: A-04 (outbox kept), A-05 / D-32 (replay buffer kept, with the sequence assigned after commit), A-06 (async geofence worker kept) and A-12 / D-35 (foreground-only tracking). Details: `docs/DECISIONS.md`. |

Evidence labels:

- **Certain**: follows from the spec's own text or numbers.
- **Reasoned**: engineering judgement, not yet measured.
- **Verify**: a platform or policy fact to confirm. §8 lists what was checked today.

---

## 1. Summary

The specs are strong where it matters most. These are exactly right, and I'm not re-arguing them:

- the honest-state principle;
- invariants backed by mechanisms;
- a real-device spike before committing the mobile stack;
- an external-dependency register.

What I'd change, in order of how costly it would be to find late:

1. **Contradictions that would ship as bugs** (§3).
   - The worst: a guard standing still at their post, which is the normal case, would raise a `LOCATION_STALE` alert about every five minutes.
   - INV-08 has three holes its tests can't see.
   - The data model can't represent one phone shared by the day guard and the night guard.
2. **Two one-way doors the spec leaves implicit** (§4): how phones relate to guards, and who owns the mobile session. Today the identity provider sits on the SOS path.
3. **A failure the sync design doesn't handle** (§4). One bad item can freeze a guard's upload queue forever.
4. **Moving parts that can go** (§4). The outbox table, the realtime replay buffer with its sequence, and the async geofence worker can all be removed without losing a guarantee.
5. **Mechanisms that let an invariant's tests pass while the invariant is broken** (§5). There are two RLS traps, and nothing proves the security tests can fail. This is exactly the class of failure from your previous product.
6. **Sequencing** (§6, §7). No real customer touches the product until Phase 10. The long-lead approvals should start this week, not "in Phase 0".
7. **One external finding changes the plan** (A-12, §8). If tracking only ever starts from the guard's own tap, Android may not need the "Allow all the time" permission at all. That would remove the hardest store review in the register (EXT-05). It is verified in Android's documentation and still needs confirming on real devices.

## 2. Sound as written (not re-litigating)

- Honest operational state (PROD §1.3) and INV-09/10/16 are the product's best idea.
- PostgreSQL as the only infrastructure (RLS, pg-boss, LISTEN/NOTIFY) is right for one founder.
- Location is accepted by capture time against the shift window, not by the shift's current state (SEC §7).
- The server estimates capture time from a monotonic clock (ARCH §8.7).
- Tenancy has layered defences: repository layer, RLS, composite FKs, 404s and the route-registry meta-test.
- QR tokens are opaque and HMAC-indexed, with an honest `LOCATION_UNCONFIRMED` outcome (ARCH §11).
- SOS is never rate-limited and has its own lane, an escalation ladder, drill mode and a synthetic canary.
- Phase 0B runs on real devices, with the tracking library hidden behind `LocationSource`.

---

## 3. Contradictions and impossible numbers

### C-01 · Stationary guards will spam LOCATION_STALE · Certain

**Where:** PROD §8.2–§8.3, §12.1, Appendix B.

**Defaults involved:** stationary fix every 300 s, upload every 60 s, STALE after 300 s, LIVE up to 120 s, reopen suppression 120 s.

**What goes wrong:**

- After each stationary fix, the server's "last fix" age climbs past 300 s for up to a minute before the next fix arrives. The guard flips to STALE, and `LOCATION_STALE` (MEDIUM) opens, then auto-resolves.
- The next cycle comes 5 min later. That is outside the 2-min reopen window, so a **new** alert opens: up to about 12 alerts per guard per hour, all from healthy phones.
- LIVE is reachable only for about 2 min after each fix, so most healthy guards show as RECENT (muted).
- The validation rule "LIVE ≥ 2 × upload interval" ignores how often fixes are *captured*.

**Fix:** replace the rule in PROD §8.3 and Appendix B with these constraints, enforced by the settings validator:

- `freshness.live_max_s ≥ tracking.max_interval_s + sync.upload_interval_s + 30`
- `freshness.stale_after_s ≥ tracking.stationary_fix_interval_s + sync.upload_interval_s + 60`
- `freshness.offline_after_s ≥ 3 × sync.heartbeat_interval_s`

Then:

- Interim defaults: live 150 s, stale 420 s, offline 600 s. Phase 0B sets the final values.
- `LOCATION_STALE` opens only after the condition holds on two consecutive detector runs.
- Add a property test: with any valid settings, a simulated healthy guard (moving or stationary) never opens a freshness alert.

### C-02 · "Moving" and "stationary" are never defined · Certain

**Where:** PROD §8.2, ARCH §8.3.

**What goes wrong:**

- "Moving: at least one point per 60 s" and "Stationary: one fix every 5 min" both require the phone to know which state it is in. The spec never says how.
- The operating system's motion APIs need an extra runtime permission: "Physical activity" on Android 10+, "Motion & Fitness" on iOS. Neither is in PROD §7.3 or the CI permission allow-list.

**Fix:** define stationary from location alone, and record that V1 requests no motion permission.

- *Stationary* means the last fixes stay within max(20 m, accuracy) of each other for 2 min.
- The phone returns to *moving* on the first fix more than 20 m from that point.

### C-03 · A 60-second heartbeat from a still, screen-off phone is not free and may be impossible on iOS · Reasoned / Verify

**Where:** PROD §8.2, ARCH §8.4, §8.10.

**What goes wrong:**

- **Android:** in Doze, plain timers don't fire and exact alarms are restricted (EXT-36). A heartbeat every minute needs a wake-up source: either a location request every 60 s (costs battery) or a wake lock (costs battery and counts against Play's wake-lock vitals).
- **Verified (§8 #5):** since 1 March 2026, Play penalises more than 2 hours of held partial wake locks per day with the screen off. Foreground services are **not** exempt. Wake locks the system holds for location callbacks are exempt. One wake lock held through a shift would therefore make almost every session "excessive". So heartbeats must ride on location callbacks, never on a held wake lock.
- **iOS:** if location updates pause while the phone is stationary, the app is suspended and sends nothing.
- **Data and battery:** a 60 s cadence means 720 HTTPS requests per 12-hour shift. Tokens, headers and TLS re-handshakes after carrier NAT timeouts could bring the heartbeats alone close to the 5 MB budget, and every request wakes the radio.

**Fix:**

- Default heartbeat 120–180 s. OFFLINE stays at 10 min (3 × 180 = 540 s).
- Send heartbeats with uploads whenever there is data.
- Phase 0B measures, **on the server**, heartbeat cadence and delivery latency on each device and OS. The test is 2 h stationary, with the screen off and the app swiped away.
- If iPhones can't heartbeat while still, use a platform-specific offline threshold. Paging supervisors about every stationary iPhone is not acceptable.

### C-04 · INV-08 has three holes the tests can't see · Certain

**Where:** SEC INV-08, ADV-P01, ARCH §6.3.

**What goes wrong:** INV-08 says location captured outside a shift window is never stored (SOS excepted). Three records store coordinates exactly then:

- `checkpoint_visits` with status `NO_ACTIVE_SHIFT`;
- `shift_events` of type `START_REJECTED`, through `payload jsonb`;
- `incidents` with `shift_id NULL`.

ADV-P01 tests only LOCATION items, so every listed test passes while the invariant is broken.

**Fix:**

- Amend INV-08 to read: *"No record stores coordinates captured outside an active shift window or open SOS — including checkpoint scans, start attempts and incidents."*
- Those records keep derived facts only: distance band to the site, accuracy and flags.
- Guards can file incidents only during a shift or an open SOS.
- Add ADV-P05, generated over every item type that carries coordinates (see M-07).

### C-05 · A late-synced offline start is rejected by PROD §6.4 · Certain

**What goes wrong:** PROD §6.4 step 4 says "Shift is SCHEDULED". But §6.3 allows MISSED → ACTIVE when an offline start, captured inside the start window, syncs late. Implemented literally, step 4 drops a legitimate attendance record.

**Fix:** *"4. Shift is SCHEDULED, or MISSED and this start was captured inside the start window."*

### C-06 · A phone shared by two guards cannot be represented · Certain

**Where:** PROD §4.5 and A-03, versus ARCH §6.3 `guard_devices`.

**What goes wrong:**

- `UNIQUE (organization_id, installation_id)` means a phone belongs to exactly one guard, forever.
- On a site phone, every shift change must revoke the other guard's binding. That fires a `DEVICE_CHANGED` alert twice a day per site phone, and restarts the 72-hour REPLACED window each time.

**Fix:** A-02.

### C-07 · Guards can't move between companies · Certain

**What goes wrong:** `guards.user_id` is unique across the whole platform. Guard turnover is high, and a guard terminated at company A can't be added at company B until someone edits A's record.

**Fix:**

- Change the index to `UNIQUE (user_id) WHERE user_id IS NOT NULL AND status <> 'TERMINATED'`.
- Terminating a guard also sets their membership to REMOVED.
- Company B still sees nothing from A; RLS already covers that.

### C-08 · The app reviewer's demo shift is startable for about one hour a day · Certain

**Where:** PROD §17, ARCH §16.2.

**What goes wrong:**

- A shift created daily that covers "now − 1 h to now + 11 h" is startable only until its start deadline (start + 120 min), one hour after it is created. After that it is MISSED.
- A reviewer in another timezone will almost always find a MISSED shift, which is a likely rejection.

**Fix:**

- Run the refresher every 15 min.
- If the reviewer guard has no ACTIVE shift, cancel any unstarted demo shift and create one starting at now − 10 min. Cancelled shifts are excluded from the no-overlap constraint.
- Set the demo organization's `missed_after_minutes` high.
- Give reviewers a sign-in that doesn't need a +92 SMS. Apple's guideline 2.1(a) requires a working demo account, and reviewers can't receive Pakistani OTPs.

### C-09 · `TIMESTAMP_IN_FUTURE` can never happen · Certain

**What goes wrong:** ARCH §8.7 clamps `captured_at ≤ received_at`. That makes three things dead:

- SEC §8's "not later than receipt + 2 min";
- half of ADV-L03;
- the error code itself.

**Fix:**

- Clamp `captured_at` to receipt time.
- Flag `SKEWED_CLOCK` when `recorded_at` is more than 120 s ahead of receipt.
- Delete the error code.

### C-10 · "Supervisors alerted" is shown when the provider accepts the message · Certain

**Where:** PROD §11.3 and ARCH §13.1, against PROD §13 ("Sent never means seen").

**What goes wrong:** NOTIFIED is set when APNs, FCM or the SMS provider accepts a message. Acceptance means queued, not received. A guard in danger then reads "Supervisors alerted". That is the reassuring-UI failure PROD §1.3 forbids.

**Fix:**

- NOTIFIED requires a display receipt. Either a dashboard showed the alarm (`/alerts/:id/seen`), or the supervisor app reported arrival through the iOS Notification Service Extension or the Android FCM handler.
- Provider acceptance becomes a weaker line on the phone: "Alert sent to 4 supervisors".
- This also gives a real SOS delivery metric.

### C-11 · Numbers that disagree · Certain

- **SSE connections:** ARCH §14 targets 500 concurrent connections, but ARCH §21.2 load-tests only 200.
- **Snapshot sizing:** ARCH §18.3 sizes it for 500 active guards, but A-05 says 2,000.

**Fix:** pick one number for each.

### C-12 · Shift notifications need push before push exists · Certain

**What goes wrong:** PROD §6.2, in Phase 3, notifies guards of assignments and sends reminders. Push credentials (EXT-09) and delivery arrive only in Phase 5.

**Fix:** either state that shift notifications ship in Phase 5, or move basic push into Phase 3.

### C-13 · Tracking after an extension made while the phone was offline · Certain gap

**What goes wrong:**

- The phone's failsafe stops tracking at the old deadline (PROD §6.6).
- On reconnect, the server reports the shift ACTIVE with a later end. The spec doesn't say what happens next.
- Android 12+ restricts restarting a location foreground service from the background (Verify).

**Fix:** *"If reconciliation finds the shift ACTIVE with a later end, notify the guard 'Shift extended — tap to resume tracking' and report the gap."*

---

## 4. Architecture changes I recommend

### A-01 · Own the mobile session (proposed D-30) · Reasoned

Today every phone request carries the identity provider's tokens (ARCH §5.3). That has three consequences:

- **SOS depends on the provider at runtime.** If the access token has expired and the provider is down or unreachable, an SOS can't be authenticated. INV-15 exempts SOS from rate limits, version gates and suspension, but not from this.
- **Background uploads** would have to refresh provider tokens from a headless task or a native service. Provider SDKs are built for the foreground UI.
- **Revocation within 60 s** (SEC §5) needs a server-side check on every request anyway.

**Proposal:**

- The provider (or the enrollment code, per D-02) proves who the guard is, once.
- Our API then issues its own device-bound session:
  - a non-exportable key pair created in Android Keystore or the iOS Secure Enclave at enrollment;
  - a rotating refresh token, stored hashed;
  - short-lived access tokens.
- An SOS signed by the device key is accepted even when the session has expired, as long as the device is ACTIVE.
- Dashboard users keep using the provider directly.

**Cost:** code for issuing, rotating and revoking tokens. It is well-trodden and fully testable.

### A-02 · Separate devices from guards (proposed D-31) · Reasoned; depends on Q2

**Model:**

- `devices`: an installation the organization knows about, with platform, model, ownership (PERSONAL or COMPANY), public key and status.
- `device_sessions`: which guard was signed in on which device, and when they signed in and out.
- Constraints: one open session per device, and one per guard.

**Rules:**

- Binding a new device to an existing guard needs a code issued from the dashboard. The guard's first device uses the invitation code.
- Supervisors can also issue codes, so a broken phone at 2 a.m. doesn't need an administrator.
- `DEVICE_CHANGED` fires only when a personal device is replaced.

**Why:** mobile numbers get recycled. "Received an OTP on that number" shouldn't be enough to take over a guard's account on a new phone.

### A-03 · One bad item must not freeze a guard's phone · Certain gap

ARCH §8.6 and §9.3 combine three rules:

- one transaction per batch;
- a whole-batch failure means "retry the same batch";
- the main lane has one batch in flight, in strict order.

**What goes wrong:** an item that triggers a server bug fails its batch every time. The bug could be an unexpected exception, or a constraint violation such as a re-run START colliding with `UNIQUE (shift_id, client_event_id)`. Everything queued behind that item is stuck: points, scans and END. The guard looks offline, and the phone says "Sending…" forever.

**Fix:**

- Process each item inside its own savepoint.
- On an unexpected error, save the raw item to a short-retention, server-side quarantine table and return a distinct per-item result. Then page the operator and let the lane continue.
- Phase 4 ships a replay tool, plus a test that one poisoned item doesn't block the next 500.

### A-04 · Drop the `outbox` table · Reasoned (verify the pg-boss API in Phase 0)

Everything already lives in PostgreSQL, so the state change can be atomic without an outbox:

- pg-boss can enqueue a job on your own transaction's connection.
- `NOTIFY` is delivered only if the transaction commits.

The outbox table and its dispatcher (ARCH §16.1) add a second queue and extra lag without adding a guarantee.

### A-05 · Realtime without a replay buffer or a per-organization sequence (proposed D-32) · Certain

**What goes wrong:** the per-organization event sequence in ARCH §14 has a classic gap. Transactions take sequence numbers in one order and commit in another, so a client can see event 11 before event 10 exists. If it reconnects with `Last-Event-ID: 11`, it silently skips 10.

**Fix:** the snapshot reload already exists for `resync`. Make it the only reconnect path.

- On every connect or reconnect, the client loads `GET /dashboard/snapshot`, then applies events.
- Each event carries the entity's `version`. The client applies an update only if it is newer, so events can arrive in any order, or twice.

**What this removes:** the replay buffer, the sequence, `Last-Event-ID` handling, and the need for a buffer shared across API instances.

### A-06 · Evaluate geofences inside the ingest transaction · Reasoned

Batches already arrive ordered per shift, and the geofence maths takes microseconds. So, inside the ingest transaction:

- lock the `shift_live_state` row;
- run the pure state machine over the new points;
- write events and alerts in the same transaction.

**What this removes:** the evaluator worker, its watermark and its lag.

**What stays:** late, out-of-order points still go through the existing backfill rule (ARCH §9.4). The freshness detector stays periodic, because its job is to notice silence.

### A-07 · Serve the dashboard and API from one origin · Reasoned

Serve `/api/*` from the dashboard's own domain, through one reverse proxy. Then:

- cookie auth works for both REST and SSE;
- there is no CORS allow-list, no cross-site cookie and no stream ticket (ARCH §14, SEC §10);
- CSRF is covered by SameSite=Lax cookies, a required custom header and an Origin check;
- mobile uses bearer tokens (A-01).

### A-08 · Settle D-10 now: Kysely, plain SQL migrations and generated types · Reasoned

- Drizzle is schema-first, which works against "SQL-first migrations with RLS and grants inside them".
- Kysely with plain SQL migration files and `kysely-codegen` fits the spec as written.
- Generate UUIDv7 in the API, so it doesn't matter whether PostgreSQL is 16, 17 or 18.

### A-09 · Derive QR tokens instead of encrypting them · Optional

- Set `token = HMAC(QR_SECRET, checkpoint_id ‖ qr_token_version)`, truncated to 128 bits, and store only its hash.
- Reprinting a label recomputes the token. That removes the ciphertext column, the KMS decrypt path and one key (ARCH §11.1).
- Rotation is still `version + 1`.

### A-10 · Tracking must keep working after Android kills the JavaScript runtime · Reasoned; Phase 0B criterion

**What goes wrong:** if capture is native but the queue or the upload lives in JavaScript, data piles up whenever Android kills the JavaScript context. The dashboard then shows a working phone as offline.

**Fix:**

- Add to the Phase 0B criteria (ARCH §8.1): measure server-side delivery latency and heartbeat cadence after the app is swiped away. Today it measures only capture gaps.
- Expect the native foreground service to own capture, the SQLite queue writes and the upload.

### A-11 · Three dependency choices to make now · Verify

- **QR scanning:** use `expo-camera`. `expo-barcode-scanner` has been removed from the Expo SDK.
- **Invitation links:** use Android App Links and iOS Universal Links on your own domain, with the code as a fallback.
  - Firebase Dynamic Links shut down in 2025.
  - Any link service is the same "discontinued third-party API" risk that hit your previous product.
- **Native modules:** Expo SDK 55 removed the legacy React Native architecture (§8 #8). Every native module, including any background-location library, must support the New Architecture. Make that a Phase 0B pass/fail criterion.

### A-12 · Track without "Allow all the time" (proposed D-35) · Android: verified in docs · iOS: reasoned · confirm both on devices in Phase 0B

**Why it is possible:**

- Tracking in this product always starts from a user action: Start shift, or SOS.
- On Android, location from a foreground service of type `location`, started while the app is on screen, counts as **foreground** access for as long as the service runs, even with the screen off (§8 #10).
- On iOS, location updates started in the foreground continue in the background with "While Using" authorization plus the background mode. iOS shows its blue indicator.

**What the background permission buys:**

- Restarting tracking without the guard, after a reboot or after the OS kills the app.
- Relaunch on iOS through significant-location changes.

On aggressive manufacturer builds the OS rarely restarts a killed app anyway, so this buys less than it seems.

**What it costs:**

- The hardest store review in ARCH §20: EXT-05's declaration and video, with "plan ≥ 2 cycles".
- A trip into system settings that low-literacy guards often fail. On Android 11+, "Allow all the time" can only be granted there.
- Extra App Review scrutiny for "Always" on iOS.

**Proposal:**

- V1 requests foreground location only.
- After a reboot or kill, the phone posts "Shift active — tap to resume tracking" and reports the gap. The spec already plans this fallback in ARCH §8.2.
- In the readiness check, "Allow while using + precise" becomes the blocking item, and `shift.require_background_permission` goes away.
- Phase 0B measures both modes on the matrix devices. If foreground-only tracking dies on some manufacturer's build, revisit.
- The foreground-service declaration and its video (EXT-04) still apply.

---

## 5. Making the invariants mechanical

| ID | Trap or gap | Mechanism |
|---|---|---|
| M-01 | **Empty-string setting** (Certain). Once `SET LOCAL app.org_id` has been used on a pooled connection, `current_setting('app.org_id', true)` returns `''` rather than NULL, and `''::uuid` throws. So "no context → zero rows" (ADV-T06) behaves differently on fresh and reused connections. | Write policies as `NULLIF(current_setting('app.org_id', true), '')::uuid`. Run ADV-T06 on a connection that has already served another tenant. |
| M-02 | **FORCE RLS silently breaks data migrations** (Certain). FORCE applies RLS to the table owner, `migrator`. With no `app.org_id` set, every UPDATE or DELETE in a data migration matches zero rows and still "succeeds". | Proposed D-33: use ENABLE, not FORCE. `app_runtime` never owns a table, so RLS still binds the app. API and workers refuse to start unless connected as `app_runtime`, without BYPASSRLS and owning nothing. That covers the case FORCE was guarding: a mistyped `DATABASE_URL`. This changes the wording in SEC §4.2 and §19, so it needs your approval. |
| M-03 | SEC §19's catalog checks run only at audit time. | A schema linter in CI from Phase 1. A registry classifies every table as tenant, global, internal or append-only. A test fails on any of these: missing `organization_id NOT NULL`; missing RLS or policy; missing `UNIQUE (organization_id, id)`; a non-composite tenant FK; UPDATE or DELETE granted on an append-only table; a table nobody classified. |
| M-04 | Nothing proves the security tests *can* fail (the lesson of the lint step that did nothing). | Negative controls in CI. Each control breaks one thing and must turn its test red: drop RLS on one table (ADV-T06); mount a route without a policy (ADV-A09); plant a lint error (lint); grant UPDATE on an append-only table (grants test). If any control stays green, the build fails. |
| M-05 | Test IDs are a naming convention, not a check. | A script maps every ADV and INV ID to tests by name. It fails if an ID due in a finished phase has no test, or a test cites an unknown ID. REPORT.md embeds the generated table. |
| M-06 | Docs drift (the lesson of thresholds documented differently from the code). | Generate PROD Appendix B (settings), PROD §3.2 (permissions), ARCH Appendix B (error codes) and the ERD from `packages/contracts` and the schema, with a CI drift check. The written spec links to the generated tables instead of restating numbers. |
| M-07 | INV-14 is tested on the history endpoint only. Coordinates also leave through checkpoint visits, incidents, shift start and end records, and reports. | Tag coordinate fields in the contracts. A meta-test fails if a route returns tagged fields without declaring either live-only scope or an audit action. The same tags generate ADV-P05 (C-04). |
| M-08 | INV-15 tests don't cover an expired session or an identity-provider outage. | After A-01, test that SOS is accepted with an expired session and the provider unreachable, and from a REPLACED device inside its grace window. While the database is down, the phone shows "waiting" or "sending", never "received". |
| M-09 | INV-06 is enforced table by table. | A generated test over every offline item type in the contracts. Submitting the same item twice gives one effect and the same result. Resubmitting with altered content keeps the original, returns DUPLICATE and increments the conflict metric. |

---

## 6. Scope and sequence

- **P-01 · Pilot 0 at the end of Phase 4 (proposed D-34).**
  - Add a minimal live view to Phase 4: snapshot polling every 15 s, with honest freshness. Add the attendance report too.
  - Then pilot with one friendly company: Android only, distributed through EAS internal distribution or a Play closed track, 1–3 sites, no SOS.
  - Everything after Phase 4 is then built on real feedback. Today the first real user arrives after Phase 10.
  - Distribution caveat: even Play's internal testing track requires the Permissions Declaration to be completed (§8 #3). A sideloaded APK avoids Play for a small pilot. Either way, expect Play Protect to warn guards that a monitoring app is installed, so onboarding must explain that warning.
- **P-02 · No SOS button for real guards until Phase 8's exit criteria pass end to end, canary included.** An SOS button that might reach nobody is the most dangerous reassuring UI the product could have. Pilot agreements should say so plainly.
- **P-03 · Supervisor mode is a second app inside the guard app.** It needs an alerts feed, acknowledgement, alarm notification channels, Do Not Disturb setup and a test alert.
  - If supervision happens in a control room, it can move to Phase 8.
  - If it's duty officers on the road, it is core (Q3).
- **P-04 · Languages.**
  - Guard app: Urdu and English from its first screen. Layouts follow text direction, and Nastaliq is tested on low-end phones in Phase 2.
  - Dashboard: English-only in V1, but i18n-ready.
  - This roughly halves the right-to-left work (Q7, D-14).
- **P-05 · Manufacturer setup screens** only for the brands in the pilot's device census, not all eight families in PROD §7.3.
- **P-06 · Settings.** Appendix B has about 50 settings, and each one means UI, validation, audit and tests.
  - Expose about 10 in the dashboard: geofence radius, alert routing, SOS contacts and number, the history-reason requirement, and retention.
  - The rest stay operator-set defaults until a customer asks for them.

Proposed changes to the phase plan:

| Phase | Change |
|---|---|
| 0 | Close D-01, D-02, D-05, D-10, D-11, D-13 and D-23, plus the new D-30–D-35. CI gets the schema linter, negative controls, traceability and generated docs from day one. |
| 0B | Measure server-side delivery latency and heartbeat cadence after the app is swiped away, and the heartbeat of a stationary iPhone. Measure battery and data at 60, 120 and 180 s heartbeats. Test on the pilot customer's real phones. |
| 1 | Own mobile session (A-01), and device enrollment codes. |
| 2 | Devices and device sessions (A-02). |
| 3 | Shift notifications move to Phase 5, or basic push moves into Phase 3 (C-12). |
| 4 | Add the minimal live view and attendance report, then run **Pilot 0**. Make the first Play closed-testing submission now. That starts the foreground-service review (EXT-04), plus the background-location review (EXT-05) if A-12 is rejected, early enough to allow at least two rounds. |
| 5–7 | Unchanged, except SSE without a replay buffer (A-05) and possibly moving supervisor mode to Phase 8. |
| 8 | SOS is turned on for pilot guards only after the exit criteria pass. |
| 9–10 | Unchanged. |

---

## 7. Start this week (human tasks with long lead times)

1. **Legal entity.** Then a D-U-N-S number. Then the Apple Developer Program and Google Play Console, both as an **organization**: a new personal Play account must pass a closed-testing gate before it can publish to production (EXT-01–03; see §8).
2. **iOS from Windows.** Android builds run locally. iOS needs EAS cloud builds, a paid Apple Developer membership and registered test iPhones. This gates the iOS half of Phase 0B.
3. **OTP evidence before Phase 1.**
   - Send real OTPs through the candidate identity provider to Jazz, Zong, Telenor and Ufone numbers. Measure the delivery rate and the delay.
   - In parallel, open an account with a local SMS aggregator and start sender-ID registration (EXT-10, EXT-11).
   - Clerk sends SMS only to countries you add to an allowlist (by default the US and Canada), and only on a paid plan. It publishes no Pakistan price, and delivery to +92 numbers is unproven (§8 #1).
   - Plan B: Clerk's `sms.created` webhook lets you send the codes through your own local gateway.
4. **Pilot customer and device census:** phone models, Android versions, who owns each phone, and who pays for the data. This decides which phones Phase 0B tests on.
5. **Name check:** trademark search and App Store name availability for "SENTRY" (see §9).
6. **Start the legal review** (EXT-17): employee monitoring and data protection in Pakistan.

---

## 8. External facts checked today

Checked against official sources on 2026-10-08. Most store-policy pages are undated, so re-check each one when you act on it (ARCH §20).

| # | Question | Finding | What it means for the spec |
|---|---|---|---|
| 1 | Can Clerk send SMS OTP to +92? | Only to countries on the instance's SMS allowlist (default: US and Canada). Production SMS needs a paid plan. Non-US SMS costs "market rate", with no published Pakistan price. Delivery to Pakistan couldn't be verified. Codes can go through your own gateway via the `sms.created` webhook. | D-01 and D-02: test real delivery to Pakistani carriers before Phase 1, and keep the own-gateway path ready (§7 item 3). |
| 2 | Does Play allow employer tracking? | Yes. The stalkerware policy allows "enterprise management for the monitoring of individual employees" if the app is built and marketed only for that. Conditions: the `isMonitoringTool=enterprise_management` flag in every version code on every track; a persistent notification "at all times when the app is running"; a unique icon; monitoring disclosed in the listing. Play Protect warns users that a monitoring app is installed. | Add the flag, plus a CI check for it. Add listing text. Guard onboarding must explain the warning. A human should read whether "at all times when the app is running" means a notification outside shifts too. |
| 3 | Do declarations block the internal testing track? | The Permissions Declaration must be completed if any active bundle needs it, the internal track included. Internal tests "might not be subject to" standard review. Background-location review covers all active tracks. All foreground-service types are reviewed. | A Play-distributed Pilot 0 still needs the declaration filled in. A-12 may remove the background-location part. |
| 4 | Closed-testing gate for new accounts | Personal accounts created after 13 Nov 2023 need 12 testers opted in for 14 continuous days. The rule names personal accounts only. | Use an organization account (§7 item 1). |
| 5 | Play wake-lock vitals | Enforced from 1 Mar 2026. The threshold is more than 2 h of non-exempt partial wake locks per 24 h with the screen off, in more than 5 % of sessions over 28 days. Consequences: possible removal from discovery and a battery warning on the listing. Foreground services are **not** exempt. System wake locks for location callbacks are. | C-03: heartbeats ride on location callbacks. Phase 0B checks how each candidate library uses wake locks. |
| 6 | Target API level | New apps and updates must target API 36 since 31 Aug 2026; an extension to 1 Nov 2026 can be requested. Expo SDK 56 and 57 target 36. | EXT-06: build for API 36 from the Phase 0B spike onwards. |
| 7 | Apple rules | No guideline is specific to employee monitoring. 5.1.5: use location only where directly relevant, and "Location-based APIs shouldn't be used to provide emergency services". 2.1(a): a demo account is required. Unlisted distribution exists; it still goes through App Review and the app must be final. Custom apps now go through "Apple Business", and Apple's feature table shows no "Get Apps" for Pakistan. | SOS copy (in the app, the listing and review notes) must say it alerts the company's control room, never that it is an emergency service. For D-25, plan public or unlisted App Store distribution on iOS, not custom apps. Reviewers need a test sign-in (C-08). |
| 8 | Expo | Latest stable is SDK 57 (React Native 0.86); SDK 58 is in beta. The legacy architecture was removed in SDK 55. | Every native module must support the New Architecture (A-11). |
| 9 | Pakistan data protection law | The Personal Data Protection Bill (May 2023) is still listed as a draft. No record of enactment found. | EXT-17 stays: legal review is still needed, because other laws apply. |
| 10 | Is background location required? | Android documents location from a `location`-type foreground service, started while the app is visible, as *foreground* access. The background permission is needed only to start tracking from the background, for example after a reboot. | A-12. |

Sources:

- Play Console Help articles 9799150, 9888380, 12955211, 9214102, 9845334, 13392821 and 14151465.
- Android Developers: target-SDK and location-permission pages (updated 2026-10-01); Android Developers blog posts of 4 Mar 2026 and 2 Oct 2025.
- Apple: App Review Guidelines (revised 8 Jun 2026), unlisted-distribution page, Apple Business support articles (14 Apr 2026).
- Clerk: docs and pricing.
- Expo: changelogs for SDK 55, 57 and 58.
- Pakistan: moitt.gov.pk and senate.gov.pk bill pages; Express Tribune, 24 Aug 2026.

---

## 9. The name

"Sentry" is also sentry.io, the error-tracking product that ARCH §2 plans to use.

- Never name workspace packages `@sentry/*`. That npm scope belongs to Sentry.io, so names like `@sentry/core` collide with real packages and invite dependency confusion.
- Register an npm scope of your own instead.

---

## 10. Questions for you

> **Update 2026-10-08:** questions 1–6 are answered and recorded in `docs/DECISIONS.md`. Question 12 became D-35. The remaining questions now live in `docs/OPEN_QUESTIONS.md`.

Answers to 1–6 change the architecture, so I need them before Phase 0.

1. **Legal entity.** Is there a registered company yet, and in which country? Who will own the developer accounts?
2. **Phones.** Which of these is it: guards' own phones, one company phone per guard, or a shared phone per site handed over at shift change? (D-05, A-02; a one-way door.)
3. **Supervision.** At your target customers, who supervises: a 24/7 control room watching screens, mobile duty officers doing night rounds, or both? (Decides supervisor mode and SOS escalation.)
4. **Pilot.** Is a first customer lined up? Roughly how many guards and sites? Could they give us a device census?
5. **Data residency.** Do customers, or their own clients (banks, telcos, government sites), require data to be stored in Pakistan? (D-13; a one-way door.)
6. **Guard sign-in.** Is one SMS per sign-in acceptable on cost and delivery? Do customers worry about "buddy punching", where a colleague starts an absent guard's shift? Neither OTP nor a PIN prevents it. (D-02.)

Needed before later phases:

7. **Languages.** Urdu in the guard app only, with an English dashboard in V1? Any regional languages?
8. **iPhones.** What share of guards and supervisors use iPhones? Do you have a Mac and an iPhone for testing?
9. **Pilot without SOS.** Are you comfortable running Pilot 0 with no SOS button?
10. **Name and wordmark.** Is "SENTRY" final? Where did the wordmark come from (font, licence, vector files)? Was it generated by an image tool?
11. **Budget.** What is the monthly ceiling for paid components: background-location library licence, identity provider, SMS, maps, hosting?
12. **Foreground-only tracking (A-12).** Is this trade acceptable: after a reboot or an OS kill the guard must tap "resume tracking", and in return the app never asks for "Allow all the time"? Phase 0B will measure both modes either way.

## 11. Next steps

1. You answer §10, questions 1–6 first.
2. I record the decisions in `docs/DECISIONS.md` and prepare Revision 3 of the three specs as one reviewable git diff.
3. You approve it. Phase 0 then starts with `docs/phases/phase-0/PLAN.md` (ARCH §0.2).
4. Run the Fable pre-build audit on Revision 3 rather than Revision 2, so it doesn't spend its effort re-finding what is fixed here.
