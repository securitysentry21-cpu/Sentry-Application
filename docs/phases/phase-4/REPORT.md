# Phase 4 — Mobile location subsystem · REPORT

| | |
|---|---|
| Date | 2026-10-08 |
| Result | **Software built; device tests pending.** Every automatable Phase 4 exit ID has a test. ADV-O05 (reboot mid-shift) is a device test, and the device-matrix subset is human-run on the pilot's phones, so `status.json` stays at Phase 3 until those are run. `pnpm verify` passes. |
| Commit | Local only (round 6). |

## What was built

- **Server** (see PLAN.md for the core):
  - sync pipeline, capture-time estimation, live state, `GET /dashboard/snapshot`, the Live map.
  - **REPLACED phones (ADV-A08, ARCH §5.4).** When a new phone is enrolled, the old one keeps its sessions, and for 72 hours it may call only `POST /sync/batch` (policy flag `replacedDeviceDrain`). Items it captured after the replacement are rejected with `DEVICE_REVOKED`. It may refresh while draining. LOST, COMPROMISED and ADMIN revocations still end every session at once.
  - **Attendance report** (PROD §6.8, §15):
    - `GET /reports/attendance` for inclusive local dates (the site's time zone, or the organization's), at most 92 days;
    - late, early-leave and worked minutes, plus the six record flags;
    - `GET /reports/attendance/export`: CSV, UTF-8 with BOM, formula-safe, audited as `EXPORT_REQUESTED`;
    - a dashboard Reports page.
  - **Coordinate tagging (ADV-X05).** Coordinates in API responses are tagged in the contract as guard location or site geometry. A meta-test fails on any untagged coordinate, and on any route that returns guard coordinates without either `locationScope: 'live'` or an audit action.
  - **Mobile config** carries the supervisor's number (`support.emergencyCallNumber`). The consent route has a response schema in the contract.
- **Guard app** (`apps/mobile`, built in a separate worktree and merged; see its README and DEPENDENCIES):
  - outbox with SOS and main lanes, sync engine, sessions, device key;
  - tracking, the shift state machine and the end-of-shift failsafe;
  - the screens, in English and Urdu.

## Tests by ID (added since PLAN.md)

| ID | Test |
|---|---|
| ADV-A08 | `enrollment.test.ts`: COMPROMISED refused on the next request. `sync.test.ts`: REPLACED uploads pre-replacement data, is refused for later data and other routes, and after 72 h |
| ADV-P05 | `sync.test.ts`: generated over every sync item type whose contract carries a fix, each sent with no shift window open. Every column of every tenant table is then searched for the coordinates |
| ADV-X05 | `route-registry.test.ts`: walks every route's response schemas |
| ADV-L07, L11 | Phase 5 tests (`geofence.test.ts`, `alerts.test.ts`) |
| ADV-O01–O04, O06–O09, L12, U02, U03 | `apps/mobile/test/*`, the phone's side, against a fake server that uses the shared schemas |
| — | `reports.test.ts`: figures and flags, local-date boundaries, the 92-day limit, tenant scope, dispatchers refused, CSV BOM, formula neutralising, audit |

## Still open

- **Human device tests** (apps/mobile README): ADV-O04, O05, O08, U02; permission flows on the pilot's phones; the 12-hour soak (battery and data); headless delivery; Urdu on low-end phones. ADV-O05 has no automated test, because the reboot can only be tested on a phone.
- **Pilot 0 readiness:** a deployed cell (AWS account), legal review of the disclosure text (EXT-17), and a first native build (Expo account).
