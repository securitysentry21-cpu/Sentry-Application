# Phase 7 — Patrols · REPORT

| | |
|---|---|
| Date | 2026-11-02 |
| Result | **Built.** `pnpm verify` passes: all 13 checks; 61 test files, 497 tests; 99 IDs cited. Phase 7's exit IDs (ADV-Q01–Q09, T08) each have a passing test. Scanning a printed label with a real phone is still for a person. |
| Commit | Not committed; waiting for the owner. |

## What was built

- **Schema (migration 0008):**
  - `patrol_routes`: on demand, or every 10–720 min with a completion window no longer than the interval;
  - `patrol_route_checkpoints`: order and "required". Both keys carry the site, so the database refuses a route and a checkpoint from different sites or organizations;
  - `patrol_runs`: one round of a route inside one shift (D-16), with its counters;
  - `checkpoint_visits`: append-only (INV-05). The scanned token is never stored. Check constraints refuse coordinates or a distance on a visit without a shift (INV-08), and "counted" on anything but VERIFIED or QR only.
  - `system_worker` may read three columns of open runs, for the closer's sweep.
- **Rules** (`packages/domain/patrols.ts`, pure): `verifyScan` in ARCH §11.2's order, with "clearly outside" checked before "poor accuracy" (DECISIONS, Phase 7); the run schedule; run progress and status; out of order; the next checkpoint; distance bands.
- **Scans** (`services/patrols.ts`), from `POST /sync/batch`, online and offline alike, judged by capture time:
  - the label must be one of this organization's active checkpoints. Unknown, rotated, archived and other organizations' labels all answer INVALID_QR, alike;
  - the shift whose window holds the scan, the site, duplicates, location, implausible travel (SUSPICIOUS_LOCATION), mock locations;
  - the reply carries the outcome. It names the checkpoint only when it is at the guard's own site, and gives a distance only for OUTSIDE_RADIUS;
  - 60 scans per guard per minute; beyond that, RETRY;
  - a resubmitted scan gets its first result.
- **Runs:**
  - generated when a shift starts, including runs already due when the start synced late;
  - runs not yet due follow an extension or a route change;
  - progress updated by each scan;
  - closed by the worker 2 min after the window (INCOMPLETE or MISSED, with one CHECKPOINT_MISSED alert naming what is missing), and at shift end (CANCELLED if not yet due);
  - late offline scans still update a closed run; its alert stays for a person (PROD §12.1).
- **API:**
  - routes: `GET`/`POST /sites/:id/patrol-routes`, `PATCH /patrol-routes/:id`, audited and versioned. A checkpoint can be in only one scheduled route;
  - runs and scans: `GET /patrol-runs`, `GET /patrol-runs/:id`, `GET /checkpoint-visits?shiftId=`. They return distances and accuracy, never a guard's coordinates;
  - the guard's own rounds: `GET /me/patrols?shiftId=`;
  - `features.patrols` is on in `/mobile/config`. The D-17 setting can be changed in the dashboard.
- **Guard app:**
  - a Patrol screen during the active shift: the round under way, its checkpoints in order with ✓ / QR only, the next one, and later rounds. The last copy is kept for viewing offline;
  - the scanner from enrollment, now with a light switch;
  - a fresh fix with each scan;
  - the result in PROD §7.7's words, kept on the scan's receipt (phone storage migration 3). "Saved — will verify when online" until the server answers;
  - English and Urdu.
- **Dashboard** (built by a helper agent from a written brief; reviewed, and its checks re-run here):
  - Sites, checkpoints: an editor with name, description, radius (10–500 m), status and a map pin with the radius drawn. It warns when there is no pin (scans can then only be "QR only") or the pin is outside the site; a Position column in the table;
  - Sites, patrol routes: a list per site with the schedule in words, and an editor (on demand or every N minutes, first-run offset, completion window, enforced order, ordered checkpoints with "required", status). The form checks the server's rules early and handles a changed version (409);
  - a **Patrols** page (in the menu after Shifts): one day in the organization's time zone, site and status filters with counts, the rounds with progress ("4 of 6 (1 QR only)") and what is missing; a round's detail with its checkpoints in order and every scan (result, distance, accuracy, flags, "sent late"); links by guard, shift or round; it refreshes every 60 s while visible and when focused;
  - guard detail: patrol history (rounds due in the last 7 days) and a Patrols link for each shift;
  - the words for statuses, outcomes, reasons and flags are in `lib/patrols.ts`. Everything is plain text (ADV-W01).
- **Found by the dashboard review, fixed in the server:**
  - a checkpoint could be switched off while still a stop of an active route; its label is then refused, so those rounds could never complete. Now an active route's checkpoints must be active (DECISIONS, Phase 7);
  - a route made on demand or inactive mid-round left the round under way to close as missed, with an alert against the guard. That round is now cancelled.
- **Demo:** the beat gets a checkpoint at each corner and a round every 12 minutes. Sana walks every round, Bilal scans a photographed label from off site and then walks half rounds, and Hina's silent phone misses hers. The demo runs the closer itself.

## Tests by ID

