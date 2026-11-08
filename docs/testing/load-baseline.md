# Load baseline (ARCH §18.3, §19.2)

**What this is.** A baseline from `pnpm load`: simulated guard phones going through the real API (enrolled devices, real sessions, the real sync pipeline, PostgreSQL with row-level security), in one process, on the owner's Windows computer, against an embedded PostgreSQL. It measures **this computer**: one database, one API process, no network, no TLS, the harness itself competing for the same processor. It is a baseline and a regression guard. It is **not** a statement about production, whose infrastructure is separate and larger. The ARCH §18.3 targets are compared only where the run was as large as the target's own wording.

**Run:** 2026-11-08 · commit 98af362 plus the uncommitted Phase 10 work · 200 phones, 100 guards on a 15-minute night, 8 uploads in flight, the API's own database pool (10 connections, 5 s wait) · `pnpm load` (default size).

## Results

| Scenario                | Measure                                                                     | Result                   | Target                      | Verdict         |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------ | --------------------------- | --------------- |
| Setup                   | 200 guards enrolled, shift created and started                              | 18.2 s                   | —                           | info            |
| Reconnection storm      | 200 phones × 120 items (a 60-minute backlog each), drained                  | 137.2 s                  | 1,000 phones within 2 min   | not comparable  |
| Reconnection storm      | items stored of items sent                                                  | **24,000 of 24,000**     | all                         | **within**      |
| Reconnection storm      | batch latency, 400 batches of up to 100 items, 8 in flight: p50 / p95 / max | 2,209 / 5,469 / 6,860 ms | p95 ≤ 300 ms (normal load)  | info (queueing) |
| Session renewal         | 200 renewals, p95                                                           | 155 ms                   | —                           | info            |
| Dashboard snapshot      | 200 active guards, 20 requests, p95                                         | 56 ms                    | p95 ≤ 1 s with 1,000 active | not comparable  |
| Normal night            | 100 guards × 15 min, 1,500 batches of 2 items (8 in flight), p95            | 324 ms (38 s wall)       | —                           | info            |
| Normal night            | items stored of items sent                                                  | **3,000 of 3,000**       | all                         | **within**      |
| Sync batch of 100 items | 20 batches one at a time: p50 / p95                                         | **730 / 787 ms**         | p95 ≤ 300 ms                | **above**       |
| Offline 30 minutes      | 60 items in one upload, all stored                                          | 60 of 60 · 445 ms        | all                         | within          |
| Guard leaves the site   | 10 minutes outside the circle: "left site" alert for that guard only        | yes                      | alert for the one guard     | within          |
| SOS under load          | 10 presses, receipt → event for the dashboard, p95                          | 982 ms                   | p95 ≤ 2 s                   | within          |
| SOS under load          | 10 presses, receipt → first provider-accepted push, p95                     | 1,122 ms                 | p95 ≤ 10 s                  | within          |
| Server errors           | sync answers of 5xx that a phone retried                                    | 0                        | —                           | info            |

The SOS timings include the worker loops at their real cadence (outbox every 0.5 s, sender every 1 s) in the same process; the push provider is a fake that accepts at once.

## What it tells us

1. **Nothing was lost.** Every item sent was stored exactly once (24,000 and 3,000), including after a 60-minute backlog from every phone at once. This is the property that matters most, and it holds.
2. **A 100-item batch takes about 0.73 s here, 2.4 times the 300 ms target.** One batch at a time, no contention. That is roughly 7 ms per item, which fits one round trip for each of several statements per item (a savepoint, the insert, the live-state update, the checks). On production hardware the database is across a network, which adds to a per-item round trip, so this is likely to be **worse, not better**, unless the work is batched. This is the first thing to fix before the real load test: insert a batch's location points in one statement and take fewer savepoints. The generated idempotency and out-of-order tests (ADV-L, ADV-X06) are what make that change safe to attempt.
3. **Throughput on this machine was about 175 items a second** (24,000 items in 137 s). A storm of 1,000 phones with an hour of backlog each is 120,000 items; at this rate that is about 11 minutes against a target of 2. Production runs several API tasks and a separate database, so this is not a prediction, but it says how much headroom the per-item work needs: **a production-sized run (one of the PLAN's open items) must show about six times this throughput** across the tasks, or the per-item cost must come down.
4. **Under 16 uploads at once the API's 10-connection pool ran out and answered 500** (seen in earlier runs of this harness; the default here is 8 in flight, which did not trip it). A phone retries with backoff, so nothing is lost, but a saturated pool should answer 503 with a `Retry-After`, not 500, and an alarm on it should say "saturated", not "bug". Not changed yet.
5. **The SOS path is fast and stays fast under this load**: under a second to the dashboard and about a second to the first push (against 2 s and 10 s targets).

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
