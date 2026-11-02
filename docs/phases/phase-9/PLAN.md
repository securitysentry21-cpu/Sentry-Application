# Phase 9 — Reports, exports and retention · PLAN

| | |
|---|---|
| Date | 2026-11-02 |
| Go-ahead | The owner, 2026-11-02: "commit and push phase 8 and then proceed to phase 9." |
| Read | PROD §6.8, §15, §16, App. B (retention, privacy); ARCH §6.3–§6.5, §16, §22; SEC §8, §16, §17 |
| Exit IDs | ADV-T03, W02, P03, P04, TM02 |

Phase 4's device tests are still open, so `status.json` stays at Phase 3, as for Phases 5–8.

**Owner decisions (2026-11-02, `docs/DECISIONS.md`):**

1. **Operational records.** Everything that isn't location, device status or audit is deleted 12 months after it closed, never while it is still open. Profiles (guards, sites, members) stay until someone removes them.
2. **Positions on records.** At 90 days, positions come off a shift's start and end, checkpoint scans and the live state; the records stay. Positions on incidents, SOS and their photos are evidence and stay with them.
3. **Exports.** Anyone allowed to export may download the organization's exports. A guard's data export stays with Owners and Administrators (SEC §16.6), and an export with location needs location-history access and, where required, a reason (SEC §16.4). Every download is audited.

**What exists already:**

- the attendance report, with a CSV built in the request (Phase 4);
- `csvCell`, which neutralises formulas (SEC §8);
- the location history viewer with its audit and reason rule (Phase 6, D-21);
- the geofence rules (Phase 5);
- the retention settings (App. B);
- the `retention_worker` database role, which can't do anything yet;
- the object store (Phase 8).

## Scope

- **Reports (PROD §15.1):** each for inclusive local dates in the site's time zone, or the organization's for several sites, at most 92 days:
  - **attendance**, as now;
  - **patrols:** per shift and round: required, verified, QR only, missed, completion % (counted ÷ required), flags;
  - **incidents:** reference, type, severity, site, guard, occurred and reported times, status, time to acknowledge, time to resolve. Drills are left out unless asked for;
  - **location:** per shift: first and last fix, time inside, outside and unknown, excursions with their durations (including those that arrived late), the longest data gap, distance travelled. It contains no coordinates. It reads location history, so it needs location-history access, is audited (`LOCATION_REPORT_VIEWED`) and asks for the reason when the organization requires one;
  - **site activity:** per site: shifts covered against scheduled, attendance, patrol completion, incidents.
- **Exports (PROD §15.2):**
  - every export runs in the background (`export_jobs`), one at a time per person. The dashboard is told when one is ready (a realtime event);
  - CSV, UTF-8 with a BOM, formula-safe (SEC §8). A guard's data export is a ZIP of CSVs;
  - kinds: each report; the location history of a shift or of a guard over a period; a guard's data (profile, shifts, location, the incidents they reported; Owners and Administrators, SEC §16.6);
  - files are kept in the object store. A download link lasts 15 minutes; files are deleted after 7 days;
  - requesting an export is audited (`EXPORT_REQUESTED`; `LOCATION_HISTORY_EXPORTED` for location, with the reason), and so is every download (`EXPORT_DOWNLOADED`);
  - the attendance CSV built in the request is replaced by a background export.
- **Retention (SEC §16.5):**
  - a daily job at 03:00 in each organization's time zone, run by `retention_worker` one organization at a time (its policies see only the organization being worked on). Deletes are batched;
  - location older than `retention.location_days`, except the evidence: points within ±`retention.incident_evidence_window_minutes` of an incident or SOS on the same shift, and an SOS's own trail, are kept as long as the incident or SOS (ADV-P04);
  - positions on shifts, checkpoint scans and the live state are cleared after the same period (owner decision 2);
  - device status older than `retention.device_status_days`;
  - operational records 12 months after they closed, children before parents, never while still open (owner decision 1). Photos leave the object store with their incident;
  - audit logs older than `retention.audit_months`;
  - quarantined sync items after 30 days;
  - one `RETENTION_RUN` audit row per run, with counts only;
  - the database refuses changes to the guard's original records outside retention: the schema linter allows `retention_worker` to delete, and to clear only named position columns.
- **Dashboard:** report pages with filters and "Export"; an Exports page (live status, download, expiry); "Export this guard's data" on a guard (Owners and Administrators); "Export" in the location history viewer.
- **Infrastructure** (written, not applied without the owner's go-ahead on cost):
  - the worker may delete photos and export files;
  - an expiry rule removes export files the job missed;
  - the worker gets the `retention_worker` connection.

## Tests

- **ADV-T03:** an export from organization A with organization B's IDs in its parameters holds nothing of B's, for every kind.
- **ADV-W02:** `=HYPERLINK(…)`, `+cmd` and `@SUM` in names, titles and notes come out neutralised in every CSV.
- **ADV-P03:** a retention run on a fake clock deletes exactly what has expired, audits the counts, and leaves everything else.
- **ADV-P04:** points near a retained incident or SOS, and an SOS's own trail, survive the run.
- **ADV-TM02:** reports over a date range use the site's local dates, across a time-zone and day boundary.
- **Also:**
  - one export at a time per person;
  - links expire after 15 minutes, files after 7 days;
  - downloads keep each kind's rule;
  - the location report and location exports are audited and need the reason when required;
  - every new route in the cross-tenant fixtures (ADV-A09) and the coordinate meta-test (ADV-X05);
  - the new tables in the cross-tenant read test and the schema linter, with a negative control for the position-only update rule;
  - the domain's report arithmetic.

## Not in this phase

- PDF exports (PROD §15.2: later).
- Legal holds (SEC §16.5: not in V1; the design leaves room).
- Anonymizing a departed guard's records (SEC §16.6: after the legal review, EXT-17).
- Sending reports to a security company's clients. There is no client portal (PROD §2); an Owner exports and shares.
