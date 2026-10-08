# Phase 3 — Shifts · PLAN

| | |
|---|---|
| Status | **Approved 2026-10-08** (round 6) |
| Read | PROD §6; ARCH §7, §16 |

## Scope

1. **Schema (migration 0004):**
   - `shifts`, with the overlap exclusion constraint (cancelled shifts excepted) and a 24-hour maximum;
   - `shift_events` (append-only), idempotent per `(shift_id, client_event_id)`.

   The detector sweep reads due shifts across organizations as `system_worker` (read-only policy). Every write happens per organization as `app_runtime` (ARCH §4.5).
2. **State machine** (`packages/domain/shifts`): a pure `transition()` implementing PROD §6.3 exactly. Every other transition is `SHIFT_INVALID_TRANSITION`.
3. **Time** (`packages/domain/time`): site-local date and time → UTC instant in an IANA zone, correct across midnight and DST (ADV-TM01).
4. **API:**
   - list, create, edit (rules by state), and bulk create from a weekly pattern (preview, all or nothing);
   - cancel, manual start, force-end, extend and reopen (reason required, audited);
   - the guard's online start and end, through the PROD §6.4 checks, with server receipt time and idempotency by `clientEventId`;
   - `GET /me/shifts` for the guard app.
5. **Detectors** (worker, every 60 s): SCHEDULED past the start deadline → MISSED; ACTIVE past end + `auto_end_after` → COMPLETED (AUTO_ENDED). Disabling or terminating a guard force-ends their active shift (SEC §5).
6. **Dashboard:** the Shifts page (by day, with a create form in the site's time zone, bulk weekly create with a preview, and supervisor actions).

## Not in this phase

- **Shift alerts** (`SHIFT_NOT_STARTED`, `SHIFT_MISSED`, `STARTED_OFF_SITE`, `SHIFT_OVERRUN`) come with the alert engine, Phase 5.
- **Push notifications to guards** come in Phase 5 too.
- **Offline-synced start and end** arrive with `/sync/batch` in Phase 4, through the same shift service.

## Tests by ID

ADV-SH01 (every state × command × actor), SH02 (double tap), SH03 (overlap: API and constraint), SH04 (auto-end), SH05 (phone failsafe: the deadline the phone gets from the server), SH06 (late offline start after MISSED, through the service), A03 (another guard's shift → 404), T07 (a job for A can't touch B), TM01 (overnight and DST), TM03 (the phone clock never decides).
