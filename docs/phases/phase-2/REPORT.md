# Phase 2 — Guards + sites · REPORT

| | |
|---|---|
| Date | 2026-10-08 |
| Result | **Built.** `pnpm verify` passes: 13 checks, 25 test files, 147 tests; every ID due through Phase 2 has a test. |
| Commit | Local only (the GitHub repository is public; round 6). |

## What was built

- **Schema (migration 0003):**
  - `guards`: one current guard per user (A-04), and unique employee and phone numbers per organization;
  - `guard_devices`: one ACTIVE device per guard (D-05);
  - `mobile_sessions`: one row per rotation;
  - `tracking_consents` (append-only);
  - `sites`: a circle or a polygon (D-38);
  - `checkpoints`: the QR token hash only.

  Narrow `SECURITY DEFINER` lookups cover what happens before a session exists: an enrollment code, a bearer or refresh token, and a scanned QR label, each found by its hash.
- **Guards:** create, edit, suspend, reactivate, terminate, and CSV import with a preview. Import is all or nothing and validates every row: E.164 numbers, duplicates in the file and in the organization.
- **Enrollment (D-02, D-31):**
  - Supervisors and above issue an 8-character code (Crockford base 32), shown once as text and as a QR code; at most 3 per guard per day, and only the latest works.
  - The guard app redeems it with the guard's own phone number and a P-256 public key; a wrong number counts as one of the code's 5 attempts.
  - Redeeming creates the guard's user (phone only, no identity-provider account) and the GUARD membership. It registers the phone and retires the previous one as REPLACED.
  - Codes go only to +92 numbers unless the operator allows others (SEC §9).
- **Mobile sessions (D-30):**
  - access tokens last 15 minutes; refresh tokens last 30 days, rotate on every use, and are stored hashed;
  - reuse after 30 seconds revokes the whole family;
  - a retry within 30 seconds (a lost response) gets a new session and leaves exactly one live session.

  Every guard request is checked against `X-Device-Id`, the device's status and the guard's status. Revocation, suspension and termination take effect on the next request.
- **Guard-app endpoints:** `GET /mobile/config` (versions, tracking, sync and shift parameters, feature flags; SOS off) and `POST /tracking-consents` (append-only, audited).
- **Sites (D-38):**
  - circles of 50–5,000 m, or polygons of 3–200 points, at most 100 km², with no self-crossing;
  - validated by `packages/domain/geo`, which also holds the inside/outside/uncertain rule Phase 4 uses, with a property test that a worse accuracy never turns OUTSIDE into INSIDE;
  - boundary changes are audited as GEOFENCE_CHANGED.
- **Checkpoints:**
  - The QR token is HMAC-SHA256(secret, id:version), truncated to 128 bits; the content is `SG1:<token>`, and only its hash is stored.
  - Rotation invalidates the old label at once.
  - The print sheet is audited before the labels are returned.
  - `resolveScannedCheckpoint` gives one answer, `INVALID_QR`, for unknown, rotated, archived and other organizations' labels. The Phase 7 scan pipeline builds on it.
- **Dashboard:**
  - Guards: roster, search, add, CSV import with a preview, and a guard dialog with the enrollment code and QR, phones, suspend, reactivate and terminate.
  - Sites: a MapLibre map of all sites, and an editor where you click to place a circle's centre or a polygon's corners, with an area readout. Each site has its checkpoints, QR rotation and a printable QR label sheet.

## Tests by ID

| ID | Where |
|---|---|
| ADV-T04 | `sites.test.ts`: API 404, and the database's composite foreign key |
| ADV-T05 | `sites.test.ts`: print sheet and rotation, 404 for another organization |
| ADV-A01 | `enrollment.test.ts`: a guard session reaches only the guard's own data, never dashboard routes |
| ADV-A08 (session part) | `enrollment.test.ts`: a device revoked as COMPROMISED is refused on the next request |
| ADV-A10 | `guards.test.ts`, `tenancy.test.ts` |
| ADV-A11 | `enrollment.test.ts`: guessed, reused, another number, five strikes, rate limit per number |
| ADV-A12 | `enrollment.test.ts`: a new phone only with a new dashboard code; the old phone REPLACED |
| ADV-Q05 | `sites.test.ts`: an old label after rotation is `INVALID_QR` |
| ADV-T01, T06 | generated, now over 15 `:id` routes and 14 tenant tables |

## Decisions and changes

- **Enrollment rate limit per IP: 120 an hour, not 20 (SEC §9 updated).** An onboarding session puts a room of guards behind one office Wi-Fi address, and at 20 an hour most of a 50-guard group would be locked out. The protection that matters is per code (5 attempts, counted durably on the code) and per phone number (10 an hour), and each code is bound to the guard's number.
- **CSRF checks apply to requests that carry the session cookie.** The guard app's enrollment and refresh calls carry no cookie, so a forged browser request has nothing to ride on. ADV-W03 still covers forged dashboard requests.
- **Patrol route configuration moves to Phase 7,** with patrols.
- **The device key is generated in JavaScript** (P-256) and kept in the secure store, not in Keystore or Secure Enclave hardware (round 6; revisit with Phase 0B).

## New dependencies (SEC §14), Phases 1–2

| Package | Version | Used by | Purpose | Licence | Notes |
|---|---|---|---|---|---|
| jose | 6.2.12 | api | Verifies OIDC ID tokens (JWKS, issuer, audience, expiry) | MIT | no dependencies; Filip Skokan, the most-used OIDC library author for Node |
| maplibre-gl | 6.13.0 | web | The map (D-12 revised) | BSD-3-Clause | 18 dependencies, all on the licence allow-list |
| qrcode-generator | 2.0.4 | web | Draws QR codes as SVG paths (no HTML injection) | MIT | no dependencies |
| @types/geojson | 7946.0.16 | web (dev) | GeoJSON types for the map | MIT | already present through maplibre-gl |

No new native permissions: all of these are server or browser code.

## For the owner

- **Map tiles** come from OpenFreeMap, a free service without an SLA (D-12 revised). Before scaling past the pilot, host our own tiles (Protomaps on S3 and CloudFront).
- **Production needs `QR_TOKEN_SECRET`** (at least 32 random characters, in Secrets Manager); the API refuses to start without it. Changing it later invalidates every printed label.
