<!-- Generated from packages/contracts/src/errors.ts by scripts/generate-docs.ts. Do not edit; run `pnpm docs:generate`. -->

# Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | schema or range violation (details[] included) |
| `UNAUTHENTICATED` | 401 | missing or invalid credentials |
| `FORBIDDEN` | 403 | authenticated but lacks permission in own organization |
| `NOT_FOUND` | 404 | does not exist or belongs to another organization |
| `ORG_CONTEXT_REQUIRED` | 400 | multi-organization user omitted X-Organization-Id |
| `ORG_SUSPENDED` | 403 | organization suspended (SOS still accepted) |
| `VERSION_CONFLICT` | 409 | optimistic concurrency failure |
| `SHIFT_INVALID_TRANSITION` | 409 | transition not allowed from current state |
| `SHIFT_OVERLAP` | 409 | guard already has a shift in that period |
| `SHIFT_NOT_ACTIVE` | 409 | operation needs an ACTIVE shift |
| `SHIFT_OUTSIDE_START_WINDOW` | 422 | too early or after the start deadline |
| `TRACKING_PERMISSION_REQUIRED` | 422 | phone-reported permission insufficient under policy |
| `LOCATION_FIX_REQUIRED` | 422 | no fresh fix attached |
| `STARTED_OFF_SITE_BLOCKED` | 422 | start outside geofence when policy is BLOCK |
| `OUTSIDE_SHIFT_WINDOW` | 422 | location captured outside the shift window |
| `TIMESTAMP_TOO_OLD` | 422 | beyond maximum offline age |
| `DEVICE_NOT_REGISTERED` | 403 | missing or unknown X-Device-Id |
| `DEVICE_REVOKED` | 403 | device revoked |
| `INVALID_QR` | 422 | unknown, rotated, archived or foreign QR |
| `LAST_OWNER` | 409 | would leave the organization without an owner |
| `SELF_ROLE_CHANGE` | 403 | attempt to change own role or status |
| `INVITATION_EXPIRED` | 410 | invitation or enrollment code expired, used or revoked |
| `ENROLLMENT_CODE_INVALID` | 422 | wrong enrollment code, or the code doesn't match the phone number |
| `ATTACHMENT_TOO_LARGE` | 413 | over size limit |
| `ATTACHMENT_TYPE_NOT_ALLOWED` | 415 | content does not match an allowed type |
| `EXPORT_RANGE_TOO_LARGE` | 422 | export range > 92 days |
| `APP_VERSION_UNSUPPORTED` | 426 | below minimum (not returned for SOS or queued uploads unless revoked) |
| `RATE_LIMITED` | 429 | with Retry-After |
| `INTERNAL_ERROR` | 500 | no internals exposed |
| `NOT_READY` | 503 | dependency unavailable |
