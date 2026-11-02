# Phase 8 — Incidents and SOS · PLAN

| | |
|---|---|
| Date | 2026-11-02 |
| Go-ahead | The owner, 2026-11-02: "Go for phase 8. The two decisions we will go with your recommendations." |
| Read | PROD §3.2, §7.7–§7.9, §10, §11, §12.5, §13, §14.2, §14.6–§14.7, §16, §17, App. B; ARCH §5.3–§5.4, §6.3, §8.6, §9, §12, §13, §14, §15, §16, §18.4; SEC §2, §7, §9, §12, §16, §17, §18.7, §18.9, §20; D-04, D-08, D-18, D-26, D-30 |
| Exit IDs | ADV-S01–S11, F01–F05, T10 |

Phase 4's device tests are still open, so `status.json` stays at Phase 3, as for Phases 5–7.

**Owner decisions (2026-11-02):** D-18 (gallery photos allowed, labelled) and D-26 (direct Firebase push for the guard app, standard Web Push for the dashboard), both as recommended. Four SOS and privacy gaps answered, all as recommended:

1. A member's SOS text number is entered by an Owner or Administrator, per organization, audited.
2. An incident's reported location is shown to everyone who can see the incident.
3. A drill reaches only the members picked when it starts (the starter by default).
4. Pressing SOS again after it was acknowledged makes it unacknowledged and restarts the alarm ladder.

**What exists already:**

- the SOS lane on the phone: saved first, sent at once, never rate-limited, with the device-key signature when the session can't be used (Phase 4);
- the SOS state machine up to RECEIVED and the SOS screen behind `features.sos`;
- a text-only incident form behind `features.incidents`;
- the alert engine with `SOS_ACTIVATED`, `INCIDENT_CRITICAL` and `INCIDENT_HIGH` in its catalog (Phase 5);
- the SOS settings and `alerts.routing`;
- the realtime stream and monitoring coverage (Phase 6).

Nothing on the server takes an SOS or an incident yet.

## Scope

- **Schema (migration 0010):**
  - `incidents`, with a reference number per organization. The guard's submission can't be changed: the runtime role may update only status, severity and type, by column grants;
  - `incident_events` (append-only) and `incident_attachments`;
  - `sos_events`, with one open SOS per guard; `sos_presses` (every press, idempotent); `sos_drills` and their participants;
  - `notification_deliveries`; `web_push_subscriptions` (per member);
  - the guard phone's push token;
  - a member's SOS phone per organization;
  - `organizations.kind` (customer, demo, canary);
  - `location_points.sos_event_id`.

  Check constraints keep coordinates off any incident or point outside a shift or an open SOS (INV-08).
- **Incidents (PROD §10):**
  - from the guard app through the sync queue (`INCIDENT`, and a new `INCIDENT_NOTE`), only during an active shift or an open SOS, judged by capture time. Shift, site and guard come from the server;
  - from the dashboard: `POST /incidents`;
  - list and detail; notes; acknowledge, resolve (note required) and reopen (reason required); severity and type changes recorded with old and new values;
  - `INCIDENT_CRITICAL` escalates like an SOS; `INCIDENT_HIGH` follows its setting;
  - the guard sees their own incidents and can add notes;
  - the "Checkpoint problem" button files a LOW incident linked to the checkpoint (PROD §7.7).
- **Photos (ARCH §12, SEC §12):**
  - up to 5 per incident, from the in-app camera or the system photo picker (D-18), each labelled with its source;
  - the phone compresses them to JPEG, then uploads through a signed PUT limited to the declared type and size (≤ 15 MB, ≤ 15 min), and completes with the SHA-256;
  - a worker checks the object exists, its size, its real type from magic bytes, ≤ 40 MP and the hash, then makes a re-encoded view copy without metadata;
  - viewing uses a signed GET of the view copy (≤ 5 min). The original is for Owners and Administrators only, audited;
  - storage: a private S3 bucket keyed by organization; a local store for development and tests.
