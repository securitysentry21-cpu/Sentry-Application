# Phase 8 — Incidents and SOS · REPORT

| | |
|---|---|
| Date | 2026-11-02 |
| Result | **Built.** `pnpm verify` passes: all 12 checks it runs, and the dependency audit run on its own; 73 test files, 633 tests; 115 IDs cited. Phase 8's exit IDs (ADV-S01–S11, F01–F05, T10) each have a passing test. **SOS stays off for pilot guards** (`FEATURE_SOS=false`) until the checks on real phones pass and the owner approves (ARCH §22). |
| Commit | `e73f688`, pushed 2026-11-02 (with `a14f49f`, two reviewed secret-scan false positives). |
| AWS | Applied 2026-11-02 with Phase 9's, at the owner's go-ahead (under $0.10 a month). Phase 9, which includes Phase 8, was released to the test environment the same day (`8854af8`). `infra/scripts/smoke.sh` passed against real S3, then the environment was paused again. Guard pushes still need the Firebase key. |

## What was built

- **Schema (migration 0010):**
  - `incidents`, numbered per organization (`INC-000123`). The guard's submission can't change: the runtime role may update only status, severity, type and the resolution columns (column grants, INV-05). Check constraints keep coordinates off a report outside a shift or an open SOS (INV-08), and its time no more than 24 hours back;
  - `incident_events` (append-only, notes idempotent) and `incident_attachments`;
  - `sos_events` (one open SOS per guard, idempotent per phone event), `sos_presses` (every press, append-only), `sos_drills` with their guards and members (append-only);
  - `notification_deliveries` (one row per message, with an idempotent key) and `web_push_subscriptions` (per member);
  - a member's SOS number on the membership; the guard phone's push token; `organizations.kind` (customer, demo, canary);
  - `location_points.sos_event_id`: a point belongs to a shift or an SOS, never to neither;
  - `system_worker` may read only the columns its sweeps need (escalations due, deliveries due, photos to check, open SOS).
- **Incidents (PROD §10):**
  - from the phone through the sync queue (`INCIDENT`, and the new `INCIDENT_NOTE`), only during the active shift or an open SOS, judged by capture time. Shift, site and guard come from the server; 20 an hour per guard, then RETRY;
  - from the dashboard (`POST /incidents`, Supervisors and up, no coordinates);
  - list with filters, detail, notes, acknowledge, resolve (note required), reopen (reason required); severity and type changes keep old and new values;
  - `INCIDENT_CRITICAL` escalates like an SOS; `INCIDENT_HIGH` follows its setting; open incidents on the home page;
  - `GET /me/incidents`: the guard's reports of the last two weeks, with their own notes only.
