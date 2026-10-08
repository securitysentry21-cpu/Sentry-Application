# Phase 4 — Mobile location subsystem · PLAN

| | |
|---|---|
| Status | **In progress.** The server core is built and tested. `status.json` stays at Phase 3 until every Phase 4 exit ID has a test. |
| Read | PROD §6.5–6.6, §7.4–7.6, §8; ARCH §8–9 |

## Built so far (2026-10-08)

- **Schema (migration 0005):**
  - `location_points` and `device_status_events`: append-only, idempotent per device and client event;
  - `shift_live_state`: a projection that only moves forward;
  - `quarantined_items`.
- **`POST /sync/batch`:**
  - one transaction, one savepoint per item, items in order;
  - SHIFT_START and SHIFT_END through the Phase 3 shift service: online within 30 s of capture, otherwise offline with the estimated capture time;
  - LOCATION checked against the shift window (rejected and not stored outside it), with flags (accuracy, mock, implied speed, clock skew);
  - HEARTBEAT and DEVICE_STATUS;
  - an unexpected error in one item quarantines it alone.
- **Capture time** (`packages/domain/tracking`): a monotonic estimate when the item's `bootId` matches the batch's (contract updated), the phone clock otherwise; always clamped to receipt; skew flagged.
- **`GET /dashboard/snapshot`:** tracking health and location age as separate signals (D-36).
- **The Live map page:** guards coloured by health, last-known positions hollow, recomputed every second against server time. Polling now; SSE comes in Phase 6.

## Tests so far

ADV-L01, L02, L03, L04, L05, L06, L08, L09, L10, O03, O09, P01, U01, U04, X06.

## Still to do for the exit

- ADV-L07 (geofence by accuracy band, with the evaluator) and L11 (mock locations → SUSPICIOUS_LOCATION, with the alert engine), both in Phase 5.
- ADV-L12 (429 storms: phone respects Retry-After).
- ADV-O01, O02, O04–O08, U02 and U03: phone-side, in `apps/mobile` tests plus human device tests.
- ADV-A08 (a REPLACED device's pending uploads accepted for 72 h).
- ADV-P05 (generated over every item type that carries coordinates).
- ADV-X05 (route meta-test: coordinate-returning routes declare live-only scope or an audit action).
- The attendance report.
- Pilot 0 readiness: a deployed cell (AWS account), device tests on the pilot's phones (human), and the legal review.
