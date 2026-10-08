# Security Guard Operations & Tracking Platform
# PRODUCT_SPEC.md — What the product does

| | |
|---|---|
| Spec revision | 2 (supersedes the single-file Revision 1 spec) |
| Date | 2026-10-08 |
| Approver | Product owner (Faraz) |
| Implementation agent | Claude Code |
| Audit agent | Fable |
| Target | Production-capable V1, not a throwaway prototype |

---

## 0. Document set (identical block in all three documents)

| Document | Answers | Section prefix |
|---|---|---|
| `PRODUCT_SPEC.md` | What the product does, for whom, with which rules and defaults | `PROD §` |
| `ARCHITECTURE.md` | How it works technically, how it is built, in which order | `ARCH §` |
| `SECURITY_AND_INVARIANTS.md` | What must never be allowed to happen, and how that is proven | `SEC §` |

**Precedence when documents disagree:** `SECURITY_AND_INVARIANTS.md` > approved decisions in `docs/DECISIONS.md` > `PRODUCT_SPEC.md` > `ARCHITECTURE.md` > implementation convenience. A conflict between two statements at the same level is a STOP condition (ARCH §0.3).

**Normative words:** MUST / MUST NOT = required (violation is a defect). SHOULD = expected; deviation needs a recorded reason. MAY = optional. "Default" = a configurable value from PROD Appendix B; never hard-coded.

**Identifiers:** `INV-nn` invariants (SEC §2) · `D-nn` decisions (appendices of each document; numbering is global) · `ADV-xnn` adversarial tests (SEC §18) · `EXT-nn` external dependencies and approvals (ARCH §20) · `A-nn` assumptions (PROD §2.3). Tests SHOULD carry the ID they prove in their name.

**`[R2]`** marks capability added in Revision 2. Any `[R2]` item may be vetoed by the product owner.

### 0.1 What changed from Revision 1 (all three documents)