- **Photos (ARCH §12, SEC §12):**
  - up to 5 per report, from the in-app camera or the system photo picker (D-18), each labelled with its source;
  - the phone re-encodes each as a JPEG (≤ 2,048 px), which drops its metadata, and keeps it in app storage until the server has the report;
  - a signed PUT for exactly that type and length, valid 15 minutes, that can't overwrite an existing original (`if-none-match: *`); then `complete` with the SHA-256;
  - the worker checks that it exists, its size, its real type from its bytes, the pixel count before decoding (≤ 40 MP) and the hash, then writes a re-encoded view copy without metadata;
  - a signed GET of the view copy (≤ 5 min); the original only for Owners and Administrators, audited;
  - storage: a private S3 bucket (written with the presigning and request signing checked against AWS's own examples), or a local folder in development and tests.
- **SOS (PROD §11, ARCH §13.1):**
  - `POST /sos` stores the SOS, opens `SOS_ACTIVATED`, queues the first step and answers RECEIVED; nothing is sent inline;
  - never rate-limited; accepted from a suspended organization, an old app version and an expired session. Without a usable session the request is signed with the device key (`X-Device-Signature`, over the raw body, ±5 min), from an ACTIVE phone or a REPLACED one for 72 hours (INV-15);
  - a second press re-triggers the open SOS; after an acknowledgement it makes it unacknowledged again and restarts the ladder (owner decision);
  - SOS positions (`POST /sos/:id/locations`) and "I'm safe" (`POST /sos/:id/cancel-request`), which changes nothing but a note; SOS tracking off shift (INV-08's exception);
  - acknowledge and resolve (type and note) from the dashboard, phones included; the SOS page's history is audited (`SOS_VIEWED`), and a newer position alone arrives live on the stream.
- **Honest states (INV-10):** ALERT_SENT only when a provider accepted a message; NOTIFIED only on a display receipt (`POST /alerts/:id/seen`, from a dashboard showing the alarm in a visible tab) or a delivery receipt (`POST /alerts/:id/delivered`, from the dashboard's service worker after showing the push). The phone shows each state only after the server reports it.
- **Escalation and notifications:**
  - the ladder at 0, 60 and 180 s, then every 120 s until acknowledged, run every 15 s from `escalation_started_at`;
  - deliveries are rows with idempotent keys; the worker sends them every second with retries (SOS: 3 attempts in a minute);
  - one text per recipient per SOS per 60 s; non-SOS texts stop at the monthly cap; outside production only allow-listed numbers;
  - Web Push (RFC 8291 encryption and RFC 8292 VAPID on `node:crypto`, checked against the RFC's worked example), only to real push services; Firebase HTTP v1 for guards (D-26);
  - SMS has no provider until EXT-10: a text is recorded as failed, never as sent;
  - lock-screen-safe words, with no coordinates; links need a sign-in;
  - the guard hears about a new, changed or cancelled shift, a reminder, "SOS acknowledged" and "SOS closed", in their language, once the Firebase project exists.
- **Drills (PROD §11.10):** an Owner or Administrator opens a window naming guards and members; those guards' SOS is a DRILL everywhere and reaches only those members, marked "[DRILL]"; no emergency contact is ever texted for a drill. Demo and canary organizations treat every SOS as a drill.
- **Synthetic canary (ARCH §18.4):** `operator create-canary` makes an internal organization with a simulated phone. The worker then sends a signed SOS through the public address every 5 minutes, checks the alert, the realtime event and an accepted push, and resolves it. Operator alarms watch it.
- **Guard app:**
  - SOS: every state from the server (sent, shown in the control room, reached phones, acknowledged by whom, closed), polled every 5 s; "I'm safe" offline and online; call and SMS fallbacks; a drill banner; SOS tracking every 10 s whatever the shift, and a received SOS that survives the app being killed;
  - incidents: type, severity, optional title, details, when it happened (up to 24 hours back), up to 5 photos from the camera or the gallery; a receipt with the reference and the photos still to upload; "Also send SOS?" for a critical one; reports also during an SOS off shift;
  - "My reports" with status, photos and notes, and a note to add;
  - "Checkpoint problem" on the patrol screen;
  - English and Urdu throughout; phone storage migration 4 (the photo queue).
- **Dashboard** (built by a helper agent from a written brief; reviewed, its gaps fixed here, its checks re-run):
  - the SOS alarm: full screen, a repeating siren until acknowledged, "Enable alarm sound" with a warning while sound is off, a flashing tab title, a background notification; drills alarm only their members;
  - an SOS page; SOS banners and open incidents on the home page;
  - incidents list, detail and "Record incident", photos through signed links, the original for Owners and Administrators;
  - Settings › Notifications: install, subscribe, "Send me a test SOS alert"; the service worker and manifest;
  - members' SOS numbers, drills, SOS settings;
  - everything plain text (ADV-W01).
- **Found reviewing the dashboard, fixed in the server:**
  - a drill alert didn't say which drill it belonged to, so a dashboard opened after the drill window, or in a demo organization, could miss its alarm. Alerts now name their drill, and `GET /sos-drills/:id` says who takes part;
  - each batch of SOS positions made an open SOS page reload its history, writing an audit row every 10 s. Positions now travel live on the stream;
  - `dashboardAlarm: false` in the SOS settings did nothing. The settings now refuse it;
  - two phone-number rules (7–15 and 8–15 digits) are now one.
- **Infrastructure (written, validated, not applied):** the photo bucket and its access (`attachments.tf`); the Web Push key pair, its private half only in the worker's secret; the Firebase secret once it exists; operator alarms by email (`notifications.tf`); a new provider, `hashicorp/tls` 4.4.2, to generate the key pair. `terraform validate` passes.

## Tests by ID

| ID | Test |
|---|---|
| ADV-S01 | `apps/api/test/sos.test.ts`: RECEIVED, ALERT_SENT, NOTIFIED and ACKNOWLEDGED each appear only after their server fact; a push reaching a person's phone makes it NOTIFIED, another person's delivery doesn't. `apps/mobile/test/sos-phase8.test.ts`: the phone shows each state only as the server reports it. `packages/domain/test/sos.test.ts` |
| ADV-S02 | `sos.test.ts`: an SOS sent again after a lost response is stored once and answered the same way. `apps/mobile/test/sos.test.ts`: offline it waits, is never shown as received, and arrives exactly once |
| ADV-S03 | `sos.test.ts`: pressing again re-triggers the open SOS: one SOS, the counter goes up; pressed after an acknowledgement it is unacknowledged again |
| ADV-S04 | `sos.test.ts`: accepted while the phone is rate-limited, below the minimum version, or its organization suspended |
| ADV-S05 | `sos.test.ts`: an SOS off shift is accepted, and only SOS tracking stores its positions; after resolution a later point is refused |
| ADV-S06 | `sos.test.ts`: on a fake clock the ladder steps at 0, 60 and 180 s and repeats every 120 s. `packages/domain/test/sos.test.ts` |
| ADV-S07 | `sos.test.ts`: "I'm safe" leaves the SOS open and escalating. `sos-phase8.test.ts`: offline it waits on the phone and the SOS stays tracked |
| ADV-S08 | `sos.test.ts`: push and SMS providers down: the dashboard alarm still goes out through the stream, a display receipt still notifies, and the operator alarm fires |
| ADV-S09 | `apps/web/test/alarm.test.tsx`: without sound the dashboard warns visibly and the overlay still appears; a browser that can't play sound says so |
| ADV-S10 | `sos.test.ts`: a drill's SOS reaches only its members, marked [DRILL], and names its drill, readable after it ends; another guard's SOS is real; another organization's guard or member is refused; a demo organization's SOS is a drill for its own members. `alarm.test.tsx`: a drill alarms only its members, also in demo organizations. `packages/domain/test/sos.test.ts` |
| ADV-S11 | `sos.test.ts`: after the session expired a signed SOS is accepted, a bad or stale signature is not; a REPLACED phone may send a signed SOS for 72 hours, then not. `apps/mobile/test/device-key.test.ts`, `sos.test.ts`: the phone's signature verifies with `node:crypto`, and goes out when the session can't be renewed |
| ADV-F01 | `apps/api/test/attachments.test.ts`: an executable renamed `.jpg` is rejected by its bytes |
| ADV-F02 | `attachments.test.ts`: an oversize file is refused; a decompression bomb is rejected before it is decoded |
| ADV-F03 | `attachments.test.ts`: a guessed or altered storage link is refused |
| ADV-F04 | `attachments.test.ts`: a link used after it expired is refused |
| ADV-F05 | `attachments.test.ts`: the view copy has no metadata; the original only for Owners and Administrators, audited |
| ADV-T10 | `attachments.test.ts`: another organization's attachment, and another guard's report or photo, are not found; `tenancy.test.ts`: the generated probes over every new `:id` route |
| INV-10 | `alarm.test.tsx`, `apps/web/test/service-worker.test.ts`, `sos-incidents.test.ts`: display receipts only from a visible screen, once; the service worker shows every push, then reports it; the progress shows sent as sent, not notified |
| INV-14 | `apps/api/test/realtime.test.ts`: a newer SOS position arrives live, position-only, with no history read and no audit row |
| — | `sos.test.ts`: the canary end to end (signed SOS, alert, realtime event, accepted push, resolved), and an unreachable address named in its failure; `incidents.test.ts` (API): sync and dashboard reports, notes (the guard reads back only their own), the status flow, changes recorded, rate limits, alerts by severity, ADV-A03, ADV-P05; `attachments.test.ts`: an original can't be replaced through its link; `notifications.test.ts`: the RFC 8291 example, VAPID (also from a PEM key, and the API's public-only half), endpoint allow-list, members' SOS numbers, subscriptions, the test alert, the allow-list, throttles and the monthly cap, shift notices; `storage.test.ts`: AWS's SigV4 examples, the conditional upload, credential renewal; `sync.test.ts`: ADV-X06 over `INCIDENT` and `INCIDENT_NOTE`; `packages/contracts/test`: the alarm can't be configured off, and whoever reads alerts also reads SOS and live positions |
| — | `apps/mobile/test/incidents-phase8.test.ts`: photos wait for their report, upload through their slots and leave the phone; a refused upload is retried; a 412 goes on to complete; a refused report takes its photos with it; reports during an SOS off shift; the 24-hour limit; notes before the server id is known. `sos-phase8.test.ts`: SOS tracking every 10 s off shift and replacing the shift interval during one; a received SOS restored after a kill. `app-config.test.ts`: the photo picker adds no microphone |
| ADV-W01 | `apps/web/test/plain-text.test.tsx`: script payloads in incident, photo, SOS, guard, site and recipient names render as text on the new pages and in the alarm |

## New dependencies (SEC §14)

| Package | Version | Where | Purpose | Licence | Maintenance | Native permissions |
|---|---|---|---|---|---|---|
| `sharp` | 0.35.5 | API | Checks photos (header pixel count before decoding) and writes the re-encoded view copy | Apache-2.0; its libvips binaries LGPL-3.0, an existing exception (`security/licence-policy.json`), reason extended | Lovell Fuller; the standard Node image library, also used by Next.js | n/a (server) |
| `expo-image-picker` | 57.0.20 | guard app | Gallery photos through the system photo picker only (D-18) | MIT | Expo team, SDK 57 | Storage permissions it declares are blocked; no microphone; iOS photo-library and camera texts are ours (`apps/mobile/DEPENDENCIES.md`) |
| `expo-image-manipulator` | 57.0.21 | guard app | Re-encodes every photo before upload | MIT | Expo team, SDK 57 | None |
| `expo-file-system` | 57.0.7 | guard app | Photos in app storage until uploaded; the signed upload | MIT | Expo team, SDK 57 | Storage permissions it declares are blocked |
| `hashicorp/tls` (Terraform) | 4.4.2 | infra | Generates the Web Push key pair | MPL-2.0 (a provider binary run by Terraform; not shipped) | HashiCorp | n/a |

None has an install script, so `allowBuilds` is unchanged.

## Decisions

The owner's (D-18, D-26 and the four SOS and privacy answers) and the agent's are in `docs/DECISIONS.md` under Phase 8. The agent-decided ones to look at first:

- the guard's "My reports" shows only their own notes, not the supervisors';
- an uploaded original can't be replaced, even through its own link;
- the dashboard alarm can't be configured off;
- only the worker holds the Web Push private key.

## Not done

- **SOS for pilot guards.** It stays off (`FEATURE_SOS=false`) until:
  - the exit tests pass on real phones: a person goes through the SOS checklist (silent mode, Do Not Disturb, an expired session, a killed app, a drill);
  - the SMS provider exists (EXT-10);
  - the owner approves (ARCH §22).
- **Pushes to the guard app.** The server side is built and tested with a fake Firebase. The phone's side, its token and notifications, waits for the owner's Firebase project.
- **SMS.** No provider yet (EXT-10). Texts are recorded as failed (`SMS_NOT_CONFIGURED`), never as sent.
- **iOS pushes** (APNs needs the paid Apple account).
- **AWS.** The Terraform waits for the owner's go-ahead. Until it is applied, the test environment can't run a Phase 8 release, since the API refuses to start without the photo bucket. After that: `create-canary`, and the canary settings in `local.auto.tfvars`.
- **Dashboard:**
  - no square app icon for the home-screen install (design open item 4); iPhone install works without one;
  - a browser that rotates its push subscription isn't re-subscribed until the member opens Settings › Notifications again;
  - the strict Content-Security-Policy, when it comes, needs `worker-src 'self'` and the photo bucket in `img-src`.
- **Incident reports and statistics** (Phase 9); photos attached from the dashboard.
- **On real devices** (for a person): the sound, the push and the home-screen install on duty officers' phones; the camera, the gallery picker and photo upload on a guard's phone.
- `status.json` stays at Phase 3 until Phase 4's device tests have run.

## Checked by running it

This ran on the local database: `pnpm db:up` applied migrations 0009 and 0010 to the existing Phase 7 data without trouble. The API dev server, the worker and `pnpm demo` (which now files a report and presses SOS) ran against it, and a script played the control room through the API.

- **The report.** Usman's report arrived as `INC-000001`. Its photo:
  - went up through its signed link and completed with its hash;
  - was checked by the photo job and marked AVAILABLE;
  - its view copy came back through a fresh 5-minute link as a 15 KB JPEG.
- **The SOS.** Ali's phone showed each state only when the server reported it:
  - RECEIVED, then NOTIFIED once a dashboard sent its display receipt. It never said "alert sent", since nothing was sent: there are no push keys or SMS provider locally;
  - with nobody acknowledging, the ladder escalated to step 1 at 60 s;
  - then ACKNOWLEDGED, with the acknowledger's name, and RESOLVED.

  Meanwhile its SOS page held 5 trail points and the newest position. The audit log recorded SOS_VIEWED, SOS_ACKNOWLEDGED and SOS_RESOLVED.
- **The canary.** `operator create-canary`, then the worker with the canary every 60 s:
  - 6 runs passed. The signed SOS was received in 83–327 ms, its alert existed at 127–388 ms, and its realtime event at 522–900 ms. There was no push step, since nobody had subscribed locally;
  - the first run failed because the API dev server was restarting at that moment (`node --watch` restarts when another process loads the same files). The canary logged only "TypeError". It now names the network error ("TypeError: ECONNREFUSED"), with a test.
- **The demo's first report came about a minute late,** while its first rounds of the alert detectors caught up on old data in the demo organization.
- How the alarm, the SOS page and the incident pages look in a browser is for the owner to check (`TODO.md`).
- Everything was stopped afterwards. Two orphaned database processes the stop left behind were ended, and no SENTRY port is left open.
