# Phase 6 — Live operations dashboard · PLAN

| | |
|---|---|
| Date | 2026-11-01 |
| Go-ahead | The owner, 2026-11-01: "can you start working on phase 6 aswell to save time?" |
| Read | PROD §8.3, §11.5, §14; ARCH §6.3, §14, §15.3, §16; SEC §16.4, §17; D-09, D-12 (revised), D-21, D-32 |
| Exit IDs | ADV-T02, A04, W01, P02, U01 |

Phase 4's device tests are still open, so `status.json` stays at Phase 3, as it did for Phase 5. Tracking on real phones is still unproven. Phase 6 is dashboard work, so it doesn't depend on those results.

## Scope

- **Schema (migration 0007):**
  - `outbox`: side effects written in the business transaction (ARCH §16.1);
  - `realtime_events`: the replay buffer, written only by the dispatcher, with a per-organization sequence (ARCH §14);
  - `stream_connections`: one row per open stream, for monitoring coverage (PROD §11.5).
- **Events.** Each change writes an outbox row in its own transaction:
  - `guard.state`: a sync batch updated a shift's live state;
  - `alert.opened` and `alert.updated`: every alert state change;
  - `shift.updated`: every shift status change;
  - `coverage.updated`: a stream opened or closed.
- **Outbox dispatcher** (worker, every 500 ms). It finds organizations with pending rows as `system_worker`, then moves each organization's rows into `realtime_events` as `app_runtime`, under a per-organization lock that assigns the sequence after commit. It then sends `NOTIFY` with IDs only, and prunes the buffer to 5 min / 10,000 events.
- **Stream** `GET /api/v1/stream` (SSE, `live.read`):
  - the request pipeline resolves the organization from `X-Organization-Id`;
  - it replays from `Last-Event-ID`, or sends `resync` when that is outside the buffer;
  - a keep-alive every 25 s;
  - the session and membership are re-checked every 30 s (ADV-T02: closed within 60 s), and every stream is cycled after 30 min;
  - each API instance runs one `LISTEN` connection and fans events out per organization and permission.
- **Snapshot** `GET /dashboard/snapshot` gains:
  - `lastEventId`, so the stream starts exactly where the snapshot ends;
  - on-site state;
  - home counts (shifts not started, tracking problems);
  - monitoring coverage.
- **Guard detail:**
  - `GET /guards/:id/location`: live state, `live.read`, current positions only;
  - consent version;
  - recent shifts and alerts (`GET /alerts?guardId=`).
- **Location history** `GET /guards/:id/location-history?shiftId=|from=&to=&reason=` (`location.history.read`):
  - `LOCATION_HISTORY_VIEWED` is audited in the same transaction, before the points are read (INV-14, ADV-P02);
  - a reason is required when `privacy.require_history_access_reason` is on (D-21);
  - ranges are a shift, or up to 24 h;
  - points are downsampled on the server to ≤ 2,000, keeping the first, last, flagged and gap-edge points;
  - gaps over 5 min are marked as breaks;
  - the response includes the site boundary and shift events.
- **Dashboard:**
  - a realtime client (`fetch` streaming, so the organization header is sent as on every other request), with a "live updates disconnected" banner after 10 s and a snapshot reload on reconnect (PROD §14.7);
  - the Live map: clustering, accuracy circles, filters (site, freshness, alerts) and a plain-text guard panel;
  - the exceptions-first home with monitoring coverage;
  - guard detail;
  - the location history viewer, with a reason field, breaks at gaps and a playback slider;
  - phone width (≥ 360 px) throughout.
- **Demo:** `pnpm demo` can seed 1,000 guards, to check the map at pilot scale.

## Not in this phase

- Location exports (Phase 9, with exports). ADV-A04's export half is tested there.
- Web push and the SOS banner (Phase 8).
- The guard's own trail in the app: D-22, rejected by the owner on 2026-11-01, so never built.
- Open incidents on the home page (Phase 8).
