# Phase 2 — Guards + sites · PLAN

| | |
|---|---|
| Status | **Approved 2026-10-08** (round 6: "all of the phases that we can build") |
| Read | PROD §4–5, §7.1–7.3; ARCH §5, §11.1, §17; D-02, D-30, D-31, D-38 |

## Scope

1. **Guards:**
   - create, edit, disable and terminate;
   - CSV import with a preview; every row is validated before anything is created (SEC §8);
   - one active guard record per user (A-04).
2. **Enrollment and devices (D-02, D-30, D-31):**
   - Supervisors and above issue a single-use code: 8 characters, typed or scanned as a QR code, valid 7 days, bound to the guard and their phone number.
   - The guard app redeems it with the guard's phone number and the phone's P-256 public key. That registers the device, revokes any previous one as REPLACED, and issues our own mobile session.
   - Sessions: access tokens last 15 minutes. Refresh tokens last 30 days, rotate on every use, and are stored hashed. Re-presenting a rotated token revokes the whole session family; there is a 30-second grace for a retried request.
   - Devices are listed and can be revoked.
3. **Guard-app endpoints:** `GET /mobile/config` and `POST /tracking-consents` (append-only). Every guard request is checked against `X-Device-Id` and a device that is still ACTIVE.
4. **Sites (D-38):** a circle (50–5,000 m) or a polygon drawn on the map (3–200 points, at most 100 km², no self-crossing), validated by shared geo functions in `packages/domain`.
5. **Checkpoints and QR codes (ARCH §11.1):**
   - The token is HMAC-SHA256(secret, id ‖ version), truncated to 128 bits; the QR content is `SG1:<token>`. Only its hash is stored.
   - Rotation invalidates the old label at once. The print sheet is audited.
6. **Dashboard:** Guards (list, create, import, detail with enrollment code and QR, devices), Sites (map editor for circles and polygons, checkpoints, QR print sheet).
7. **Guard app shell:** enrollment, disclosure and consent, diagnostics, Urdu and English. A parallel agent builds it against the shared contract in `packages/contracts/src/mobile.ts`.

## Not in this phase

- Patrol route configuration moves to Phase 7, where patrols are built and tested.
- Enrollment by SMS waits for the aggregator (EXT-10). The supervisor hands the code over in person (round 6).

## Tests by ID

| ID | Proves |
|---|---|
| ADV-T04 | A checkpoint for organization A at B's site is refused by the API (404) and by the database (composite foreign key). |
| ADV-T05 | A's administrator gets 404 for B's QR print sheet and B's rotation. |
| ADV-A01 | A guard's session reaches only that guard's own data. |
| ADV-A10 | Identity fields in a body are rejected on every new mutation. |
| ADV-A11 | An enrollment code that is guessed, reused, or tried with another phone number is refused; attempts are rate-limited; no session is issued. |
| ADV-A12 | A new phone without a dashboard-issued code gets nothing. |
| ADV-Q05 | An old label after rotation is `INVALID_QR`. |
| ADV-A08 (session part) | A revoked device's session is refused at once. The upload part comes in Phase 4. |