- Split into three documents; invariants moved to the front of their own document and extended (INV-13 to INV-17).
- Data model completed: `organization_id` on every tenant table including child tables, composite foreign keys so the database rejects cross-tenant references, missing tables added (checkpoint visits, patrol runs, SOS events, settings, invitations, consents, device status, live state, exports), idempotency keys on every record the phone can create offline.
- Undefined `STARTING` shift state removed; full transition table with actors; late start, missed cutoff, auto-end, supervisor manual start, force-end, extend, reopen, offline start.
- Patrol schedules and runs added. Revision 1 had no way to decide when a checkpoint was "missed".
- QR scan endpoint takes the QR token, not the checkpoint ID (Revision 1 §62 contradicted its own §17/§36). Indoor checkpoints with poor GPS get an honest `LOCATION_UNCONFIRMED` outcome.
- Freshness split into "last contact" and "last fix"; thresholds tied to the sync interval (Revision 1's "under 30 s = current" was unreachable with batched uploads).
- Location is accepted or rejected by when it was captured relative to the shift window, not by the shift's current state, so offline data synced after a shift ends is kept while off-shift collection is refused. (Revision 1 §79 would have discarded legitimate offline data.)
- Server-side capture-time estimation from a monotonic clock, so a tampered phone clock cannot fake history.
- Concrete geofence rules with hysteresis; concrete alert catalog with de-duplication, auto-resolve and escalation.
- SOS delivery states defined (received, notified, acknowledged), escalation ladder, SMS escalation, dashboard alarm, phone silent-mode constraints, SOS never rate-limited.
- Supervisor notification path defined. Revision 1 sent push notifications to supervisors who only had a web dashboard.
- Guard sign-in by phone OTP (guards often have no email), invitations, device registration, shared-device rules.
- Pre-shift readiness check and Android manufacturer battery-killer handling.
- Tenant isolation in depth: request context + scoped data access + PostgreSQL row-level security + composite keys + an automated test that fails if any route lacks a policy.
- New: external approvals and platform-constraints register with lead times (ARCH §20), common mis-implementations list (SEC §20), Phase 0B tracking spike on real devices before the mobile build is committed.

---

## 1. Product definition

### 1.1 Concept

A multi-tenant security operations platform. A private security company uses it to manage guards, manage client sites, assign guards to sites through shifts, track guards during active shifts, verify that guards physically visit required patrol checkpoints, detect operational exceptions, receive alerts, record incidents, review history and produce operational reports.

Guards use a mobile app. Owners, administrators, supervisors and dispatchers use a web dashboard; supervisors and dispatchers can also receive and acknowledge alerts on the mobile app (D-04).

### 1.2 Core principle — exceptions, not dots on a map

The product is not merely a GPS map. Its value is to know:

> which guards are working, where they are supposed to be, whether they are actually where they should be, whether required patrols are being completed, and whether something requires supervisor attention.

A supervisor opening the dashboard must immediately see who is working, where active guards are, which guards are stale or offline, which have left their sites, which patrols were missed, which incidents occurred, whether an SOS is active, and what needs action.

### 1.3 Honest operational state (governs every screen and API)

The platform never optimizes for the appearance of certainty.

| Situation | The product says |
|---|---|
| Location not recently received | "Location stale · last known 7 min ago" |
| GPS accuracy poor | "Low location accuracy (~120 m)" |
| SOS not yet on the server | "SOS ACTIVE — waiting for network" |
| Checkpoint location cannot be confirmed | "QR accepted — location could not be confirmed" |
| Dashboard lost its live connection | "Live updates disconnected — data may be out of date" |

Product claims about location evidence are worded as: "the device location evidence indicates the device was here", never "GPS proves the guard stood here".

### 1.4 Operating context (drives many requirements)

- Guards often use low-to-mid-range Android phones, sometimes their own; work night shifts; may be walking, gloved, stressed, in darkness, carrying equipment; connectivity is intermittent (basements, warehouses, outskirts); literacy and language vary; mobile data may be paid by the guard.
- Supervisors and dispatchers work from a control room (desktop screens left open 24/7) and from the field (phone).
- Security companies must prove service to their own clients (site owners). Reports are commercial evidence; data integrity matters.
- Records may be used in disputes, disciplinary processes and legal proceedings.

---

## 2. Scope

### 2.1 Included in V1

| Area | Included |
|---|---|
| Organizations | organizations, members, fixed roles, tenant isolation, invitations [R2], organization settings [R2] |
| Guards | profiles, status, employee numbers, devices, tracking consent records [R2] |
| Sites | sites, address, coordinates by map pin, circular geofence, checkpoints, printable QR labels [R2] |
| Shifts | create, bulk create from a weekly pattern [R2], assign, start/end, late and missed detection, auto-end [R2], supervisor manual start / force-end / extend / reopen [R2] |
| Tracking | shift-bound background tracking, accuracy handling, offline queue, sync, idempotency, freshness, device health reporting [R2], pre-shift readiness check [R2] |
| Patrols | routes, checkpoints, patrol schedules and runs [R2], QR verification with location evidence, missed-patrol detection |
| Incidents | create (online/offline), categories, severity, description, photos, location, timestamps, reference numbers [R2], notes and history [R2] |
| Emergency | SOS, escalation ladder [R2], SMS escalation (D-08), dashboard alarm, drill mode [R2] |
| Dashboard | exception-first home, live map, guard status, alerts, active shifts, sites, incidents, guard detail, location history |
| Mobile for supervisors | alerts feed and SOS acknowledgement (D-04) [R2] |
| Reports | attendance, patrol, incident, location, site activity / proof of service [R2]; CSV export |
| Audit | administrative and security-sensitive actions, location-history access |
| Operations | observability, synthetic SOS monitoring [R2], backups and disaster recovery [R2] |

### 2.2 Out of scope for V1 (do NOT add silently)

Payroll; salary management; invoicing; customer billing; accounting; AI guard scoring; facial recognition; biometric identification; licence-plate recognition; camera surveillance; body-camera streaming; voice recording and voice notes; automatic police or emergency-service dispatch; hardware trackers; NFC; BLE beacons; predictive analytics; route optimization; public customer/client portal; guard-to-guard chat; social features; advertising; selling or sharing location data; shift swapping/trading; guard self-scheduling; leave management; break tracking; relief/handover workflow; post orders and document library; sub-zones/posts within a site; polygon geofences; custom roles or custom permissions; guards belonging to more than one organization; WhatsApp integration; automatic background SMS from the guard's phone; offline map tiles; duress PIN; enforced device attestation (App Attest / Play Integrity); white-labelling; public API and webhooks; SSO/SAML; automated voice-call escalation.

These may become future features. They MUST NOT complicate V1 without explicit approval.

### 2.3 Assumptions (confirm or correct before Phase 1)

| ID | Assumption | Affects |
|---|---|---|
| A-01 | Primary launch market is Pakistan (Revision 1 sample coordinates are Karachi). | device matrix, SMS providers, language, map provider, data residency, legal review |
| A-02 | Most guards use Android; a minority use iPhone. | test matrix, Phase 0B devices |
| A-03 | Guard phones may be personal or company-issued; one signed-in guard per phone at a time. | D-05 |
| A-04 | A guard belongs to exactly one organization. If this changes, architecture is revisited. | data model |
| A-05 | V1 scale target: ≤ 50 organizations, ≤ 2,000 concurrently active guards, ≤ 20,000 guards total (D-23). | load tests, partitioning |
| A-06 | Shifts are ≤ 24 h, typically 8 or 12 h, many overnight. | state machine, battery budget |
| A-07 | Organizations are provisioned by the platform operator, not by self-serve signup (D-19). | onboarding |

---

## 3. Roles and permissions

### 3.1 Roles

- **Owner** — full authority within the organization. Cannot access other organizations.
- **Administrator** — manages guards, supervisors, dispatchers, sites, shifts, patrols, incidents, reports. Cannot manage owners or other administrators. Cannot transfer ownership.
- **Supervisor** — operational lead: live operations, alerts, incidents, guard history, shift interventions; shift planning per D-03.
- **Dispatcher** — monitors and acknowledges; less authority than a Supervisor; no location history.
- **Guard** — own profile, own shifts, own patrols, incidents, SOS. Never sees other guards.
- **Platform operator** (internal staff, not an organization role) — provisions organizations; no standing access to tenant data (SEC §4.6).

Roles are fixed in V1. Authorization is implemented as permissions (ARCH §4.6) so custom roles can be added later without rewriting checks.

### 3.2 Permission matrix (authoritative)

| Capability | Owner | Admin | Supervisor | Dispatcher | Guard |
|---|---|---|---|---|---|
| Organization profile and settings | edit | view | – | – | – |
| Manage owners and administrators | ✔ | – | – | – | – |
| Invite / disable / change role of supervisors, dispatchers, guards | ✔ | ✔ | – | – | – |
| Guard profiles (create, edit, disable, terminate) | ✔ | ✔ | view | view | own (view) |
| Devices (view, revoke) | ✔ | ✔ | view | – | own (view) |
| Sites, geofences, checkpoints; QR rotate and print | ✔ | ✔ | view | view | assigned site (view; no QR data) |
| Patrol routes and schedules | ✔ | ✔ | view | view | assigned (view) |
| Create / edit / cancel shifts | ✔ | ✔ | ✔ (D-03) | – | – |
| Manual start, force-end, extend, reopen shift | ✔ | ✔ | ✔ | – | – |
| Start / end own shift | – | – | – | – | ✔ |
| Live map and live locations | ✔ | ✔ | ✔ | ✔ | – |
| Location history and location exports (audited) | ✔ | ✔ | ✔ | – | own shifts (D-22) |
| Create incident | ✔ | ✔ | ✔ | – | ✔ |
| View incidents | ✔ | ✔ | ✔ | ✔ | own |
| Change incident status / severity / type, add notes | ✔ | ✔ | ✔ | acknowledge + notes | notes on own |
| View and acknowledge alerts | ✔ | ✔ | ✔ | ✔ | – |
| Resolve / dismiss alerts | ✔ | ✔ | ✔ | – | – |
| Activate SOS | – | – | – | – | ✔ |
| View and acknowledge SOS | ✔ | ✔ | ✔ | ✔ | own status |
| Resolve SOS; start/stop SOS drill | ✔ | ✔ (drill: ✔) | resolve only | – | – |
| Reports and CSV exports | ✔ | ✔ | ✔ | – | – |
| Audit log | ✔ | – | – | – | – |

### 3.3 Role rules

- Nobody can change their own role or membership status (INV-03).
- An organization always has at least one ACTIVE owner; demoting, disabling or removing the last owner is rejected (`LAST_OWNER`).
- Ownership transfer is out of scope in V1 except through a documented platform-operator procedure.
- Role and membership changes take effect on the next request and end the user's live dashboard connections within 60 s.
- A user with the Guard role is linked to exactly one guard record in that organization. In V1 the Guard role cannot be combined with any other role in the same organization (prevents a guard supervising themselves).
- Supervisor scope (D-03): V1 default is organization-wide. The design must allow site-scoped supervisors later.

---

## 4. Organizations, members and onboarding

### 4.1 Organizations

Created by the platform operator (D-19) with name, legal name, IANA timezone (explicit; never the server timezone) and default language. Statuses: ACTIVE, SUSPENDED, CLOSED. Suspension is a deliberate operator action; it MUST NOT be applied to an organization with active shifts without explicit confirmation, and SOS events from that organization continue to be accepted and stored.

### 4.2 Invitations

- Owners and administrators invite members by email (dashboard roles) or phone number (guards).
- An invitation is bound to one organization, one role and, for guards, one guard record. It is single-use, expires after 7 days, and can be revoked.
- Guards cannot self-register into an organization.

### 4.3 Guard onboarding flow

1. Administrator creates the guard record (employee number, name, phone) and sends an invitation (SMS with link and code).
2. Guard installs the app and signs in (D-02: phone OTP recommended; employee number + PIN as an organization-level fallback where SMS is unreliable).
3. Tracking disclosure screen (PROD §7.2) → guard accepts → consent recorded with the disclosure version.
4. Permission flow (PROD §7.3).
5. Device registration.
6. Readiness check (PROD §7.4).

Declining permissions never crashes or loops the app; it explains the consequence and how to fix it later.

### 4.4 Guard lifecycle

Statuses: ACTIVE, INACTIVE, SUSPENDED, TERMINATED. Disabling or terminating a guard: revokes sessions and devices, force-ends any active shift (reason recorded), prompts the administrator about future shifts, and keeps all history.

### 4.5 Devices (D-05)

- V1 default: one ACTIVE device per guard. Registering a new device revokes the previous one (reason REPLACED) and opens a `DEVICE_CHANGED` alert (LOW) so supervisors know.
- Shared company phones are supported only by sign-out/sign-in; never two guards at once. Data captured by one guard is never uploaded under another guard's identity.
- A guard cannot sign out while a shift is ACTIVE; they must end the shift first. A guard with unsent data is warned before sign-out and must confirm data loss explicitly.

---

## 5. Sites, geofences and checkpoints

### 5.1 Sites

Name, client name, address, country, timezone (defaults to the organization's), coordinates, geofence radius, status (ACTIVE / INACTIVE / ARCHIVED), notes. Sites are archived, never deleted, because history references them.

**Coordinates are set by dropping a pin on a map.** Address geocoding is only a suggestion (addresses in many markets geocode poorly). The dashboard previews the geofence circle while editing.

### 5.2 Geofence

One circle per site in V1: centre + radius. Radius 50–5,000 m, default 100 m. A geofence smaller than typical GPS error is meaningless; 50 m is the floor. GPS coordinates are never assumed to be exact. Changes are audited with old and new values.

### 5.3 Checkpoints

Name, description, optional coordinates (map pin in V1; on-site calibration is D-24), verification radius 10–500 m (default 30 m), status. A checkpoint belongs to one site and may belong to at most one scheduled patrol route.

### 5.4 QR labels [R2]

- Each checkpoint has an opaque random QR token. The QR content contains no internal IDs and is not a web URL (a phone camera scanning it must not open a page).
- Administrators print label sheets from the dashboard: QR code, checkpoint name, site name.
- Rotating a checkpoint's QR invalidates the old label immediately; scanning an old label tells the guard "Old QR code — report to supervisor".
- Reprinting an existing label does not rotate it; every print is audited.
- Physical tamper-evident labels are recommended to customers in onboarding material.

---

## 6. Shifts

### 6.1 Times

Shift start and end are stored as UTC instants and entered/displayed in the site's timezone. Overnight shifts are normal. A shift is attributed to the local date of its scheduled start. Maximum length 24 h. A guard cannot have overlapping shifts (cancelled shifts excepted).

### 6.2 Creating and editing

- Single create; **bulk create from a weekly pattern** [R2] (e.g., guard X, site Y, Mon–Sat 20:00–08:00, from date A to date B). Bulk create shows a preview with per-row conflicts and is all-or-nothing by default. It produces ordinary individual shifts; there are no live recurrence rules in V1.
- SCHEDULED shifts: time, guard and site may be changed (recorded as events; the guard is notified).
- ACTIVE shifts: only extending the end time or force-ending.
- COMPLETED / MISSED / CANCELLED: immutable except notes (MISSED may be reopened, below).
- Guards are notified of assignments, changes and cancellations for shifts in the next 14 days, and reminded before start (default 30 min).

### 6.3 States and transitions

States: `SCHEDULED`, `ACTIVE`, `COMPLETED`, `MISSED`, `CANCELLED`.

Revision 1's `STARTING` state is removed. Starting a shift is a single server transaction; "Starting…" and "Started on this phone — waiting to confirm" exist only as phone UI states.

Each shift has a **start deadline** = scheduled start + `shift.missed_after_minutes`, recomputed when the shift is edited or reopened.

| From | To | Actor | Conditions | Event |
|---|---|---|---|---|
| SCHEDULED | ACTIVE | Guard (online, or offline then synced) | PROD §6.4 checks pass | STARTED |
| SCHEDULED | ACTIVE | Supervisor+ (manual start) | reason required; used when the guard's phone is unavailable; dashboard shows "Manual attendance — no tracking" until the guard's phone starts tracking | STARTED (manual) |
| SCHEDULED | CANCELLED | Admin, Supervisor | reason required | CANCELLED |
| SCHEDULED | MISSED | System | not started by the start deadline | MARKED_MISSED |
| MISSED | SCHEDULED | Supervisor+ (reopen) | before scheduled end; reason; start deadline becomes scheduled end | REOPENED |
| MISSED | ACTIVE | System | a guard START captured offline inside the start window arrives late | STARTED (late sync) |
| ACTIVE | COMPLETED | Guard | own active shift | ENDED |
| ACTIVE | COMPLETED | Supervisor+ (force-end) | reason required | FORCE_ENDED |
| ACTIVE | COMPLETED | System | not ended by scheduled end + `shift.auto_end_after_minutes` | AUTO_ENDED |
| ACTIVE | ACTIVE | Supervisor+ (extend) | new end is in the future; total ≤ 24 h | EXTENDED |

Every other transition is rejected (`SHIFT_INVALID_TRANSITION`). The server owns shift state. Repeating a guard's start or end command (same client event ID) returns the original result.

### 6.4 Starting a shift (guard)

The phone must send a location fix captured at most `shift.start_max_fix_age_seconds` before the start action; the server checks, in order:

1. Guard is authenticated, membership ACTIVE, guard ACTIVE.
2. Device is registered, ACTIVE, and belongs to the guard.
3. Shift belongs to the guard.
4. Shift is SCHEDULED.
5. Capture time is within the start window: from scheduled start − `shift.earliest_start_minutes` to the start deadline.
6. Guard has no other ACTIVE shift.
7. A fresh location fix is attached (`LOCATION_FIX_REQUIRED` otherwise). The server cannot verify phone permissions; it verifies evidence (a fresh fix) and records the phone-reported permission state.
8. Phone-reported permission is "always" + precise. If not, behaviour follows `shift.require_background_permission` (default: block with fix-it instructions; a supervisor manual start is the override).
9. Accuracy worse than `shift.start_required_accuracy_m` → start allowed, flagged "low-accuracy start".
10. Start fix outside the geofence → behaviour follows `shift.start_outside_geofence` (D-15; default: allow, flag, and open `STARTED_OFF_SITE` LOW alert). Blocking would stop legitimate guards whenever GPS is poor.

Recorded: actual start time (server receipt time when online; server-estimated capture time when synced from offline), start fix, distance from site, flags, source (online / offline-synced / manual).

### 6.5 Offline start (D-06, recommended: allowed)

With no connectivity the phone records the start locally, starts tracking at once, and shows **"Shift started on this phone — waiting to confirm with server"**. On sync the server applies PROD §6.4 using the estimated capture time. If the server rejects the start, the phone stops tracking, discards that shift's queued locations, and shows the reason with a "Call supervisor" button. Until the server confirms, the dashboard shows the shift as not started (late) — never as active on a guess.

### 6.6 Ending a shift

- Guard ends their own ACTIVE shift (online, or offline then synced). **Tracking stops immediately when the guard taps End** — not when the server confirms (INV-08). Queued data keeps uploading.
- Phone failsafe: tracking stops by itself at scheduled end + `shift.auto_end_after_minutes`, even with no server contact, with the message "Shift time over — tracking stopped. Tap End Shift."
- Server auto-ends at the same moment (`AUTO_ENDED`). A `SHIFT_OVERRUN` LOW alert opens at scheduled end + `shift.overrun_alert_after_minutes` so a supervisor can extend if the relief guard is late.
- On end: open patrol runs are closed, shift-scoped condition alerts auto-resolve (PROD §12.4).

### 6.7 Late and missed

- At scheduled start + `shift.late_alert_after_minutes` with no start → `SHIFT_NOT_STARTED` (MEDIUM).
- After the start deadline → shift becomes MISSED; `SHIFT_MISSED` (HIGH) opens; `SHIFT_NOT_STARTED` resolves as superseded.
- A guard may start late any time before the start deadline; the attendance report shows the lateness.

### 6.8 Attendance definitions

- Late minutes = max(0, actual start − scheduled start).
- Early-leave minutes = max(0, scheduled end − actual end).
- Worked duration = actual end − actual start.
- Flags shown with every record: offline start, manual start, auto-ended, force-ended, off-site start, low-accuracy start.

---

## 7. Guard mobile app

### 7.1 Experience principles

- Extremely simple. A guard may be walking, gloved, stressed, in darkness, carrying equipment, on an inexpensive phone.
- Primary actions ≥ 64 dp tall, full width. During a shift the SOS button is visible on every screen.
- Dark theme by default (night work), high contrast, usable at 200% system font size on critical screens.
- Every action has icon + text; no icon-only critical control.
- Every critical action confirms with haptic + visual feedback (optional sound).
- Plain-language messages; error codes shown small, for support only.
- Languages (D-14): all strings externalized from the first screen built; English + Urdu at launch if A-01 holds, with correct right-to-left layout; 24-hour time by default.
- Works offline for: start (D-06), end, tracking, patrol scans, incidents (photos queued), SOS.
- Core flows need no map tiles; data use is kept small.

### 7.2 Tracking disclosure (shown before any permission request)

Localized, versioned text covering what is collected, when (only during shifts and an active SOS), why, who sees it, and how long it is kept. Example core text:

> **Why we need your location**
> During an active security shift, the app uses your location to:
> • verify you are at your assigned site;
> • record patrol activity;
> • help supervisors respond to emergencies.
> Location tracking runs only during your assigned shift and during an SOS. It stops when your shift ends.

The guard taps "I understand"; the acceptance is recorded with the disclosure version and language. A new disclosure version is shown again before the next shift start.

### 7.3 Permission flows

**Android**
1. Notifications (Android 13+) — needed for the tracking notification and shift messages.
2. Precise location. If the guard chooses approximate, explain why precise is needed and ask again or open settings.
3. Background location ("Allow all the time") — requested separately after foreground location; Android sends the guard to settings. Google Play requires a prominent in-app disclosure immediately before this request.
4. Battery optimization — open the system settings page so the guard can exempt the app (see ARCH §20 for the policy constraint on the direct-request permission).
5. Manufacturer background restrictions — guided screens per manufacturer (Xiaomi/Redmi/Poco, Oppo/Realme/OnePlus, Vivo, Samsung, Huawei/Honor, Infinix/Tecno/itel) with deep links where available. The guard confirms each step; confirmations are reported.
6. Unused-app permission removal (Android 11+) — ask the guard to turn off "Pause app activity if unused".

**iOS**
1. Location "While Using", then upgrade to "Always", each with an explanation screen.
2. Precise location required. If reduced accuracy is chosen, tracking is shown as "Approximate only"; checkpoint scans request temporary full accuracy.
3. Notifications.

Usage descriptions are specific to this product, never generic.

### 7.4 Pre-shift readiness check [R2]

Shown before Start Shift and available any time. Results are reported to the server.

| Item | Default |
|---|---|
| Signed in, device active | Blocking |
| App version supported | Blocking |
| Location services on | Blocking |
| Location permission "always / all the time" | Blocking (setting; supervisor manual start is the override) |
| Precise location | Blocking (setting) |
| Fresh fix obtained (accuracy shown) | Blocking; retry button; supervisor override |
| Notifications enabled | Warning |
| Battery optimization exempt and manufacturer steps confirmed (Android) | Warning |
| Battery ≥ 20% or charging | Warning |
| Network available | Warning (offline start is allowed) |
| Automatic date and time enabled | Warning |

Readiness-check location fixes stay on the phone. Only the fix attached to the start action is uploaded.

### 7.5 Home screens

Before the shift:

```text
Good evening, Ahmed

TODAY'S SHIFT
ABC Warehouse
20:00 – 08:00
Status: NOT STARTED

[ START SHIFT ]
```

During the shift:

```text
ABC Warehouse            SHIFT ACTIVE
Started 19:57
Tracking active · 20 s ago · ±8 m
All data sent

Next patrol: 22:00 (Main Entrance first)

[ PATROL ]
[ REPORT INCIDENT ]
[ SOS — hold 3 s ]
```

### 7.6 Honest status on the phone (INV-16)

| Topic | Example states |
|---|---|
| Tracking | "Tracking active · 20 s ago · ±8 m" · "Waiting for GPS" · "Low accuracy (~120 m)" · "Tracking problem: location permission changed — Fix" · "Approximate location only — Fix" |
| Sync | "All data sent" · "Sending…" · "Offline — 42 updates waiting · oldest 18 min" · "Signed out — 42 updates cannot be sent" |
| Actions | "Saved on this phone — will send when online" → "Received by server" → "Verified" |
| Interruptions | "Tracking was interrupted 21:10–21:42" (shown after the app was killed and reopened) |
| Clock | "Your phone's time is wrong — turn on automatic time" |

### 7.7 Patrol flow

List of patrol runs with due times and the next checkpoint. Scan with the camera (torch toggle). The phone captures a fresh fix with the scan (waits up to 10 s for good accuracy, then uses the best available). Results:

- ✓ "Verified"
- "Saved — will verify when online"
- "QR accepted — location could not be confirmed"
- "Not verified: about 85 m from this checkpoint"
- "Unknown QR code" / "Old QR code — report to supervisor"
- "This checkpoint belongs to another site"
- "No active shift"

A "Checkpoint problem" button reports a damaged or missing label (creates a LOW incident linked to the checkpoint; it does not count as a visit).

### 7.8 Incident flow

Type grid with icons → severity (preset by type, e.g., FIRE and MEDICAL default HIGH) → optional description → up to 5 photos (camera by default; gallery per D-18, labelled) → location captured automatically → time defaults to now (may be set back up to 24 h) → submit. Works offline with a clear queued state. When severity is CRITICAL the app asks: "Also send SOS?"

### 7.9 SOS flow

See PROD §11. Hold for 3 s with a progress ring and haptic ticks; releasing early cancels. No extra confirmation dialog after the hold.

### 7.10 Supervisor mode on mobile (D-04) [R2]

When the signed-in user is a Supervisor, Dispatcher, Administrator or Owner, the app shows: open alerts sorted by severity, SOS acknowledge, alert detail with the guard's last known location and freshness, and a "Call guard" button. Supervisors are never tracked.

### 7.11 Diagnostics screen

App version, permission states, queue size, oldest pending item, last successful sync, and "Send diagnostics" (contains no location).

---

## 8. Location tracking behaviour

### 8.1 When tracking runs

```text
Before shift:   NO TRACKING
Shift starts:   TRACKING ON
Shift active:   LOCATION COLLECTION
Shift ends:     TRACKING OFF
SOS active:     TRACKING ON (high frequency) until the SOS is resolved
```

No silent 24/7 tracking. Off-shift location reaching the server is rejected and not stored (INV-08).

### 8.2 Sampling defaults

| Situation | Default |
|---|---|
| Moving | a point every 20 m, no more than one per 15 s, at least one per 60 s |
| Stationary | one fix every 5 min |
| Start, end, checkpoint scan, incident | fresh on-demand fix (wait ≤ 10 s for good accuracy, take the best) |
| SOS active | one fix every 10 s |
| Heartbeat (phone online, shift active) | every 60 s, even with no new point |
| Upload | every 60 s when online; immediately for SOS, start, end, scans, incidents |

Adaptive or motion-based tuning is not built until basic tracking is proven reliable on real devices.

### 8.3 Freshness — two signals

Revision 1 used one timestamp. A stationary guard indoors may be connected but without a new fix; an offline guard may have fresh fixes not yet uploaded. So:

- **Last contact** — when the server last heard anything from the guard's phone.
- **Last fix** — capture time of the newest usable location.

Freshness states, evaluated top to bottom (first match wins):

| State | Condition (defaults) | Map |
|---|---|---|
| UNKNOWN | no usable fix since shift start | no marker; listed as "Location unknown" |
| OFFLINE | last contact > 10 min ago | grey marker at last fix: "Offline · last contact 14 min ago" |
| STALE | last fix > 5 min ago | hollow grey marker: "Last known 7 min ago" |
| RECENT | last fix > 2 min ago | muted marker with age |
| LIVE | otherwise | solid marker with age |

Revision 1's `CURRENT` is renamed `LIVE`. Settings validation rejects thresholds that cannot work: the LIVE limit must be at least twice the upload interval, and STALE must be greater than LIVE.

Rules:
- The dashboard recomputes freshness locally every few seconds; a marker goes stale on screen even when no new events arrive.
- Accuracy is always shown (number and circle). Fixes worse than 100 m are labelled "Low accuracy".
- Tracking problems (permission removed, approximate only, location services off, possible mock location, wrong phone clock, low battery, battery saver) are shown alongside freshness, never instead of it.
- Markers never animate or interpolate between fixes.

### 8.4 Geofence behaviour

One point outside the circle does not mean the guard left. Each usable fix (accuracy ≤ 100 m) is classified:

- **Inside**: distance to centre ≤ radius.
- **Outside**: distance − accuracy > radius + 25 m buffer.
- **Uncertain**: everything else.

Fixes with poor or unknown accuracy are kept but do not change geofence state.

Departure is confirmed only when, since the first Outside fix, there has been no Inside fix, there are at least 3 Outside fixes, and they span at least 5 minutes. Then `LEFT_SITE` is recorded and `GUARD_LEFT_SITE` (HIGH) opens. Uncertain fixes neither confirm nor cancel a departure.

Return is confirmed by one Inside fix with accuracy ≤ 50 m, or two consecutive Inside fixes. Then `ENTERED_SITE` is recorded and the alert auto-resolves with the time spent outside.

If the location goes stale while the guard is outside, the dashboard shows both: "Off site · location stale". Data that arrives late (offline sync) and reveals a past excursion that has already ended is recorded in the shift history and reports as "detected after sync"; it does not raise a live alert.

All numbers are settings (PROD Appendix B).

### 8.5 Location evidence, not proof

V1 does not promise anti-spoofing. It collects evidence (accuracy, mock-location flags where the OS provides them, travel plausibility, clock integrity, checkpoint scans, site proximity) and surfaces suspicious patterns as flags and `SUSPICIOUS_LOCATION` alerts.

---

## 9. Patrols

### 9.1 Concepts

- **Checkpoint** — a physical point with a QR label.
- **Patrol route** — an ordered set of checkpoints at one site, optionally with a schedule.
- **Patrol run** — one required execution of a route inside a shift, with a due time and a completion window.
- **Checkpoint visit** — one scan and its verification result.

### 9.2 Schedules and runs (D-16: per-shift runs recommended)

- A route with an interval *I* and completion window *W* generates runs for every ACTIVE shift at its site: run *k* is due at actual start + offset + *k*·*I*, closes at due + *W*, while due is before the scheduled end.
- Runs are generated when the shift starts and regenerated for future runs if the shift is extended or the route changes.
- A route without an interval is "on demand": scans are recorded; nothing is ever "missed".
- Run states: PENDING → IN_PROGRESS (first counting scan) → COMPLETED (all required checkpoints counted inside the window) | INCOMPLETE (window closed with some) | MISSED (window closed with none) | CANCELLED (shift ended before the run was due).
- One `CHECKPOINT_MISSED` alert per incomplete or missed run, listing the missing checkpoints — not one alert per checkpoint.
- Route order is guidance by default; with "enforce order" on, out-of-order scans still count but are flagged.

### 9.3 Scan outcomes

| Outcome | Meaning | Counts toward the run? |
|---|---|---|
| VERIFIED | valid QR, right site, active shift, fresh fix within the checkpoint radius | yes |
| LOCATION_UNCONFIRMED | valid QR, but location could not be confirmed (no fix, stale fix, poor accuracy, checkpoint has no coordinates, or mock location under policy) | per D-17 (default yes, always labelled "QR only") |
| OUTSIDE_RADIUS | the fix is clearly outside the checkpoint radius even allowing for accuracy | no |
| WRONG_SITE | checkpoint belongs to a different site than the shift | no |
| INVALID_QR | unknown, rotated, archived, or another organization's QR (same message for all) | no |
| NO_ACTIVE_SHIFT | no active shift at scan time | no |
| DUPLICATE | same checkpoint already counted in this run within the duplicate window | no (recorded) |

Flags (do not change the outcome, appear in reports): MOCK_LOCATION, IMPLAUSIBLE_TRAVEL (two scans too far apart for the time between them — the classic "photographed QR codes" pattern), CLOCK_SKEW, LOW_ACCURACY, OUT_OF_ORDER.

A QR code alone never completes a checkpoint (INV-11). Offline scans are verified on sync with the same rules, using the capture time.

---

## 10. Incidents

### 10.1 Fields

Type: THEFT, INTRUSION, FIRE, MEDICAL, PROPERTY_DAMAGE, ALTERCATION, SUSPICIOUS_ACTIVITY, OTHER.
Severity: LOW, MEDIUM, HIGH, CRITICAL.
Status: OPEN → ACKNOWLEDGED → RESOLVED (resolution note required); a Supervisor+ may reopen with a reason.
Also: human reference number per organization (e.g., `INC-000123`) [R2], title (≤ 120 chars), description (≤ 4,000 chars), location with accuracy, occurred time (may be set up to 24 h back; never in the future), reported time, received time, guard, shift and site (derived by the server from the guard's active shift, never trusted from the phone), optional checkpoint, up to 5 photos.

### 10.2 Integrity

- The guard's original submission is never edited (INV-05). Guards may add notes to their own incidents.
- Supervisors add notes and may change severity or type; each change is recorded with old and new values.
- Descriptions are never overwritten; corrections are notes.

### 10.3 Photos

Compressed on the phone before upload; uploaded after the incident is accepted; retried until done. Viewing in the dashboard uses a re-encoded copy with photo metadata removed; the original is kept privately as evidence and can be downloaded only by Owners and Administrators (audited). Each photo records whether it came from the in-app camera or the gallery.

### 10.4 Alerts from incidents

CRITICAL → `INCIDENT_CRITICAL` (CRITICAL, escalates like SOS by default). HIGH → `INCIDENT_HIGH` (setting, default on). Lower severities appear in the incident list only.

---

## 11. SOS and emergency

### 11.1 Activation

- Press and hold for 3 s (progress ring, haptic tick each second; releasing early cancels). No confirmation dialog afterwards — it adds delay under stress.
- Available whenever a guard is signed in: on every screen during a shift, and on the home screen off-shift. An off-shift SOS is accepted; it has no shift and starts SOS tracking (a disclosed, legitimate emergency purpose).

### 11.2 What the phone does, immediately and in this order

1. Saves the SOS on the phone.
2. Sends it on a dedicated priority path, without waiting for a GPS fix and without queueing behind other data.
3. In parallel gets the best fix it can within 10 s and sends it as an SOS location update.
4. Switches to SOS tracking (one fix every 10 s) regardless of shift state, until the server reports the SOS resolved. After 4 h without resolution, SOS tracking drops to normal shift behaviour (or stops if off-shift) with a notice; the SOS itself stays open.

### 11.3 Delivery states (defines Revision 1 §72; enforces INV-10)

| Phone state | Meaning | Phone shows |
|---|---|---|
| QUEUED | saved on phone, not yet sent | "SOS ACTIVE — waiting for network…" |
| SENDING | request in flight | "Sending SOS…" |
| RECEIVED | server stored it and confirmed | "SOS received by control room" |
| NOTIFIED | server confirms at least one person was reached: a push or SMS accepted by the provider, or the alarm displayed on a connected dashboard or supervisor app | "Supervisors alerted" |
| ACKNOWLEDGED | a person acknowledged it | "Help acknowledged by Sarah K. at 21:14" |
| RESOLVED | a supervisor closed it | "SOS closed" |

The phone never shows a later state without server confirmation. It learns state from the send response, then checks every 5 s while open, and from a push when acknowledged.

### 11.4 Escalation ladder (defaults, per-organization settings)

| Time unacknowledged | Action |
|---|---|
| 0 s | Full-screen alarm with repeating sound on every connected dashboard and supervisor app; push to all Supervisors, Dispatchers and Administrators |
| 60 s | SMS to Supervisors and Administrators (D-08); push repeated |
| 180 s | SMS and push to Owners and the organization's emergency contacts |
| every 120 s after | repeat until acknowledged |

Acknowledgement stops escalation. Resolution is a separate step with a resolution type (GENUINE, FALSE_ALARM, ACCIDENTAL, DRILL, OTHER) and a note.

### 11.5 Reaching people who are not looking at a screen

Phones on silent, Do Not Disturb or Focus can suppress ordinary notifications. This is a platform constraint, not a bug we can fix in code (ARCH §20):
- The supervisor app uses the highest notification priority each platform allows without special approval (iOS time-sensitive notifications; an Android high-importance alarm channel) and asks the supervisor during setup to allow these to break through Do Not Disturb.
- iOS Critical Alerts require an Apple entitlement that must be applied for and may be refused (EXT entry). V1 MUST NOT depend on it.
- The supervisor app setup includes a test: "Send me a test SOS alert".
- Organizations must staff monitoring. The dashboard home shows **monitoring coverage** [R2]: how many dashboards and supervisor apps are connected right now, with a warning when active shifts exist and nobody is connected.

### 11.6 Dashboard alarm

Browsers block sound until the user interacts with the page. At sign-in the dashboard shows an "Enable alarm sound" control and keeps a visible warning while sound is not enabled. The alarm repeats until someone acknowledges; the browser tab title flashes; a browser notification is shown when the tab is in the background (supplementary only).

### 11.7 Phone fallbacks while offline

If the SOS is still QUEUED after 15 s, the phone shows "Call supervisor" (dials the organization's emergency number) and "Send SMS" (opens the messaging app with a prefilled message containing name, site, coordinates and time — the guard must press send). The app never claims the SMS was sent. Automatic background SMS is out of scope and blocked by store policy.

### 11.8 Cancelling

The guard can tap "I'm safe / false alarm". This annotates the SOS; it does not resolve it and does not stop escalation (someone may be forcing the guard to cancel). A supervisor must acknowledge and resolve.

### 11.9 Duplicates and limits

One open SOS per guard. Pressing again while one is open re-triggers it (new location, alert counter increases) rather than creating another. SOS acceptance is never rate-limited, blocked by an app-version gate (except a version revoked for security), or dropped (INV-15). Only notifications are throttled (no more than one SMS per recipient per SOS per 60 s).

### 11.10 Drill mode [R2]

Owners and Administrators can open a drill window. SOS events during a drill are marked DRILL everywhere, notifications are prefixed "[DRILL]", and drills are excluded from incident statistics.

---

## 12. Alerts

### 12.1 Catalog (defaults)

| Type | Trigger | Severity | Auto-resolves when | Escalates |
|---|---|---|---|---|
| SOS_ACTIVATED | SOS received | CRITICAL | never (must be resolved) | yes (PROD §11.4) |
| INCIDENT_CRITICAL | CRITICAL incident | CRITICAL | never | yes (setting) |
| INCIDENT_HIGH | HIGH incident (setting) | HIGH | never | no |
| GUARD_LEFT_SITE | departure confirmed (PROD §8.4) | HIGH | guard back inside | optional |
| TRACKING_DISABLED | permission removed, location services off, approximate only, or signed out during a shift | HIGH | condition cleared | no |
| DEVICE_OFFLINE | no contact beyond the offline threshold | MEDIUM | contact resumes | no |
| LOCATION_STALE | phone in contact but no usable fix beyond the stale threshold (suppressed while DEVICE_OFFLINE is open) | MEDIUM | usable fix arrives | no |
| SHIFT_NOT_STARTED | late beyond the late threshold | MEDIUM | shift starts, or superseded by SHIFT_MISSED | no |
| SHIFT_MISSED | shift became MISSED | HIGH | late offline start arrives (system) | no |
| CHECKPOINT_MISSED | patrol run INCOMPLETE or MISSED | MEDIUM | never | no |
| SUSPICIOUS_LOCATION | mock location, implausible travel or jumps | MEDIUM | never | no |
| STARTED_OFF_SITE | start fix outside the geofence | LOW | guard enters the site | no |
| SHIFT_OVERRUN | not ended after scheduled end + threshold | LOW | shift ends | no |
| LOW_BATTERY | battery ≤ 15% and not charging | LOW | charging or > 25% | no |
| DEVICE_CHANGED | new device registered for a guard | LOW | never | no |

### 12.2 States

OPEN → ACKNOWLEDGED → RESOLVED, or OPEN/ACKNOWLEDGED → DISMISSED (reason required). `SOS_ACTIVATED` and `INCIDENT_CRITICAL` cannot be dismissed; they must be resolved. Alerts are never deleted (Revision 1 §42).

### 12.3 Noise control

- While an alert of the same kind for the same subject is open, new triggers increase its counter instead of creating new alerts.
- If the same condition returns within 2 minutes of auto-resolving, the previous alert is reopened rather than a new one created (prevents flapping storms).
- Acknowledgement is idempotent: if two supervisors acknowledge at once, the second sees who acknowledged first; no error.

### 12.4 When a shift ends

Shift-scoped condition alerts (left site, tracking disabled, offline, stale, low battery, overrun, started off site) auto-resolve as "shift ended". SOS, incident, missed-shift, missed-checkpoint and suspicious-location alerts stay until a person deals with them.

### 12.5 Who is notified

An organization setting maps each severity to roles and channels. Defaults: CRITICAL — dashboard alarm + push to Supervisors, Dispatchers, Administrators + escalation ladder; HIGH — dashboard + push to Supervisors; MEDIUM and LOW — dashboard only.

Guards cannot change alert state; they can only fix the underlying condition. Every manual alert change is audited.

---

## 13. Notifications

- Channels: push (guard app and supervisor mode), SMS (SOS escalation; D-08), email (invitations and export-ready notices). The live dashboard is not a notification channel but counts toward SOS "NOTIFIED" when it displays the alarm.
- "Sent" never means "seen". For SOS, only a human acknowledgement proves attention (Revision 1 §72).
- Content is lock-screen safe by default: "SOS — Ahmed K. — ABC Warehouse". No coordinates or incident descriptions in push or SMS bodies by default; SMS contains a short link to the alert, which requires sign-in. An organization may turn on coordinates in SOS SMS (setting, default off).
- Guard notifications: shift assigned / changed / cancelled, shift reminder, SOS acknowledged, plus phone-generated "tracking problem" notifications.
- Non-SOS SMS is capped per organization per month; SOS SMS is never capped.

---

## 14. Web dashboard

### 14.1 Navigation

Dashboard · Live Map · Guards · Sites · Shifts · Patrols · Incidents · Alerts · Reports · Settings · Audit Log — each shown only with the required permission. Guard accounts cannot use the dashboard ("Use the mobile app").

### 14.2 Home (exceptions first)

```text
🔴 SOS — Ahmed Khan — ABC Warehouse — 40 s ago      [ ACKNOWLEDGE ]

ACTIVE GUARDS 24   ON SITE 21   OFF SITE 1   STALE/OFFLINE 1   TRACKING PROBLEMS 1
SHIFTS NOT STARTED 2   OPEN INCIDENTS 3   MONITORING: 2 dashboards, 3 supervisor apps

ALERTS (severity, then age)
🔴 SOS activated — Ahmed
🟠 Guard left site — Bilal (12 min outside)
🟡 Checkpoint run incomplete — Hamza (2 of 6 missing)
```

Every number is clickable to the filtered list. An active SOS banner stays at the top until acknowledged.

### 14.3 Live map

Markers follow PROD §8.3; site geofence circles; accuracy circles; clustering when many markers; filters by site, freshness and alert. Clicking a guard shows:

```text
Ahmed Khan
ON DUTY · ABC Warehouse · Shift 20:00–08:00
Last fix: 12 seconds ago · Accuracy: 8 m · Inside site
Battery 64% · App 1.4.2 · No tracking problems
```

Popups render plain text only.

### 14.4 Guard detail

Guard, status, current shift and site, current location and freshness, tracking health (permissions, battery, app version, device), consent version, shift history, patrol history, incidents, alerts.

### 14.5 Location history

- Pick a guard and a shift (or a time range up to 24 h).
- A reason field is present; it is mandatory when the organization requires it (D-21). Viewing writes an audit record before data is shown.
- The route is drawn from server-downsampled points (≤ 2,000 per view, first, last and flagged points always kept); raw points remain available for authorized export.
- Gaps longer than 5 min are drawn as breaks, never as straight lines that imply travel.
- Timestamps, accuracy, flags, geofence circle and shift events are shown; a slider plays back the shift.

Example audit entry: "Supervisor Sarah viewed Ahmed's location history · 2026-10-08 · Reason: operational investigation".

### 14.6 Other pages

Sites (map pin, radius preview, checkpoints, QR print, patrol route editor) · Shifts (list and week calendar by site or guard, bulk create, interventions with reasons) · Incidents and Alerts (filters, timelines, attachments) · Settings (grouped, validated, explained, audited) · Audit Log (Owner only; filters by actor, action, resource, date).

### 14.7 Cross-cutting

- Control-room sessions stay signed in while the tab is open. If the session cannot be renewed, the dashboard shows a blocking "Signed out — live monitoring stopped" screen; it never keeps showing a frozen map.
- If live updates disconnect for more than 10 s, a banner says so; freshness keeps ticking locally; on reconnect the dashboard reloads current state.
- Alerts, SOS acknowledgement and guard detail work on a phone browser (≥ 360 px).
- Site-bound times show in the site timezone with its abbreviation; ages ("12 s ago") use server time.
- Accessibility target WCAG 2.2 AA; status is never conveyed by colour alone.

---

## 15. Reports and exports

### 15.1 Reports

| Report | Contents |
|---|---|
| Attendance | per shift: scheduled and actual start/end, late minutes, early leave, worked duration, status, flags (PROD §6.8) |
| Patrol | per shift and run: required, verified, QR-only, missed checkpoints, completion % = counted ÷ required, flags |
| Incident | reference, type, severity, site, guard, occurred and reported times, status, time to acknowledge, time to resolve |
| Location | per shift: first and last fix, time inside / outside / unknown, excursions with durations (including those detected after sync), longest data gap, route summary |
| Site activity [R2] | per site and date range — proof of service for the security company's client: shifts covered vs scheduled, attendance, patrol completion, incident summary |

Report dates use the site's timezone (organization timezone for multi-site reports); date ranges are inclusive local dates.

### 15.2 Exports

- CSV in V1 (PDF later). Large exports and any export containing location run in the background; the user is notified when ready.
- Download links expire after 15 minutes; files are deleted after 7 days.
- Exports are tenant-scoped, permission-checked and audited; location exports also count as location-history access.
- CSV is UTF-8 with BOM (so Excel shows Urdu correctly) and protected against formula injection (SEC §8).
- Maximum range 92 days per export; one running export per user.

---

## 16. Guard privacy and transparency (user-facing summary of SEC §16)

- Location is collected only during active shifts and an active SOS.
- The guard always sees whether tracking is on; Android shows a persistent notification, iOS shows its location indicator.
- The guard sees their own shift history and, per D-22, their own location trail for their own shifts.
- Nothing else is collected: no contacts, microphone, call logs, other apps, or photo library browsing (gallery access only through the system picker when the guard chooses a photo).
- Retention defaults (product defaults, not legal requirements; legal review required): raw location 90 days, device status 30 days, operational records 12 months, audit logs 24 months.

---

## 17. Store, distribution and review readiness

- Privacy policy, terms of service and support page live before submission; store descriptions explain background location accurately.
- A demo organization with no real people: a reviewer guard account with a **rolling demo shift that is always startable** (re-created daily covering "now − 1 h to now + 11 h"), demo settings that allow starting away from the site, and SOS in drill mode routed only to internal test recipients — a reviewer must never page a real person.
- Review instructions: how to sign in, see the assigned shift, start it, what tracking does, how the dashboard shows it.
- Platform-specific declarations and their lead times are in ARCH §20.

---

## 18. Definition of done (V1)

V1 is not done because the UI looks good or the demo works. It is done when:

- all critical workflows work end to end on staging and production;
- every adversarial test in SEC §18 passes;
- background tracking passes the real-device matrix (ARCH §21.3) with documented results, including manufacturer devices common in the launch market;
- offline mode, out-of-order and duplicate handling are proven;
- GPS accuracy and stale locations are represented honestly everywhere;
- SOS end-to-end works, including offline, escalation, silent-phone setup check and drill mode; the synthetic SOS monitor runs in production;
- QR replay, file access, tenant isolation and authorization are tested;
- audit logs, retention and evidence preservation work;
- migrations, staging, production deployment, monitoring, runbooks work; a backup restore drill has been performed;
- performance targets (ARCH §18.3) are met in load tests;
- privacy policy and guard disclosure are final in every supported language; legal review signed off (human);
- every external approval in ARCH §20 needed for launch is granted; store listings are approved;
- all decisions are closed; no open Critical or High audit findings.

---

## 19. Final principle

The platform must never optimize for the appearance of certainty.

If the system does not know where a guard is: **"Location stale."**
If GPS accuracy is poor: **"Low location accuracy."**
If an SOS has not reached the server: **"Waiting for connection."**
If a checkpoint cannot be verified: **"Unable to verify."**

The system prefers **honest operational state over reassuring UI**. This principle is fundamental to the product.

---

## Appendix A — Product decisions

Status of all items: **OPEN** until the product owner approves. Decision numbers are global across the three documents.

| ID | Question | Options | Recommendation | Needed by |
|---|---|---|---|---|
| D-02 | Guard sign-in method | phone OTP · employee no. + admin-set PIN · both | phone OTP; PIN as per-organization fallback where SMS is unreliable | Phase 1 |
| D-03 | Supervisor scope; may supervisors plan shifts? | org-wide · site-scoped | org-wide; yes | Phase 1 |
| D-04 | How supervisors receive alerts on the move | supervisor mode in the app · web push · SMS only | supervisor mode + SMS for SOS escalation | Phase 5 |
| D-05 | Devices per guard; shared phones | one active device · several | one active device; shared phones via sign-out/sign-in only | Phase 2 |
| D-06 | Offline shift start | allow (provisional) · require online | allow | Phase 3 |
| D-14 | Launch languages | English · English + Urdu · more | English + Urdu if A-01 holds; i18n from the first screen regardless | Phase 2 |
| D-15 | Starting outside the geofence | block · allow and flag | allow and flag | Phase 3 |
| D-16 | Patrol accountability | per shift · per site (shared) | per shift | Phase 7 |
| D-17 | Do QR-only (location unconfirmed) scans count? | yes, labelled · no | yes, labelled "QR only" | Phase 7 |
| D-18 | Incident photos from gallery | camera only · gallery allowed, labelled | allowed, labelled | Phase 8 |
| D-21 | Reason for viewing location history | optional · mandatory · per-organization setting | field always present, optional by default, organization may require | Phase 6 |
| D-22 | Guard sees own location trail | yes · no | yes, own shifts only | Phase 6 |
| D-24 | Checkpoint coordinates calibrated on site with the app | V1 · V1.1 | V1.1; map pin in V1 | Phase 7 |
| D-25 | App distribution | public store listing · private enterprise channels | public listing with demo organization | Phase 10 |

---

## Appendix B — Default settings

All values are per-organization settings unless marked *system*. Changing a setting is validated and audited.

| Key | Default | Bounds / note |
|---|---|---|
| shift.earliest_start_minutes | 30 | 0–120 |
| shift.late_alert_after_minutes | 10 | 1–120 |
| shift.missed_after_minutes | 120 | ≥ late_alert_after |
| shift.auto_end_after_minutes | 60 | 15–240 |
| shift.overrun_alert_after_minutes | 15 | < auto_end_after |
| shift.start_max_fix_age_seconds | 120 | 30–600 |
| shift.start_required_accuracy_m | 100 | flag only |
| shift.require_background_permission | BLOCK | BLOCK · WARN |
| shift.start_outside_geofence | ALLOW_AND_FLAG | ALLOW_AND_FLAG · BLOCK (D-15) |
| shift.reminder_minutes_before | 30 | 0 = off |
| tracking.moving_distance_filter_m | 20 | 10–100 |
| tracking.min_interval_s | 15 | 5–60 |
| tracking.max_interval_s | 60 | 30–300 |
| tracking.stationary_fix_interval_s | 300 | 60–900 |
| tracking.sos_interval_s | 10 | 5–30 |
| tracking.sos_max_hours | 4 | 1–12 |
| sync.upload_interval_s | 60 | 15–300 |
| sync.heartbeat_interval_s | 60 | 30–300 |
| sync.max_offline_age_hours | 168 | *system*; older data rejected |
| freshness.live_max_s | 120 | ≥ 2 × upload interval |
| freshness.stale_after_s | 300 | > live_max |
| freshness.offline_after_s | 600 | > heartbeat × 3 |
| geofence.radius_m | 100 | *system* bounds 50–5,000 |
| geofence.max_usable_accuracy_m | 100 | 20–500 |
| geofence.outside_buffer_m | 25 | 0–200 |
| geofence.departure_persistence_s | 300 | 60–1,800 |
| geofence.departure_min_points | 3 | 2–10 |
| geofence.return_accuracy_m | 50 | |
| checkpoint.radius_m | 30 | *system* bounds 10–500 |
| checkpoint.max_fix_age_s | 30 | 5–120 |
| checkpoint.max_usable_accuracy_m | 50 | 10–200 |
| checkpoint.duplicate_window_s | 300 | 0–3,600 |
| checkpoint.max_plausible_speed_mps | 15 | 2–50 |
| patrol.count_unconfirmed_as_completed | true | D-17 |
| patrol.treat_mock_as_unconfirmed | true | |
| alerts.reopen_suppression_s | 120 | 0–1,800 |
| alerts.incident_high_enabled | true | |
| alerts.routing | see PROD §12.5 | per severity: roles + channels |
| sos.hold_duration_ms | 3000 | *system* |
| sos.escalation | 0 s push+dashboard → 60 s SMS supervisors/admins → 180 s owners + emergency contacts; repeat 120 s | per organization |
| sos.sms_include_coordinates | false | |
| sos.emergency_contacts | [] | phone numbers |
| sos.emergency_call_number | — | used by "Call supervisor" |
| battery.low_alert_pct | 15 | 5–50 |
| privacy.require_history_access_reason | false | D-21 |
| retention.location_days | 90 | legal review |
| retention.device_status_days | 30 | |
| retention.operational_months | 12 | |
| retention.audit_months | 24 | ≥ 12 |
| retention.incident_evidence_window_minutes | 30 | location kept around incidents/SOS |
| notifications.non_sos_sms_monthly_cap | 1,000 | SOS never capped |
| exports.max_range_days | 92 | *system* |

---

## Appendix C — Glossary

| Term | Meaning |
|---|---|
| Tenant / organization | One security company; the isolation boundary |
| Site | A client location guarded by the organization |
| Geofence | The site's circle (centre + radius) |
| Checkpoint | A physical point at a site with a QR label |
| Patrol route / run / visit | Ordered checkpoints / one required execution inside a shift / one scan |
| Fix | One location reading with accuracy |
| Last contact / last fix | When the server last heard from the phone / capture time of the newest usable fix |
| Freshness | LIVE, RECENT, STALE, OFFLINE, UNKNOWN (PROD §8.3) |
| recorded_at / captured_at / received_at | phone clock at capture / server's estimate of true capture time / server receipt time |
| Client event ID | Phone-generated unique ID that makes resubmission harmless |
| Outbox | The phone's durable queue of unsent events |
| QR only | A scan with a valid QR whose location could not be confirmed |
| Drill | An SOS exercise, labelled everywhere |
| Readiness check | Pre-shift phone setup checklist |
| Monitoring coverage | How many dashboards and supervisor apps are connected right now |

