# Phase 9 — Reports, exports and retention · REPORT

| | |
|---|---|
| Date | 2026-11-02 |
| Result | **Built.** `pnpm verify` passes: all 12 checks it runs; 78 test files, 686 tests; 120 IDs cited; all 5 negative controls turn their checks red. Phase 9 adds no dependency (the audit last ran this morning, clean). Phase 9's exit IDs (ADV-T03, W02, P03, P04, TM02) each have a passing test. |
| Commit | `8854af8`, pushed 2026-11-02; CI green. |
| AWS | Applied 2026-11-02 with Phase 8's, at the owner's go-ahead. `8854af8` was released to the test environment the same day: migrations 0010 and 0011 applied and the worker's first retention run logged. `infra/scripts/smoke.sh` passed (on real S3: signed upload, no overwrite, signed download and delete; the API was refused a delete). A restore drill passed (`docs/testing/restore-drills.md`). Then the environment was paused again. |

**Owner decisions (2026-11-02):**

1. **Operational records** go 12 months after they closed, never while open.
2. **Positions on records** are cleared after 90 days, except evidence on incidents and SOS.
3. **Exports:** anyone allowed to export may download the organization's exports (not the recommendation; SEC still applies to each kind).

## What was built

- **Reports (PROD §15.1).** All of them count by inclusive local dates in the site's zone (the organization's for several sites), at most 92 days. Another organization's site, guard or shift is not found.
  - **Attendance**, as before.
  - **Patrols:** per round, required, verified, QR only, missed and completion %, with flags (out of order, sent late, suspicious).
  - **Incidents:** reference, type, severity, site, guard, times, status, time to acknowledge and to resolve. Drills only when asked for.
  - **Location:** per shift, time inside, outside and unknown (they add up to the worked time), excursions with their durations (marked when found only after the phone synced), the longest gap, distance and the number of fixes. It holds no coordinates. It needs location-history access, asks for the D-21 reason and is audited (`LOCATION_REPORT_VIEWED`) before any point is read. A shift whose track was deleted under retention says so.
  - **Site activity:** per site and local date, shifts scheduled, covered and missed, late starts, worked time, patrol completion and incidents.
- **Exports (PROD §15.2):**
  - every export runs in the background (`export_jobs`, migration 0011), one at a time per person. The dashboard hears when one changes (a realtime event carrying only its ID);
  - CSV in UTF-8 with a BOM, every cell formula-safe; a guard's data is a ZIP of four CSVs (profile, shifts, location, the incidents they reported; SEC §16.6), built with Node's own zlib;
  - files are kept in the object store. A download link lasts 15 minutes (http(s) only, served as an attachment); files are deleted after 7 days;
  - requests are audited (`EXPORT_REQUESTED`, plus `LOCATION_HISTORY_EXPORTED` with the reason for location), and so are downloads (`EXPORT_DOWNLOADED`, with the reason again for location);
  - anyone allowed to export sees and downloads the organization's exports (owner decision 3), within each kind's rule. A guard's data needs the new `exports.guard_data` (Owners and Administrators); location kinds need location-history access;
  - the attendance CSV built in the request is gone: it is an export like the others.
- **Retention (SEC §16.5).** The worker checks every 10 minutes and runs each organization once a day from 03:00 its time, as `retention_worker`:
  - **one organization at a time:** its policies (migration 0011) see only the organization the transaction names, so a mistake can't cross tenants;
  - **in short batches, children before parents.** Anything a kept record still points to stays: an open alert keeps its shift;
  - **operational records** (alerts, incidents with their photos, SOS with presses, messages and trail, patrol rounds and scans, shifts with their events, drills, export records) go 12 months after they closed (owner decision 1). Photos leave the object store with their incident;
  - **location:** the track goes after `retention.location_days`, except the evidence (SEC §16.5). That is points within the window of a kept incident or SOS on the same shift, and an SOS's own trail. Positions on shifts, checkpoint scans and the live state are cleared after the same period, and the records stay (owner decision 2);
  - **device status** after 30 days, **quarantined sync items** after 30 days, **audit logs** after 24 months;
  - **one `RETENTION_RUN` audit row** with counts only;
  - **the schema linter** now checks that `retention_worker` may update only the position columns a table lists (`retentionClears`), and a new negative control proves it can fail;
  - **a new settings rule:** location may not be kept longer than the records it belongs to.
- **Dashboard** (built by a helper agent from a written brief; reviewed, its gaps closed in the contract, its checks re-run here):
  - Reports with five tabs, filters in the address (never the reason), "Export CSV" per kind;
  - an Exports page with live status, download (with the reason dialog for location) and "Your export is ready";
  - "Export this guard's data" on a guard; "Export CSV" in the location history viewer.
- **Infrastructure (written, validated, not applied):**
  - the worker's retention connection;
  - delete rights for the worker only, on photos and export files;
  - export files under `exports/`, with an 8-day expiry rule as a backstop.
