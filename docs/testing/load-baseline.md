# Load baseline (ARCH §18.3, §19.2)

**What this is.** Numbers from `pnpm load`: simulated guard phones going through the real API (enrolled devices, real sessions, the real sync pipeline, PostgreSQL with row-level security), in one process, on the owner's Windows computer, against an embedded PostgreSQL. It measures **this computer**: one database, one API process, no network, no TLS, the harness competing for the same processor. It is a baseline and a regression guard. It is **not** a statement about production, whose infrastructure is separate and larger. The ARCH §18.3 targets are compared only where the run was as large as the target's own wording.

**Setup of both runs:** 2026-11-08 · 200 phones, 100 guards on a 15-minute night, 8 uploads in flight, the API's own database pool (10 connections, 5 s wait) · `pnpm load` at its default size.

## Run 1 found a problem, run 2 is after the fix

Run 1 showed a 100-item sync batch taking 0.73 s, 2.4 times the 300 ms target. The cause was the number of database round trips: about 7 for each position and 4 for each heartbeat, in one transaction, so some 700 for a batch of 100. The fix (`apps/api/src/services/sync.ts`, `BatchLive`) keeps the same behavior with far fewer questions:

- a shift is read once per batch (and again after a start or an end in the batch);
- the shift's previous fix is read once and then kept in memory with the database's own rule (a fix replaces the last one only if it was captured later, ADV-L06);
- the live-state updates (contact time and last fix) only move forward and every item of a batch carries the same received time, so they are written once per shift at the end, before the geofence looks;
- no savepoint per item on the normal path. If anything throws, the batch rolls back and runs again item by item with savepoints, so one bad item is still quarantined alone (ADV-O09).

Three new tests for what the changes touch (a jump inside one batch, the live state after out-of-order points, a start and its points in one batch) **pass on both the old and the new code**, which is the evidence that the behavior did not change.

| Measure                                            | Run 1 (before)                    | Run 2 (after)                     | Target                        |
| -------------------------------------------------- | --------------------------------- | --------------------------------- | ----------------------------- |
| Sync batch of 100 items, one at a time, p50 / p95  | 730 / 787 ms                      | **109 / 119 ms**                  | p95 ≤ 300 ms (**now within**) |
| Reconnection storm: 200 phones × 120 items drained | 137.2 s                           | **24.9 s**                        | 1,000 phones in 2 min         |
| Storm: batch latency with 8 in flight, p50 / p95   | 2,209 / 5,469 ms                  | 496 / 942 ms                      | — (queueing)                  |
| 60 items after 30 minutes offline, one upload      | 445 ms                            | 86 ms                             | —                             |
| Items stored of items sent (storm / night)         | 24,000 of 24,000 / 3,000 of 3,000 | 24,000 of 24,000 / 3,000 of 3,000 | all                           |
| Session renewal, p95                               | 155 ms                            | 76 ms                             | —                             |

## Run 2 in full

| Scenario                | Measure                                                                     | Result               | Target                      | Verdict         |
| ----------------------- | --------------------------------------------------------------------------- | -------------------- | --------------------------- | --------------- |
| Setup                   | 200 guards enrolled, shift created and started                              | 17.7 s               | —                           | info            |
| Reconnection storm      | 200 phones × 120 items (a 60-minute backlog each), drained                  | 24.9 s               | 1,000 phones within 2 min   | not comparable  |
| Reconnection storm      | items stored of items sent                                                  | **24,000 of 24,000** | all                         | **within**      |
| Reconnection storm      | batch latency, 400 batches of up to 100 items, 8 in flight: p50 / p95 / max | 496 / 942 / 1,150 ms | —                           | info (queueing) |
| Dashboard snapshot      | 200 active guards, 20 requests, p95                                         | 62 ms                | p95 ≤ 1 s with 1,000 active | not comparable  |
| Normal night            | 100 guards × 15 min, 1,500 batches of 2 items (8 in flight), p95            | 341 ms (37 s wall)   | —                           | info            |
| Normal night            | items stored of items sent                                                  | **3,000 of 3,000**   | all                         | **within**      |
| Sync batch of 100 items | 20 batches one at a time: p50 / p95                                         | **109 / 119 ms**     | p95 ≤ 300 ms                | **within**      |
| Offline 30 minutes      | 60 items in one upload, all stored                                          | 60 of 60 · 86 ms     | all                         | within          |
| Guard leaves the site   | 10 minutes outside the circle: "left site" alert for that guard only        | yes                  | alert for the one guard     | within          |
| SOS under load          | 10 presses, receipt → event for the dashboard, p95                          | 791 ms               | p95 ≤ 2 s                   | within          |
| SOS under load          | 10 presses, receipt → first provider-accepted push, p95                     | 1,260 ms             | p95 ≤ 10 s                  | within          |
| Server errors           | sync answers of 5xx that a phone retried                                    | 0                    | —                           | info            |

The SOS timings include the worker loops at their real cadence (outbox every 0.5 s, sender every 1 s) in the same process; the push provider is a fake that accepts at once.

## What it tells us

1. **Nothing was lost**, in either run: every item sent was stored exactly once, including a 60-minute backlog from every phone at once.
2. **The 100-item batch target is met here, by a wide margin** (109 ms against 300 ms). Production puts the database across a network, which adds to each round trip; the fix cut the round trips by about six times, which is what protects that margin.
3. **Throughput on this machine is now about 960 items a second** (24,000 items in 24.9 s). A storm of 1,000 phones with an hour of backlog each is 120,000 items: about two minutes on this one computer, the target's own number. Production runs several API tasks and a separate database, so this is not a prediction; the production-sized run is still the test that counts.
4. **Under 16 uploads at once the API's 10-connection pool ran out and answered 500** (seen in earlier runs of this harness, before the fix; 8 in flight did not trip it). A phone retries with backoff, so nothing is lost, but a saturated pool should answer 503 with a `Retry-After`, not 500, so that an alarm can say "saturated" and not "bug". **Changed since** (Fable pass 2, L-27): a request that finds no free connection answers `503 NOT_READY` with `Retry-After: 5` (an SOS without one), and the SOS routes have their own 3 connections (`apps/api/src/server.ts`), proven by `apps/api/test/sos-capacity.test.ts`. The figures above were measured before.
5. **The SOS path stays fast under this load**: under a second to the dashboard and about a second to the first push (against 2 s and 10 s).

## Not measured yet

- **500 dashboard streams.** Each browser needs its own sign-in and a stream is limited to 10 per user, so it needs a real listening server and many sessions.
- **A production-sized run:** a separate database host, several API tasks, TLS and a load balancer in the path, and 1,000 phones with the full 60-minute night. `LOAD_PHONES=1000 LOAD_NIGHT_MINUTES=60 pnpm load` runs the full wording on this computer if a single-machine figure is wanted.

## Run it again

```bash
pnpm load                                                   # 200 phones, a 15-minute night
LOAD_PHONES=1000 LOAD_NIGHT_MINUTES=60 pnpm load            # the scenarios at their full wording
LOAD_CONCURRENCY=16 LOAD_POOL=10 pnpm load                  # more uploads in flight than the pool can serve
```

The report is printed and written to `.local/load-report.md`. Do not run anything else heavy meanwhile: the harness shares the computer with the database it measures.
