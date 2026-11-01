# Phase 6 — Live operations dashboard · REPORT

| | |
|---|---|
| Date | 2026-11-01 |
| Result | **Built.** `pnpm verify` passes: all 13 checks; 57 test files, 431 tests; 90 IDs cited. Phase 6's exit IDs (ADV-T02, A04, W01, P02, U01) each have a passing test. The visual check at 1,000 guards is still for a person. |
| Commit | Not committed; waiting for the owner. |

## What was built

- **Schema (migration 0007):**
  - `outbox`: written in the business transaction, IDs only, with an insertion-order column;
  - `realtime_events`: the replay buffer; primary key `(organization_id, seq)`;
  - `stream_connections`: one row per open dashboard stream, for monitoring coverage;
  - tenant tables with RLS and composite keys. `system_worker` may read only the columns the sweeps need.
- **Publishing** (`services/realtime.ts`). Every alert change (`alert.opened`, `alert.updated`), every shift status or time change (`shift.updated`), each sync batch that moves a shift's live state (`guard.state`, once per shift), and each stream that opens or closes (`coverage.updated`) writes an outbox row in its own transaction. A change that rolls back leaves no event.
- **Outbox dispatcher** (`workers/outbox.ts`, in the worker every 500 ms):
  - it lists organizations with pending rows as `system_worker`;
  - per organization, as `app_runtime` and under that organization's advisory lock, it numbers the rows after the newest event, copies them to `realtime_events`, marks them processed and sends `NOTIFY`, which goes out at commit;
  - it prunes the buffer to 5 minutes or 10,000 events, always keeping the newest;
  - with the detectors, it removes streams left by an API instance that stopped.
- **Stream** `GET /api/v1/stream` (SSE, `live.read`):
  - the organization comes from the normal request pipeline;
  - `Last-Event-ID` replays the gap, and `resync` is sent when the position is outside the buffer;
  - `retry`, a keep-alive every 25 s, and `no-store, no-transform` so proxies pass events through;
  - the full request check runs again every 30 s, and every stream is cycled after 30 min;
  - at most 10 streams per user, and a stream more than 1 MB behind is dropped.
  - Fan-out (`realtime/hub.ts`): each API instance has one LISTEN connection (`repositories/listener.ts`, reconnecting with backoff and catching up after it reconnects). One read per organization serves all of its streams on that instance, with the current guard state, alert or shift status added at send time. Alert events go only to streams with `alerts.read`.
- **Snapshot** `GET /dashboard/snapshot` now returns `lastEventId` (read first, so the stream continues exactly where the snapshot ends), the geofence state, the device report time and app version, the site time zone, shifts not started, and monitoring coverage.
- **Guard detail:**
  - `GET /guards/:id/location` (`live.read`, live positions only): the active shift's live state and the accepted disclosure;
  - `GET /alerts?guardId=`.
- **Location history** `GET /guards/:id/location-history` (`location.history.read`):
  - `LOCATION_HISTORY_VIEWED` is written in the transaction before any point is read; if that insert fails, nothing is returned;
  - a reason is required when `privacy.require_history_access_reason` is on (D-21);
  - a range is one shift, or up to 24 h;
  - the response holds the thinned track (`downsampleTrack` in `packages/domain`: at most 2,000 points, keeping the first, last, gap-edge and flagged points), breaks after gaps over 5 min, the site boundaries and the shift events.