- **Fixed on the way:** Phase 8's push left a red CI run, because the secret scan flagged a public Web Push test key and a Terraform reference. Both were reviewed and listed in `.gitleaksignore`, and CI is green again (a14f49f).

## Tests by ID

| ID | Test |
|---|---|
| ADV-T03 | `apps/api/test/exports.test.ts`: an export naming another organization's site, guard or shift is refused for every kind, no job is created, and an export of the same days holds none of its names. `reports.test.ts`: every report refuses another organization's site or guard and never lists its rows. `tenancy.test.ts`: the generated probes over `/exports/:id` and `/exports/:id/download`, and the export list |
| ADV-W02 | `exports.test.ts`: every kind of export, a guard's data ZIP included, has no cell a spreadsheet would run (names, titles and employee numbers seeded as `=HYPERLINK(…)`, `+cmd`, `@SUM(…)`). `packages/domain/test/reports.test.ts`: the CSV writer |
| ADV-P03 | `apps/api/test/retention.test.ts`: on a fake clock, against records of every age, the run deletes exactly what expired (a 14-month-old shift with its alert, incident and photos; a 16-month-old SOS and trail; device status; old audit), clears old positions, keeps the rest (an open alert's shift, yesterday, another organization), and audits the counts. A second run deletes nothing |
| ADV-P04 | `retention.test.ts`: points within ±30 minutes of a kept incident, around a kept SOS on the same shift, and a kept off-shift SOS's own trail survive; points outside the windows go |
| ADV-TM02 | `reports.test.ts`: a shift starting 00:30 Karachi time belongs to that local date in the attendance and site-activity reports. `packages/domain/test/reports.test.ts`: local date ranges in Karachi and across London's summer-time change |
| — | `exports.test.ts`: one export at a time per person; who sees and downloads what (owner decision 3, a guard's data only for Owners and Administrators, no exports for dispatchers); location exports audited with the reason, asked for again at download; 15-minute links; files deleted after 7 days (EXPORT_EXPIRED); the guard's data ZIP contents. `reports.test.ts`: patrol, incident and location figures; the location report's audit and reason; dispatchers refused |
| — | `retention.test.ts`: the run is due once a day from 03:00 in the organization's zone. `packages/domain/test/retention.test.ts`: cut-offs and calendar months. `packages/db/test/schema-lint.test.ts`: `retention_worker` may update only declared positions; `scripts/negative-controls.ts`: that check can fail. `packages/contracts/test/settings.test.ts`: location never kept longer than its records |
| ADV-W01 | `apps/web/test/plain-text.test.tsx`: script payloads in report rows and export titles render as text |

## New dependencies

None. The ZIP is written with Node's `zlib`.

## Decisions

The owner's three answers and the agent's choices are in `docs/DECISIONS.md` under Phase 9. To look at first:

- every export runs in the background;
- a download of an export with location asks for the reason again;
- a guard's data export holds everything still kept, so the 92-day limit doesn't apply;
- the settings rule that keeps location from outliving its shift.

## Not done

- **AWS:** the Terraform waits for the owner's go-ahead (with Phase 8's).
- **PDF exports** (later, PROD §15.2), **legal holds** (not in V1, SEC §16.5), **anonymizing a departed guard's records** (after the legal review, SEC §16.6).
- **Dashboard:**
  - "Your export is ready" shows on the Exports page only. Someone who stays on Reports isn't told; a notice in the header could be added;
  - nothing was looked at in a browser. That is for the owner (`TODO.md`).
- `status.json` stays at Phase 3 until Phase 4's device tests have run.

## Checked by running it

This ran on the local database: `pnpm db:up` applied migration 0011 to the existing data. The API dev server ran with it, and so did the worker, with its retention connection.

- **Retention.** It was 20:01 in Karachi, past 03:00, so the worker ran retention at start for both local organizations. Nothing was deleted, since all local data is recent, and each run wrote its `RETENTION_RUN` row.
- **Reports** over the last 7 days of demo data, all HTTP 200, in the organization's zone:
  - attendance: 2,021 shifts (the 1,000-guard crowd from Phase 6);
  - patrols: 120 rounds; incidents: 1; site activity: 20 site-days;
  - location: 200 shifts with "cut short" as designed. Ali's still-running shift shows 9 minutes inside, then 62 minutes unknown since the demo stopped.
- **Three exports**, built by the worker and downloaded through their links as attachments:
  - attendance: 2,021 rows, 274 KB, with the BOM;
  - the location report: 2,021 rows;
  - Ali's data: a ZIP with his profile, 6 shifts, 738 points and no incidents (he reported none).
- **The audit log** gained `EXPORT_REQUESTED` ×3, `LOCATION_HISTORY_EXPORTED` ×2, `EXPORT_DOWNLOADED` ×3 and `LOCATION_REPORT_VIEWED` ×1.
- **Afterwards:** everything was stopped; one orphaned database process was ended, and no SENTRY port is left open.
