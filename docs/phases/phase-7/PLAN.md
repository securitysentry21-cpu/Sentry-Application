# Phase 7 — Patrols · PLAN

| | |
|---|---|
| Date | 2026-11-02 |
| Go-ahead | The owner, 2026-11-02: "Go ahead with Phase 7", after reading how scanning will work |
| Read | PROD §5.3–§5.4, §7.6–§7.7, §9, §12, §14; ARCH §6.3, §8.6, §11, §13.2, §15, §16; SEC §9, §16, §17, §18.6; D-16, D-17, D-24 |
| Exit IDs | ADV-Q01–Q09, T08 |

Phase 4's device tests are still open, so `status.json` stays at Phase 3, as for Phases 5 and 6. The owner approved D-16 (runs per shift), D-17 (QR-only scans count, labelled) and D-24 (map pin in V1) on 2026-11-02.

What exists already: checkpoints with QR tokens, printing and rotation (Phase 2); the `CHECKPOINT_SCAN` sync item, held on the phone until `features.patrols` is on (Phase 4); the camera permission and a QR scanner in the guard app (enrollment); the `CHECKPOINT_MISSED` alert type (Phase 5).

## Scope

- **Schema (migration 0008):**
  - `patrol_routes`: an ordered set of checkpoints at one site, on demand or every *I* minutes with a completion window *W* ≤ *I* (so a route's runs never overlap);
  - `patrol_route_checkpoints`: order and "required", with composite keys that make the database refuse a route and checkpoint from different sites or organizations;
  - `patrol_runs`: one required round inside a shift (D-16);
  - `checkpoint_visits`: one scan and its result, append-only (INV-05). The scanned token is never stored, and coordinates only inside an active shift window (INV-08, enforced by a check constraint).
- **Verification** (ARCH §11.2) as a pure function in `packages/domain`, in the spec's order: INVALID_QR, NO_ACTIVE_SHIFT, WRONG_SITE, DUPLICATE, then location (VERIFIED / OUTSIDE_RADIUS / LOCATION_UNCONFIRMED), implausible travel, and whether it counts (D-17 setting). Flags: MOCK_LOCATION, IMPLAUSIBLE_TRAVEL, SKEWED_CLOCK, LOW_ACCURACY, OUT_OF_ORDER.
- **Scans arrive through `POST /sync/batch`**, in the main lane, online and offline alike. The sync reply carries each scan's outcome, so the phone can show it.
- **Runs:**
  - generated when a shift starts, for each active scheduled route at its site: run *k* is due at actual start + offset + *k*·*I* and closes at due + *W*, while due is before the scheduled end;
  - regenerated for the future when the shift is extended or a route changes;
  - progress updated with each scan: PENDING → IN_PROGRESS → COMPLETED;
  - closed by a worker job every 60 s (INCOMPLETE or MISSED) and at shift end (CANCELLED if not yet due);
  - one `CHECKPOINT_MISSED` alert per incomplete or missed run, naming the missing checkpoints.
- **API:**
  - `GET/POST /sites/:id/patrol-routes`, `PATCH /patrol-routes/:id` (`patrols.read` / `patrols.write`, audited `PATROL_ROUTE_CREATED` / `PATROL_ROUTE_UPDATED`);
  - `GET /patrol-runs` (filters: shift, site, guard, status, dates), `GET /patrol-runs/:id`, `GET /checkpoint-visits?shiftId=` (`patrols.read`). They return distances and accuracy, never guard coordinates;
  - `GET /me/patrols?shiftId=` for the guard's own shift (`patrols.read.assigned`): runs, checkpoints in order, what is done;
  - `features.patrols` on in `/mobile/config`;
  - the scan rate limit, 60 per guard per minute (SEC §9).
- **Guard app:** a Patrol screen from the active shift (rounds, due times, next checkpoint, progress), the existing scanner reused for checkpoint labels, a fresh fix with each scan (≤ 10 s, temporary full accuracy on iOS), and the result as PROD §7.7 words it, including "Saved — will verify when online". English and Urdu.
- **Dashboard:**
  - Sites: a checkpoint editor with a map pin, a radius preview, description and status, plus a patrol route editor (schedule, window, order, required checkpoints);
  - a Patrols page: runs by date, site, guard and status; a run's checkpoints, scans, outcomes and flags;
  - guard detail: patrol history;
  - plain text only (ADV-W01).
- **Demo:** `pnpm demo` gets checkpoints and a route at its main site, and demo guards walk the rounds, with one missed round.

## Tests

- **Domain:** verification outcomes and their order, run schedule maths, run status, implausible travel, out-of-order.
- **API:** ADV-Q01–Q09 and T08 by name; run generation, completion, the closer, shift end, extension and route changes; route validation and audit; the guard endpoint's ownership; the rate limit.
- **Database:** the new tables join the generated cross-tenant read test (ADV-T06) and the schema linter; ADV-T04 gains a route that points at another organization's checkpoint, through the API and at the database layer.
- **Guard app:** a scan online, offline and rejected, with the outcome on the receipt.
- **Dashboard:** checkpoint and route names render as text (ADV-W01).

## Not in this phase

- The "Checkpoint problem" button: it files an incident, so it comes with incidents (Phase 8).
- The patrol report and CSV (Phase 9, reports).
- Calibrating a checkpoint's position on site with the app (D-24: V1.1).
- Push notifications about rounds (with push, Phase 8).
