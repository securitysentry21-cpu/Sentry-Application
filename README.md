# SENTRY

Operations platform for private security companies. Guards carry an Android app that tracks them during their shifts. The control room, supervisors and duty officers use a web dashboard. Each company's data is kept separate from every other company's, enforced by the database (row-level security), not only by the application.

| Part                                     | Where         | Status                                                                                                                                                |
| ---------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| API (Fastify, PostgreSQL 17)             | `apps/api`    | Phases 1–5 core: identity, guards and devices, sites and QR checkpoints, shifts, sync and live state, geofence and alerts, attendance report          |
| Web dashboard (Next.js 16)               | `apps/web`    | Overview, Live map, Alerts, Shifts, Guards, Sites, Reports, Members, Settings, Audit log                                                              |
| Guard app (Expo SDK 57, Android first)   | `apps/mobile` | Framework: enrollment, consent, shifts, background tracking with an offline outbox, sync, SOS client (off for the pilot). See `apps/mobile/README.md` |
| Shared contracts, domain rules, database | `packages/*`  |                                                                                                                                                       |

Read `CLAUDE.md` first, then `docs/SECURITY_AND_INVARIANTS.md` (it wins every conflict), `docs/DECISIONS.md`, `docs/PRODUCT_SPEC.md` and `docs/ARCHITECTURE.md`. Phase plans and reports are in `docs/phases/`.

## Quick start (Windows, macOS or Linux)

You need Node 24 and pnpm 11. Docker is not needed: a local PostgreSQL 17 is downloaded and run for you.

```bash
pnpm install
pnpm db:up                     # terminal 1: local database on :54329 (data in .local/postgres)
cp .env.example apps/api/.env  # once; development-only settings
pnpm api:dev                   # terminal 2: API on :4000
pnpm web:dev                   # terminal 3: dashboard on http://127.0.0.1:3000
pnpm demo                      # terminal 4: demo company with simulated guard phones
```

Open <http://127.0.0.1:3000> and sign in as **owner@demo.test**. In development this signs you in by email, with no password. The API refuses it in production.

The demo creates "Demo Security": five guards, a gate and a patrol beat in the colony, and today's shifts. Then simulated phones enroll, start their shifts and report through the real API, exactly as the app does. Watch the Live map and the Alerts page:

- Bilal walks off the patrol beat after a minute. "Left site" opens about five minutes later and resolves when he walks back.
- Sana's phone reports that background location was turned off: "Tracking disabled".
- Usman's battery is at 12%: "Low battery".
- Hina's phone loses signal after two minutes. On the map she turns DELAYED, then OFFLINE, with her position marked last known; "Device offline" opens after ten minutes.

The background worker runs the shift and alert detectors every minute (`pnpm worker:dev`). The demo runs the alert detectors itself, so the worker isn't needed for it.

## Checks

```bash
pnpm verify          # everything CI runs (add --skip=audit when offline)
pnpm test            # all tests; starts its own throwaway PostgreSQL
```

`pnpm verify` runs format, lint, typecheck, the tests (integration tests run as the restricted runtime role, with row-level security on), generated-doc and database-type drift, test-ID traceability, negative controls (proof that the security checks can fail), the dependency audit, the licence allow-list, the dashboard build, and the guard-app bundle.

## Before the pilot

These need the owner; `TODO.md` tracks them. More detail is in `docs/OPEN_QUESTIONS.md` and `docs/DECISIONS.md`.

1. An AWS account for the first cell (eu-central-1), with Amazon Cognito for dashboard sign-in. The callback is `/api/v1/auth/callback`. Set the `OIDC_*` variables and a real `QR_TOKEN_SECRET`; the API refuses the development secret in production.
2. A legal review of the tracking disclosure text before any real guard data is collected.
3. An Expo account for the first Android build (directly installed, not through Play, for the pilot).
4. The device tests on the pilot's phones (`apps/mobile/README.md`): reboot mid-shift, app killed, a 12-hour battery and data soak, and permission flows.
