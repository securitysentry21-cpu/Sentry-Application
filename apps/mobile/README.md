# Guard app (Expo SDK 57)

The native app is for **guards only**. Supervisors and duty officers use the web dashboard (D-04).

This is the app's framework: enrollment, the tracking disclosure, shifts, shift-bound background
tracking with a durable outbox and sync, heartbeats and device status, text incidents, the SOS
client (switched off for the pilot by `features.sos`), diagnostics, English and Urdu. It talks to
the API through the shared contract in `packages/contracts/src/mobile.ts`.

**Nothing here has run on a phone yet.** The logic is unit-tested in Node and the JavaScript
bundle builds; everything that needs a real device is listed under [Device tests](#device-tests-human).

## Structure

```text
apps/mobile/
  app.config.ts        variants, identifiers, permissions, iOS texts, config plugins
  eas.json             EAS build profiles (development, staging, production)
  index.ts             entry: defines the background location task, then registers the app
  src/core/            the app's logic, pure TypeScript: no React Native, no Expo (a test enforces it)
    app.ts             GuardApp: one engine per JS runtime, shared by screens and the location task
    api/               fetch-free API client, error types, the device-bound session (refresh)
    outbox/            the durable queue: lanes, partitions, batches, receipts, drops
    storage/           the SQL interface, the local schema and its migrations, key-value metadata
    sync/              the main-lane sync engine and the backoff rules
    sos/               the SOS client state machine and the SOS lane (session or device signature)
    shift/             the phone's per-shift state machine (incl. the end-of-shift failsafe)
    tracking/          fix conversion, sampling, device status, readiness
    i18n/              English and Urdu dictionaries, the versioned disclosure, time formatting
    device-key.ts      P-256 key, SPKI export, X-Device-Signature
    ids.ts, time.ts, server-time.ts, config.ts, log.ts, status.ts, presenter.ts, ports.ts
  src/platform/        adapters from the core's ports to Expo/React Native modules
  src/ui/              React Native screens; state-driven navigation (no navigation library)
  test/                Vitest unit tests for src/core (Node's built-in SQLite stands in for expo-sqlite)
```

The core receives every phone capability through small interfaces (`src/core/ports.ts`): secure
storage, the SQL database, HTTP, the location source, the device probe, clocks and randomness. The
platform layer implements them with `expo-secure-store`, `expo-sqlite`, `fetch`, `expo-location` +
`expo-task-manager`, `expo-battery` / `expo-network`, `performance.now()` and `expo-crypto`. Tests
implement them with fakes and a scripted fake API (`test/support/fake-server.ts`) that validates every
request with the same zod schemas as the real server.

## How it works

- **Enrollment** (ARCH §5.3): code (typed or scanned from the dashboard's QR) and the guard's own
  number → `POST /enrollments/redeem` with the installation ID and the device's public key (P-256,
  base64 SPKI DER). The returned session is kept in the secure store.
- **Disclosure** (PROD §7.2): shown before any permission request and again when the server's
  `disclosureVersion` changes; acceptance goes to `POST /tracking-consents`. Only text bundled in the
  build can be accepted: a version this build does not contain blocks tracking and asks for an update.
- **Shifts**: `GET /me/shifts`, shown in each site's timezone, 24-hour. Start takes an on-demand fix
  (≤ 10 s, best accuracy), queues `SHIFT_START` and starts tracking at once, also offline (D-06). The
  screen says "Shift started on this phone — waiting to confirm with server" until the server has
  **accepted the start and reports the shift ACTIVE** (ADV-O02). A rejected start stops tracking,
  shows the reason and drops the shift's queued points (ADV-O03). End stops tracking immediately.
- **Tracking** (D-07, ARCH §8): `expo-location` background updates into an `expo-task-manager` task
  defined at module top level (`src/platform/location-task.ts`), so it runs headless with the
  screens closed. Android: foreground service with the notification "Shift active — sharing location
  with ‹Organization› until your shift ends", kept when the app is swiped away. iOS:
  `pausesUpdatesAutomatically: false`, background indicator on. The sampler keeps a point every
  20 m (≥ 15 s apart, ≥ 1 per 60 s) moving and one per 5 min stationary (PROD §8.2); intervals come
  from `GET /mobile/config`. Every callback first checks the **failsafe deadline** (endsAt +
  autoEndAfterMinutes; ADV-SH05) using server-corrected time with a monotonic floor, so turning the
  phone clock back does not postpone it.
- **Heartbeats and device status** (ARCH §8.4): a `HEARTBEAT` every `sync.heartbeatIntervalS` during
  a shift, and `DEVICE_STATUS` at once on a change (permission, precise, location services,
  notifications, power saver, charging, battery thresholds, tracking service) and every 15 minutes.
- **Outbox** (ARCH §8.6): SQLite in app-private storage, every write in a transaction, schema
  migrations tested (ADV-O08), partitioned by organization and guard (ADV-O07). Main lane in `seq`
  order, one batch in flight, ≤ 500 items and ≤ 256 KB per batch; a formed batch is persisted, so a
  failed or interrupted upload is resent with the same `batchId` and item IDs. Item types whose
  feature is off (INCIDENT, CHECKPOINT_SCAN) are held, never sent. ACCEPTED, DUPLICATE,
  QUARANTINED and REJECTED are final; RETRY and unanswered items stay in place. Backoff: full jitter,
  base 5 s, cap 5 min; `Retry-After` is always honoured. Items older than `maxOfflineAgeHours` (+6 h
  margin) are dropped (points, heartbeats, status only); above 20,000 queued points the oldest are
  thinned to one per minute. Every drop is counted and blocks "All data sent" until the guard has
  read the notice (ADV-U03).
- **Session** (D-30): access token renewed shortly before expiry or once after a 401, single-flight;
  the rotated refresh token is written to the secure store before the new access token is used. A
  refused renewal (401, device revoked) signs the phone out: tracking stops, the queue stays, the
  screen says "Signed out by your organization — pending data cannot be sent".
- **Incidents** (PROD §7.8): text only, during an active shift, and only when `features.incidents` is
  on (off until the server's incident phase ships).
- **SOS** (ARCH §13.1): saved first, then `POST /sos` at once on its own lane, never behind the main
  lane, never held by its backoff or by an update screen. Without a usable session the request is
  signed with the device key (`X-Device-Signature`, INV-15). The phone shows QUEUED / SENDING /
  RECEIVED / FAILED only as confirmed (INV-10). The SOS button exists only when `features.sos` is on.

## Running it

Background location needs native configuration, so the app runs as a **development build, never in
Expo Go** (EXT-44). The Android SDK and Java are needed locally (not installed on the owner's
machine), or EAS can build in the cloud.

```bash
# from apps/mobile
npx expo run:android          # debug build on an emulator or a USB-connected phone, served by Metro
npx expo start                # Metro only, for an already installed debug build
eas build --profile development --platform android   # the same debug build, built by EAS
```

The development variant talks to `http://10.0.2.2:4000` (the development machine as seen from the
Android emulator; `pnpm api:dev` serves the API there). On a physical phone set the machine's LAN
address: `EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:4000 npx expo run:android`. Debug builds allow
plain HTTP; release builds do not.

### Variants (SEC §11, ARCH §19.7)

| `APP_VARIANT`           | Identifier                   | Name           | API origin                                                 |
| ----------------------- | ---------------------------- | -------------- | ---------------------------------------------------------- |
| `development` (default) | `pk.sentryops.guard.dev`     | SENTRY Dev     | `EXPO_PUBLIC_API_BASE_URL`, default `http://10.0.2.2:4000` |
| `staging`               | `pk.sentryops.guard.staging` | SENTRY Staging | `EXPO_PUBLIC_API_BASE_URL`, required, HTTPS                |
| `production`            | `pk.sentryops.guard`         | SENTRY         | must equal `PRODUCTION_API_ORIGIN` in `app.config.ts`      |

The three install side by side. A staging or development build can never point at production:
once `PRODUCTION_API_ORIGIN` is set (in code, reviewed, when the domain exists) any other variant
using it fails to build, and until it is set no production build can be made at all. The origin is
checked again at runtime (`src/core/config.ts`). Set the staging and production URLs as EAS
environment variables, not in `eas.json`.

## Tests

```bash
node node_modules/vitest/vitest.mjs run --project mobile    # from the repository root
pnpm --filter @sentryops/mobile test                        # the same, through pnpm
```

They cover the outbox (ordering, lanes, partitions, batches surviving a closed database, size caps,
thinning, drops), migrations (a schema-1 queue upgraded and still sent; shipped migrations pinned by
hash), the sync engine (per-item results, same batch on retry, one batch in flight, backoff,
`Retry-After`, quarantine, 426, sign-out), session renewal (single-flight, rotation stored first,
refusals), the shift state machine and failsafe, SOS states and lane (offline, lost responses,
device-signed fallback verified with node:crypto), the device-key signature, UUIDv7, i18n key and
placeholder parity, honest status wording, logging hygiene, and whole flows against the fake API
(offline start, rejected start, token expiry offline, a lent phone, a killed app). Test names carry
the SEC IDs they prove on the phone's side; the server side of those IDs is the API's job.

## Time and the monotonic clock

ARCH §8.7 wants `monoMs` from a clock that keeps counting in deep sleep (Android
`SystemClock.elapsedRealtime`, iOS `mach_continuous_time`) and `bootId` from the boot count. Expo has
no API for either, so this build uses:

- `monoMs` = `performance.now()`, made monotonic and integral. It starts near 0 when the JavaScript
  process starts. **On both platforms it may stop advancing while the phone is in deep sleep**, so
  `sentMonoMs − monoMs` can understate how long ago an item was captured if the phone slept in
  between. The server should treat the monotonic estimate as a lower bound on age, compare it with
  the device clock, and prefer the device clock when the two disagree by more than its tolerance.
- `bootId` = a random ID per process run (`run-…`). A new run (app killed, reboot, update) means a new
  clock: the server must use the monotonic estimate only within one run.
- **Every item carries the `bootId` of the run its `monoMs` was taken in** (the contract's optional
  item `bootId`). Every batch carries the run that sends it (`bootId`, `sentMonoMs`), also when it is
  a retry formed in an earlier run. The server uses the monotonic estimate only for items whose
  `bootId` equals the batch's; items from an earlier run, or without a `bootId`, fall back to the phone
  clock. A SHIFT_END recovered after a kill (End tapped, item not yet queued) has no `bootId`.
- Location fixes carry no monotonic time from the library: an item's `monoMs` is the callback's,
  minus the fix's age by the phone clock (trusted only up to 10 minutes; otherwise the callback time).

Phase 0B should add a small native module for `elapsedRealtime` / `mach_continuous_time` and a boot
count; the `MonoClock` interface (`src/core/time.ts`) is where it plugs in.

## What the server must match

- `X-Device-Signature: v1.<timestampMs>.<base64url(signature)>`, ECDSA P-256 over SHA-256 of the
  UTF-8 string `v1\n<METHOD>\n<path incl. /api/v1>\n<timestampMs>\n<base64url(sha256(body bytes))>`,
  signature as raw 64-byte r‖s (IEEE P1363), low-S. Verified in `test/device-key.test.ts` with
  `crypto.verify('sha256', data, { key, format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' }, sig)`.
  The phone corrects the timestamp by its last measured server offset; the body is sent byte for byte.
  With the signature the request carries `X-Device-Id` and no `Authorization`.
- Item `bootId` as above; the batch `bootId` / `sentMonoMs` are always the sending run's.
- INCIDENT and CHECKPOINT_SCAN are never sent while `features.incidents` / `features.patrols` are off:
  the app does not create them, and anything already queued waits on the phone (counted as pending).
- The bundled disclosure version is **`"1"`**: `GET /mobile/config` must return `disclosureVersion: "1"`
  until a new text ships in an app update.
- The app version is **`0.1.0`** (`X-App-Version`; `minSupportedVersion` must not exceed it).
- `POST /tracking-consents` may answer any 2xx; its body is not read.
- A sync response's `shifts` should list every shift the batch touched: it is how the phone learns
  the server's state ("server state wins", ARCH §8.8).

## On-device data (ARCH §8.11, SEC §11)

- SQLite file `sentry-outbox.db` in app-private storage; deleted rows after the server's answer.
  `android.allowBackup` is off, so it never reaches Google's cloud backup. **iOS gap:** excluding it
  from iCloud backup needs `NSURLIsExcludedFromBackupKey`, which Expo does not expose (to do with a
  native module or a config plugin before the iOS release). Encryption at rest: D-27, open.
- Secure store (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`): installation ID, device key (32-byte secret,
  hex), session tokens (one value, replaced atomically). Readable while the phone is locked, so the
  location task can upload. Because iOS keeps Keychain items after an uninstall, a fresh database
  wipes them: a reinstall is a new installation.
- The device key is a software key in the secure store, not a hardware-backed Keystore / Secure
  Enclave key (round-6 decision; revisit in Phase 0B).
- Logs carry event names and allow-listed IDs and counts only: no tokens, codes, coordinates, phone
  numbers or incident text (SEC §15; tested).
- Over-the-air updates are off (`expo-updates` is not installed); every change ships as a build.

## Native permissions

Android asks for exactly: fine, coarse and background location, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `CAMERA`, `VIBRATE`,
`ACCESS_NETWORK_STATE`, plus React Native's `INTERNET`. `blockedPermissions` removes what libraries
add and the product must not have (microphone, contacts, phone, SMS, storage, motion, exact alarms,
battery-optimization requests, full-screen intents, Wi-Fi state, Bluetooth, NFC, biometrics, the
advertising ID; and the dev-menu overlay outside development). The Play monitoring-tool declaration
(`<meta-data android:name="isMonitoringTool" android:value="enterprise_management"/>`, EXT-20) is
added by a config plugin in every variant. iOS: `UIBackgroundModes` = `location` only (the plugin
removes the `fetch` mode expo-task-manager adds), product-specific location and camera texts, no
Face ID, microphone or motion texts, App Transport Security strict outside development, and a
privacy manifest declaring the boot-time API behind `monoMs`.

Checked with `npx expo config --type introspect` (the app's own manifest and Info.plist after all
plugins). The **merged** release manifest, which includes every library's manifest, only exists after
a Gradle build: the CI check ADV-X08 needs the Android SDK and is not built yet.

## Device tests (human)

Device tests are run by people on real phones (ARCH §21.3); none of the following has been done.

1. **ADV-O04** Start a shift, put the phone in airplane mode, walk for 10 minutes, swipe the app away,
   reopen it: the queue count is unchanged, tracking resumed, everything uploads once online.
2. **ADV-O05** Reboot mid-shift: does tracking resume by itself (BOOT_COMPLETED restores the task where
   Android allows a location service to start), or is the gap visible on the dashboard?
3. **ADV-O08** Install this build, start a shift offline, then install a newer build over it: the
   queue survives and the local schema migrates.
4. **ADV-U02** Revoke location permission mid-shift (and switch to approximate, and turn location off):
   the banner appears within one heartbeat and the dashboard shows the problem.
5. Permission flows on Android 13–16 and on the pilot customer's phones (Xiaomi, Oppo/Realme, Vivo,
   Samsung, Infinix/Tecno): notifications, precise location, "Allow all the time" (sent to Settings),
   battery-optimization settings; declining never loops or crashes.
6. The 12-hour screen-off soak per matrix device: gaps, battery %/h, MB per shift (the 5 MB budget
   counts HTTP overhead too: one request per minute).
7. Headless delivery: with the app swiped away, points and heartbeats keep arriving at the server.
8. A start with the foreground-service notification on Android 14+, the persistent notification text,
   and the iOS background-location indicator.
9. Urdu: right-to-left layout on every screen, line height and font fallback on low-end phones
   (Noto Nastaliq Urdu, D-14), 200 % system font size.
10. QR enrollment with the camera; the clock warning after setting the phone 5 minutes off.
11. **ADV-S11** (once SOS is switched on, Phase 8): an SOS with an expired session is accepted by the
    real server through the device signature.

## Not in this build

Patrol scans (Phase 7; the outbox and sync already carry `CHECKPOINT_SCAN`), incident photos and SOS
cancel/status polling (Phase 8; `GET /sos/:id` is not in the contract yet), push notifications
(Phase 5), the readiness items for manufacturer background restrictions and automatic time, a
proper icon set (the buttons use text symbols), the "Send diagnostics" upload, and a native
monotonic clock.
