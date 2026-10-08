# Phase 5 — Geofence and alerts · REPORT

| | |
|---|---|
| Date | 2026-10-08 |
| Result | **Core built.** `pnpm verify` passes: all 13 checks, including the dependency audit; 49 test files, 376 tests; 83 IDs cited. |
| Commit | Local only (round 6). |

## What was built

- **Schema (migration 0006):**
  - `alerts`: one open alert per `(organization, dedupe_key)` through a partial unique index; composite FKs to guard, site and shift; checks that a resolved alert has a resolution type, a dismissed one a reason, and that SOS and critical-incident alerts are never DISMISSED.
  - `alert_events`: append-only.
  - Geofence memory on `shift_live_state` (excursion start, outside count, inside streak, watermark).
  - An index on device reports per shift.
- **Pure rules** (`packages/domain`):
  - `geofence.ts`: the PROD §8.4 state machine. Unusable fixes never change state; a departure needs N outside fixes over the persistence time with no inside fix; a return needs one accurate inside fix or two consecutive inside fixes.
  - `alerts.ts`: the catalog with severities, dismissibility and shift scope; dedupe keys; freshness, tracking-disabled and battery conditions.
- **Alert engine** (`apps/api/src/services/alerts.ts`):
  - `raiseAlert` (events) counts a repeat on the open alert (AL01), reopens one that cleared within `alerts.reopen_suppression_s`, or opens a new one. A concurrent opener is handled by the unique index plus a retry.
  - `ensureAlert` (detector conditions) does nothing when the alert is already open, and leaves an episode a person closed closed.
  - `clearAlert`, `resolveShiftAlerts` (PROD §12.4), and `onShiftChanged`, called by every shift status path.
  - Acknowledge (idempotent; the row is locked, so the first person is kept: AL03), resolve, and dismiss (reason required; never SOS or critical incidents: AL02).
- **Geofence evaluator** (`services/geofence.ts`): runs per shift after each sync batch's points are stored, in capture order after the watermark. It writes LEFT_SITE and ENTERED_SITE shift events (no coordinates), and opens or resolves GUARD_LEFT_SITE with the time spent outside. An excursion that starts and ends within one delivery is history only (`detectedAfterSync`).
- **Detectors** (worker, every 60 s, per organization as `app_runtime`):
  - DEVICE_OFFLINE, then LOCATION_STALE on two consecutive runs, suppressed while offline;
  - SHIFT_OVERRUN;
  - SHIFT_NOT_STARTED;
  - a safety net that closes condition alerts on shifts that are no longer active, and NOT_STARTED alerts whose shift started, was cancelled or was moved.
- **Other triggers:**
  - shift start outside the geofence → STARTED_OFF_SITE, cleared when the guard is seen inside;
  - MISSED → SHIFT_MISSED, which supersedes NOT_STARTED;
  - a late offline start clears MISSED;
  - device reports → TRACKING_DISABLED and LOW_BATTERY;
  - mock or implausible points → SUSPICIOUS_LOCATION.
- **Sync fixes found by the guard-app build:**
  - a quarantined SHIFT_START makes the rest of that shift's items RETRY instead of being rejected and lost;
  - the reply lists every shift the batch mentions.

  Neither has a dedicated test yet: a quarantine needs an injected server error.
- **API:** `GET /alerts` (active, closed, all; optionally by shift), `GET /alerts/:id` with its history, and `POST /alerts/:id/acknowledge`, `/resolve` and `/dismiss`, each audited. New error code `ALERT_INVALID_TRANSITION` (409).
- **Dashboard:** the Alerts page.
  - Counts by severity; active alerts by severity, then age.
  - Time outside for departures; "detected after sync"; who acknowledged.
  - Acknowledge, resolve with an optional note, and dismiss with a required reason, each shown only with the permission. There is no dismiss for SOS.
  - Works at phone width.
- **Settings:** two cross-field rules added (DECISIONS, Phase 5), because the property test showed the existing rules let a healthy phone trip alerts.

## Tests by ID

| ID | Test |
|---|---|
| ADV-G01 | `packages/domain/test/geofence.test.ts`: a single outside point raises nothing |
| ADV-G02 | domain: sustained outside → exactly one LEFT_SITE; `apps/api/test/alerts.test.ts`: through sync, exactly one GUARD_LEFT_SITE |
| ADV-G03 | domain: flapping across the boundary never confirms |
| ADV-G04 | domain: poor or unknown accuracy, or outside but within accuracy, causes no departure |
| ADV-G05 | domain: one accurate or two mediocre inside fixes; API: the alert resolves with 8 minutes outside |
| ADV-G06 | domain: no new fixes while inside → the state stays inside |
| ADV-L07 | domain: 5 m and 50 m count; 500 m and unknown never change the state |
| ADV-L11 | API: mock points stored with the flag; one SUSPICIOUS_LOCATION counting repeats |
| ADV-AL01 | API: a repeat counts on the open alert; reopens within the window; new after it |
| ADV-AL02 | API: a dispatcher cannot resolve or dismiss; supervisors and admins cannot dismiss an SOS; a reason is required |
| ADV-AL03 | API: two concurrent acknowledgements both 200, same first person, one audit record |
| ADV-AL04 | API: a guard ends the shift → DEVICE_OFFLINE resolves as "shift ended"; SOS and SHIFT_MISSED stay open |
| ADV-AL05 | API: every valid combination of heartbeat, upload, moving and stationary intervals on a grid, filtered by the real settings validator and with every threshold at its minimum: a healthy phone at its worst moment trips neither freshness alert |
| — | DEVICE_OFFLINE opens after 10 min and once only; contact clears it; contact without a new fix → LOCATION_STALE, cleared by a fix |
| — | TRACKING_DISABLED follows device reports; SHIFT_NOT_STARTED, then SHIFT_MISSED supersedes it |
| — | `GET /alerts` never lists another organization's alerts; ADV-T01 covers the four `:id` routes |
| — | RLS (ADV-T06) covers `alerts` and `alert_events` automatically through the registry |

## Not done

- Web push to dashboard users and push to guards (the D-26 provider), the escalation ladder, notification deliveries, and `POST /alerts/:id/seen` and `/delivered`. These go with SOS in Phase 8, because the pilot keeps SOS off.
- CHECKPOINT_MISSED (Phase 7), INCIDENT_CRITICAL and INCIDENT_HIGH (Phase 8), DEVICE_CHANGED.
- Alerts on the Live map and the Overview page; the realtime stream (Phase 6) replaces polling.
- A test for the RETRY-after-quarantine path (needs an injected server error).
- Phase 4's server items (ADV-A08, P05, X05, the attendance report) were finished after this phase's core; see `phase-4/REPORT.md`.
