# Phase 3 — Shifts · REPORT

| | |
|---|---|
| Date | 2026-10-08 |
| Result | **Built.** `pnpm verify` passes: 13 checks, 27 test files, 171 tests; every ID due through Phase 3 has a test (37 IDs traced). |
| Commit | Local only (round 6). |

## What was built

- **Schema (migration 0004):**
  - `shifts`, with the overlap exclusion constraint (cancelled shifts excepted), the 24-hour limit, the start fix and its geofence class, flags, and end reasons;
  - `shift_events` (append-only), idempotent per `(shift_id, client_event_id)`.

  The detector sweep reads six columns of due shifts as `system_worker` under a read-only policy. Every change is made per organization as `app_runtime`.
- **State machine** (`packages/domain/shifts`): a pure `transition()`, exactly the PROD §6.3 table. Each command has one permitted actor, and everything else is `SHIFT_INVALID_TRANSITION`.
- **Site time** (`packages/domain/time`): local date and time → UTC in an IANA zone, overnight and across DST changes. A skipped local time resolves forward; an ambiguous one resolves to its first occurrence.
- **API:**
  - list (overlapping a period of at most 62 days), create, and edit (time, guard and site only while SCHEDULED; notes always);
  - bulk weekly pattern in the site's time zone, with a preview and all or nothing;
  - cancel, manual start, force-end, extend and reopen, each with a required reason and audited;
  - the guard's online start and end, running the PROD §6.4 checks in order:
    - another guard's shift is 404;
    - state and start window, by server time;
    - one active shift at a time;
    - a fresh fix;
    - "always" plus precise permission (BLOCK or WARN);
    - low accuracy and mock locations flagged;
    - off-site allowed and flagged (D-15).

    Rejected attempts are recorded as `START_REJECTED` without coordinates.
  - `GET /me/shifts` for the guard app.
- **Detectors** (`apps/api/src/worker.ts`, every 60 s): MISSED after the start deadline; AUTO_ENDED at end + `auto_end_after`. Disabling or terminating a guard force-ends an active shift (`GUARD_DISABLED`).
- **Dashboard:** the Shifts page:
  - a day view in local time with counts by status;
  - supervisor actions with reason prompts;
  - create in the site's time zone, where an end at or before the start means the next day;
  - a weekly pattern with a conflict preview.

## Tests by ID

| ID | Where |
|---|---|
| ADV-SH01 | `packages/domain/test/shifts.test.ts`: all 150 state × command × actor combinations |
| ADV-SH02 | `shifts.test.ts`: two simultaneous starts with one client event ID give one STARTED event |
| ADV-SH03 | `shifts.test.ts`: API `SHIFT_OVERLAP` and the database exclusion constraint |
| ADV-SH04 | domain (exact instant) and `shifts.test.ts` (detector) |
| ADV-SH05 | `shifts.test.ts`: the server half, the deadline the phone gets. The phone's own failsafe is in `apps/mobile` |
| ADV-SH06 | domain, and `shifts.test.ts` through the service: MISSED → ACTIVE with LATE_SYNC |
| ADV-A03 | `shifts.test.ts`: start, end and the shift list of another guard |
| ADV-T07 | `shifts.test.ts`: a detector job for A leaves B's shift untouched |
| ADV-TM01 | domain (Karachi; London across the October DST change) and bulk create |
| ADV-TM03 | `shifts.test.ts`: a forged phone time decides nothing; the server time is recorded |

## Found and fixed

The lint rule caught raw SQL in the detector worker (ARCH §4.2); it moved into a repository (`repositories/sweeps.ts`). This is the lint step working as a security control.

## Not in this phase

- **Shift alerts and guard push notifications:** Phase 5 (alert engine and push).
- **Offline-synced start and end:** Phase 4, through `/sync/batch` and the same `guardStart` and `guardEnd`.
- **Deployment:** the worker is a second process (`node apps/api/src/worker.ts`) with `SWEEP_DATABASE_URL` set to the `system_worker` connection.