- **Dashboard:**
  - `LiveProvider`: one snapshot and one stream per tab, shared by every page. Events that arrive during a reload are applied on top of it; a late copy never rolls the picture back. Freshness ticks every second against server time. A banner appears after 10 s without the stream, and the picture reloads on reconnect. A refused stream shows the blocking signed-out screen.
  - Home, exceptions first: active guards, on site, off site, delayed or offline, tracking problems and shifts not started, each opening the matching list; monitoring coverage (desktops and phones), with a warning when guards are on duty and nobody is watching; active alerts, most severe first.
  - Live map: clustering (a cluster shows its worst member's colour), accuracy circles from zoom 14, labels with the position's age, filters (status, site, active alerts), and a plain-text guard panel instead of popups. Phone width works.
  - Guard detail: live state, disclosure, phones, two weeks of shifts, recent alerts.
  - Location history: shift or range, the reason field, "Show history" only on request, breaks at gaps, flagged points in red, a playback slider, and the events timeline.
- **Demo:** the demo moves live updates itself. `--crowd=N` adds up to 2,000 guards over 16 zones.

## Tests by ID

| ID | Test |
|---|---|
| ADV-T02 | `apps/api/test/realtime.test.ts`: a stream for another organization's ID is refused before anything is sent; a stream never carries another organization's events; a stream kept open after the membership is removed closes, and nothing more is sent; signing out ends the stream |
| ADV-A04 | `apps/api/test/live.test.ts`: a dispatcher is refused location history (location exports come with Phase 9) |
| ADV-W01 | `apps/web/test/plain-text.test.tsx`: script payloads in guard and site names render as text in the guard panel; the dashboard has no HTML sink (`innerHTML`, popup HTML, `dangerouslySetInnerHTML`) |
| ADV-P02 | `apps/api/test/live.test.ts`: viewing writes the audit row with the reason before returning data; with the audit insert made to fail, no point is returned |
| ADV-U01 | `apps/web/test/live-model.test.ts`: with no events for 6 minutes, a live guard turns DELAYED, then OFFLINE, and the position LAST KNOWN, worded as such; also `packages/domain/test/tracking.test.ts` |
| — | `realtime.test.ts`: events numbered after commit, in order, IDs only; a rolled-back change leaves none; pruning never restarts the sequence; replay from `Last-Event-ID`; `resync` from the future and after pruning; coverage counts desktops and phones; stale streams are swept; the stream is marked `no-transform` |
| — | `live.test.ts`: D-21 reason rule; thinning to 2,000 with first and last kept; the gap break and the flagged point; range limits; another guard's shift; a guard's live location |
| — | `packages/domain/test/history.test.ts`: thinning, breaks after thinning, the exact 5-minute boundary; site status; tracking problems |
| — | `apps/web/test/live-model.test.ts`: stream events update and remove guards and alerts, never with an older copy; the SSE parser handles keep-alives and split frames |

## Not done

- Location exports (Phase 9). ADV-A04's export half is tested there.
- D-22, the guard's own trail in the app: rejected by the owner (2026-11-01). The unused `location.history.read.own` permission was removed from the guard role.
- Web push, the SOS banner and the alarm sound (Phase 8). Open incidents on the home page (Phase 8).
- **The visual check at 1,000 guards on a desktop and a phone** (ARCH §22) is a human check: `pnpm demo --crowd=1000`, then the Live map.
- `status.json` stays at Phase 3 until Phase 4's device tests have run.

## Checked by running it

On the local database, with `pnpm api:dev`, `pnpm web:dev` and the demo, the stream was read through the dashboard's dev proxy (:3000) and straight from the API (:4000):

- Straight from the API, events arrived as they happened, in order, with the keep-alive at 25 s.
- **Through the dev proxy, nothing arrived at first, not even keep-alives.** Next's server compresses responses and buffered the stream. The stream now sends `Cache-Control: no-store, no-transform`. Events then passed through in real time, and a test checks the header. In AWS, `/api/*` goes straight to the API, but CloudFront and any future proxy get the same instruction.
- The local database still held five demo shifts from 2026-10-09 that were ACTIVE because no worker had run, so the demo's new starts were refused. One worker run auto-ended them.
- **At pilot scale** (`pnpm demo --crowd=1000`: 1,005 guards on duty, on this laptop's local database):
  - enrolling 1,000 simulated phones took a few minutes (not timed), and all 1,005 shifts started;
  - the snapshot took 167–734 ms and was 807 KB uncompressed;
  - the stream carried about 11 events a second, in order, through the dev proxy.
- **Changed after measuring:** the dashboard reloaded the whole snapshot on every `shift.updated`. At a shift change of 1,000 guards that would have been hundreds of 800 KB reloads, which is too much for duty officers on phone data. Now:
  - a guard who starts from the app arrives through their own `guard.state`, and the dashboard reloads only if they haven't arrived 3 s later;
  - an ended shift is removed locally;
  - the count of shifts not started refreshes at most once a minute;
  - a `resync` still reloads at once.
- **For production:** the API doesn't compress responses, and CloudFront won't with the caching-disabled policy. Compressing JSON responses would cut the snapshot to roughly a tenth. That is worth doing before the 1,000-guard rollout; it isn't needed for 50 pilot guards.
