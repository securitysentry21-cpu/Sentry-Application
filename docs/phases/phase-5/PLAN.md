# Phase 5 — Geofence and alerts · PLAN

| | |
|---|---|
| Date | 2026-10-08 |
| Go-ahead | Round 6: "go ahead with all of the phases that we can build" |
| Read | PROD §8.3–8.4, §12; ARCH §6.3, §10, §13.2; SEC ADV-G01–G06, AL01–AL05 |
| Exit IDs | ADV-G01–G06, AL01–AL05 |

## Scope

- **Schema (migration 0006):**
  - `alerts`, with a partial unique index on open dedupe keys and composite FKs to guard, site and shift;
  - `alert_events` (append-only);
  - the geofence evaluator's memory on `shift_live_state`.
- **Pure rules** (`packages/domain`):
  - the geofence state machine (PROD §8.4);
  - the alert catalog and dedupe keys;
  - the freshness, tracking-disabled and battery conditions.
- **Alert engine** (`apps/api/src/services/alerts.ts`):
  - raise, which counts repeats and reopens within the suppression window;
  - ensure, for detector conditions;
  - clear;
  - auto-resolve at shift end;
  - acknowledge (idempotent), resolve, and dismiss (a reason is required; never for SOS or critical incidents).
- **Geofence evaluator,** run with each sync batch: GUARD_LEFT_SITE opens and resolves, ENTERED_SITE and LEFT_SITE shift events are written, and late excursions are kept as history only.
- **Detectors,** every 60 s in the worker: DEVICE_OFFLINE, LOCATION_STALE, SHIFT_NOT_STARTED and SHIFT_OVERRUN, plus a shift-end safety net.
- **Shift hooks:** STARTED_OFF_SITE; SHIFT_MISSED, which supersedes NOT_STARTED; a late start clears MISSED; a shift end resolves its condition alerts.
- **Device reports** drive TRACKING_DISABLED and LOW_BATTERY. Mock or implausible points open SUSPICIOUS_LOCATION.
- **API:**
  - `GET /alerts`, `GET /alerts/:id`;
  - `POST /alerts/:id/acknowledge`, `POST /alerts/:id/resolve`, `POST /alerts/:id/dismiss`, each audited.
- **Dashboard:** the Alerts page, phone-width friendly, with active and closed views and actions by permission.

## Not in this phase

Web push and push to guards, the escalation ladder and notification deliveries (Phase 8, with SOS), CHECKPOINT_MISSED (Phase 7), INCIDENT_* (Phase 8), DEVICE_CHANGED.