| ID | Test |
|---|---|
| ADV-Q01 | `apps/api/test/patrols.test.ts`: a scan at the checkpoint is VERIFIED, counts, and moves the run to IN_PROGRESS; the token is not stored. Also `packages/domain/test/patrols.test.ts` |
| ADV-Q02 | `patrols.test.ts`: a label scanned 2 km away is OUTSIDE_RADIUS and doesn't count, with a 15 m fix and with a 150 m one |
| ADV-Q03 | `patrols.test.ts`: poor accuracy near the checkpoint is LOCATION_UNCONFIRMED, counted and shown as QR only; with the D-17 setting off it doesn't count; a checkpoint without a position gives QR only |
| ADV-Q04 | `patrols.test.ts`: the same scan resubmitted keeps its first result and one row; a new scan of the same checkpoint inside the window is DUPLICATE and doesn't count |
| ADV-Q05 | `patrols.test.ts`: the label from before a rotation is INVALID_QR, the new one works. Also `sites.test.ts` |
| ADV-Q06 | `patrols.test.ts`: another site's checkpoint is WRONG_SITE, and doesn't count |
| ADV-Q07 | `patrols.test.ts`: a scan with no active shift is NO_ACTIVE_SHIFT, keeps only a distance band, and the database refuses coordinates on such a row |
| ADV-Q08 | `patrols.test.ts`: checkpoints 500 m apart scanned 10 s apart get IMPLAUSIBLE_TRAVEL and open SUSPICIOUS_LOCATION; the visit list carries no coordinates |
| ADV-Q09 | `patrols.test.ts`: a batch after 70 minutes offline: each scan joins the run its capture time falls in, marked as sent late |
| ADV-T08 | `patrols.test.ts`: another organization's label, an unknown token and a web address get identical answers; nothing about the other organization's checkpoint is kept, and it sees no scan |
| ADV-T04 | `patrols.test.ts`: a route naming another organization's checkpoint is refused by the API, and by the composite key in the database (also another site's) |
| ADV-T01 | `tenancy.test.ts`: the new `:id` routes answer 404 for another organization's route, site or run; its runs are never listed, even when asked for by its shift, site or guard; its shift's scans are not found |
| ADV-A03 | `patrols.test.ts`: a guard sees their own shift's rounds; another guard's shift is not found; a dashboard user is refused |
| ADV-P05 | `sync.test.ts`: a scan of a real label outside any shift is stored as NO_ACTIVE_SHIFT, and its coordinates appear in no table |
| — | `patrols.test.ts`: runs at start + k·interval; completion; the closer's INCOMPLETE and MISSED, one alert each; late scans after closing; shift end cancels; an extension adds runs; a route change replaces only runs not yet due, and taking its schedule away cancels the round under way; an active route's checkpoints stay active; route validation, versions and audit; the rate limit |
| — | `packages/domain/test/patrols.test.ts`: every outcome and the order between them, the edge of the radius, mock policy, travel, bands, the schedule, progress, QR-only upgrades, order |
| — | `apps/mobile/test/patrol.test.ts`, `presenter.test.ts`: label recognition; which round shows; the next checkpoint; a scan sent at once with a fix and its verdict on the receipt; offline "Saved — will verify when online"; nothing scanned and no location taken off shift; patrols off; rounds from the phone's copy offline; each outcome's words |
| ADV-W01 | `apps/web/test/plain-text.test.tsx`: script payloads in checkpoint, route, guard and site names render as text in the patrol views and both editors (shown to fail with an HTML sink planted); `apps/web/test/patrols.test.ts`: the dashboard's words |

## Not done

- **The "Checkpoint problem" button** (PROD §7.7). It files an incident, so it comes with incidents (Phase 8).
- **The patrol report and its CSV** (Phase 9).
- **Checkpoint calibration on site with the app** (D-24: V1.1).
- **iOS temporary full accuracy for scans.** The pilot is Android.
- **Q-22, the message for an old label:** built as one message for every unrecognised label. Waiting for the owner.
- **A real phone scanning a printed label:** waits for the test guard app (the Expo account).
- `status.json` stays at Phase 3 until Phase 4's device tests have run.

## Checked by running it

On the local database (migration 0008 applied by `pnpm db:up`), with the API, the dashboard dev server and `pnpm demo`, checked through the dashboard's own origin (its `/api` proxy):

- **The demo couldn't start at first.** It enrolls each simulated phone again on every run, and enrollment codes are limited to 3 per guard per day (SEC §9), so the 4th run in a day failed. The demo now keeps its phones in the git-ignored `.local/demo-phones.json` and signs them in again on a rerun. Checked: a rerun used no new codes and picked up the five running shifts.
- **Round 1** (due 1 min after the start, 9 min to finish):
  - Sana: all four corners VERIFIED, 12–25 m from the labels, so Done;
  - Bilal: a "photographed" label scanned off site was OUTSIDE_RADIUS at 772 m and didn't count, so Missed;
  - Hina, whose phone fell silent: Missed;
  - the closer closed the round within 2–3 minutes of its window and opened one "Checkpoint run missed … 4 of 4 missing" alert per missed round.
- **Round 2:** Sana Done again; Bilal and Hina Incomplete (1 of 4), each with "Checkpoint run incomplete … 3 of 4 missing".
- **Found and fixed:** the demo walked Bilal back from off site faster than 70 m/s, and the server rightly flagged IMPLAUSIBLE_SPEED ("Suspicious location"). The demo's guards now move at most 15 m/s. No new speed alert came after the change.
- The Patrols, Sites and Overview pages loaded (HTTP 200 from the dev server). How they look in a browser is for the owner to check (TODO.md).
- Everything was stopped afterwards, with no processes left and ports 54329, 4000 and 3000 closed.