- **SOS (PROD §11, ARCH §13.1):**
  - `POST /sos` stores the SOS, opens `SOS_ACTIVATED`, queues the first notifications and answers RECEIVED; fan-out is never inline;
  - never rate-limited, never blocked by the app version, a suspended organization or an expired session. With an expired session, the device-key signature is accepted from an ACTIVE phone, or a REPLACED one within its 72 h (INV-15);
  - a second press re-triggers the open SOS;
  - SOS location updates and "I'm safe" on the SOS lane; SOS tracking off shift (INV-08's exception);
  - acknowledge and resolve (with type and note) from the dashboard, phones included.
- **Honest states (INV-10, PROD §11.3):**
  - ALERT_SENT only when a provider accepted a push or SMS;
  - NOTIFIED only on a display receipt (`POST /alerts/:id/seen`, sent by a dashboard showing the alarm) or a delivery receipt (`POST /alerts/:id/delivered`, sent by the dashboard's push service worker);
  - the phone shows each state only after the server reports it.
- **Escalation and notifications (ARCH §13.3–§13.4, PROD §11.4, §12.5):**
  - the ladder at 0, 60 and 180 s, then repeats every 120 s until acknowledged, run by a 15-second job;
  - alert routing by severity for other alerts;
  - deliveries are rows with idempotent keys, retries and throttles (one SMS per recipient per SOS per 60 s; the non-SOS monthly cap);
  - providers behind interfaces: Web Push (VAPID), Firebase (D-26) and SMS;
  - SMS has no provider until EXT-10, and non-production sends only to allow-listed numbers;
  - lock-screen-safe text with no coordinates; texts carry a link that needs sign-in.
- **Dashboard:**
  - the SOS alarm: full screen with a repeating sound until acknowledged, an "Enable alarm sound" control with a warning while it's off, a flashing tab title, and a browser notification in the background;
  - the SOS banner on the home page; an SOS page;
  - incidents pages; open incidents on the home page;
  - notification setup: install, subscribe, "Send me a test SOS alert";
  - drills; members' SOS numbers; SOS settings.
- **Drills (PROD §11.10, ADV-S10):**
  - an Owner or Administrator opens a drill window, naming the guards and the members taking part;
  - those guards' SOS during the window is a DRILL everywhere and reaches only the members taking part, marked "[DRILL]";
  - the demo and canary organizations treat every SOS as a drill.
- **Synthetic canary (ARCH §18.4):**
  - every 5 minutes, a simulated phone in an internal organization sends a signed SOS through the public API;
  - it checks the alert, the realtime event and a provider-accepted notification, then resolves the SOS;
  - operator alarms cover canary failures, SOS pipeline errors, provider failures and any SOS unacknowledged for 10 minutes;
  - it stays off until switched on per environment.
- **Guard push (D-26):**
  - the phone registers its Firebase token;
  - the guard is told "SOS acknowledged" and "SOS closed", and about shift changes and reminders;
  - it works once the owner creates the Firebase project.
- **Infrastructure:** the S3 bucket, its IAM access, the Web Push and Firebase secrets, and the operator alarms. They are written in Terraform but applied to the test environment only with the owner's go-ahead, because they add a little to its monthly cost.

## Tests

- **SOS:** ADV-S01–S11 by name: honest states only after the matching server facts; offline exactly once; re-trigger; acceptance while rate-limited, below the minimum version or suspended; no shift; the ladder on a fake clock; "I'm safe"; push provider down; the alarm without sound; drill and demo routing; the signature after expiry and from a replaced phone.
- **Files:** ADV-F01–F05 and T10: an executable renamed `.jpg`, an oversize file and a decompression bomb, a guessed key, an expired URL, metadata stripped from the view copy, the original refused to a supervisor, and another organization's attachment.
- **Also:**
  - the generated idempotency test (ADV-X06) over the new offline item types;
  - ADV-P05 for incidents;
  - the new tables in the cross-tenant read test (ADV-T06) and the schema linter;
  - every new route in the cross-tenant fixtures (ADV-A09) and the coordinate meta-test (ADV-X05);
  - Web Push encryption against the RFC 8291 example; request signing against AWS's published example.
- **Guard app:** the full SOS state ladder, SOS locations and "I'm safe" offline and online, incident photos queued and uploaded, notes.
- **Dashboard:** the alarm and its sound warning; incident and SOS text renders as plain text (ADV-W01).

## Not in this phase

- **Turning SOS on for pilot guards.** That needs:
  - these exit tests;
  - the human checklist on real phones;
  - the SMS provider (EXT-10);
  - the owner's approval (ARCH §22).
- SMS delivery reports. They depend on the provider chosen.
- iOS push (APNs needs the paid Apple account).
- Incident reports and statistics (Phase 9). Drills are already marked so they can be left out.
- Photos attached from the dashboard.
