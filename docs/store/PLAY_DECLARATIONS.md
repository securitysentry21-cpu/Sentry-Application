# Google Play declarations and the demo video script

> **DRAFT for owner review. Date: 2026-11-08.** Prepared by an AI coding assistant from the code and the specifications. Google changes these forms and policies often (EXT-45). **Re-read each current policy page and the live Play Console form on the day of submission.** Open points are marked `[OWNER TO CONFIRM: ...]` and `[LAWYER: ...]`.

**Covers:** EXT-04 (foreground service), EXT-05 (background location), EXT-20 (monitoring tool), the permissions declaration, and the demo video (`docs/EXTERNAL_DEPENDENCIES.md`).
**App:** `[APP NAME]` (working name SENTRY), package `pk.sentryops.guard`. Android only for now; iOS comes later (`APP_STORE_PRIVACY.md`).
**When:** at the first Play track release. The Play organization account must exist first (EXT-03, which waits for the D-U-N-S number, EXT-01). Plan for **at least two review rounds** (`docs/ARCHITECTURE.md` §20.1, EXT-05).

**Honesty rule for every text below:** nothing here claims that something has been tested on a device unless the test has been done. The device tests (reboot, app killed, long shift, battery) are run by people and are **pending** (`docs/testing/device-matrix.md`, `docs/phases/phase-10/PLAN.md`). Where a statement depends on them, it is marked.

---

## 1. Background location declaration (EXT-05)

### 1.1 What the app does with background location

- The guard app is for **employees of private security companies.** The company sets up the guard's shift and gives the guard a code to enrol their own phone.
- During an active shift, and during an SOS, the app records the phone's location and sends it to the company's control room (live map, geofence alerts, patrol verification).
- It needs location while the screen is off and the app is not in front, because a guard keeps the phone in a pocket for an 8 to 12 hour shift.
- Outside a shift and an SOS, **no location is collected.** The server also rejects any location captured outside a shift or SOS and does not store it.

Source: `docs/PRODUCT_SPEC.md` §8.1, §16; `docs/SECURITY_AND_INVARIANTS.md` INV-08.

### 1.2 Text for the form's "describe the feature" box

> Our app is used by security guards employed by private security companies. During a shift that the guard starts in the app, it shares the phone's location with the guard's employer's control room so that the employer can confirm the guard is at the assigned site, verify patrol checkpoints, and respond if the guard needs help. Location is collected only between "Start shift" and "End shift" (and during an SOS the guard raises). It is collected when the app is closed or the screen is off, because the phone is in the guard's pocket during the shift. A persistent notification is shown while tracking runs. Before any permission request the guard reads and accepts an in-app notice that explains what is collected, when, why, who sees it and how long it is kept.

`[OWNER TO CONFIRM: the box may have a character limit. Shorten to fit and keep the first and third sentences.]`

### 1.3 Why a foreground-only permission is not enough

Google may ask why the app cannot work with location only while the app is in use. Our reasons, which must be stated honestly:

1. A guard's shift lasts many hours with the screen off. The app runs a location **foreground service** with a visible notification, started when the guard taps "Start shift".
2. If the phone restarts or Android ends the app's process during a shift, the app must **resume tracking by itself.** Without background location permission, Android does not let a location service that is started from the background read location. The guard may not notice for a long time, and the employer would see a gap.
3. The app holds `RECEIVE_BOOT_COMPLETED` for this resume and the task manager restores the location task after a reboot.

Source: `docs/DECISIONS.md` D-35 ("The justification is automatic resumption after a reboot or an OS kill during a shift"); `docs/ARCHITECTURE.md` §8.2, §20.1 (EXT-05); `apps/mobile/android-permissions.ts`.

**Do not overclaim.** The reboot and process-kill behaviour is **designed** but not yet proven on real phones. ADV-O05 ("phone rebooted mid-shift") is a device test waiting for a human. `[OWNER TO CONFIRM: show it working in the video only after the device tests pass, and say "resumes where Android allows it", as the design says.]` The design also tells the guard when tracking could not resume: "Tracking was interrupted from–to" and an alert on the dashboard (`ARCHITECTURE.md` §8.8).

**Why precise location:** patrol checkpoints and site geofences can be 10 to 100 metres wide, so approximate location cannot verify them. Source: `docs/PRODUCT_SPEC.md` §5.2, §5.3.

**Fallback if Google refuses:** tap-to-resume tracking without the background permission. The tracking code must keep working without it (`DECISIONS.md` D-35; `ARCHITECTURE.md` §8.2). `[OWNER TO CONFIRM: build this fallback before the first submission, or accept a delay.]`

### 1.4 The in-app disclosure to show Google (English)

Shown at the start, before any permission request, in English or Urdu; accepted with "I understand". Exact current text (`apps/mobile/src/core/i18n/disclosure.ts`, version `1`):

> **Why we need your location**
> During an active security shift, the app uses your location to:
> • verify you are at your assigned site;
> • record patrol activity;
> • help supervisors respond to emergencies.
> Location tracking runs only during your assigned shift and during an SOS. It stops when your shift ends.
> What is collected: your location and its accuracy, and the phone's tracking status (location permission, battery, connection). Nothing is collected outside shifts and an SOS.
> Who sees it: your company's supervisors and administrators. Every view of your location history is recorded.
> How long it is kept: your company's settings decide. By default, location is kept for 90 days.
> While tracking is on, Android shows a notification that you cannot swipe away, and iPhone shows the location indicator.
> Android may show a notice that SENTRY is a workplace monitoring app. Google Play requires this notice; it is expected.

**Do not submit this text unchanged.** `docs/legal/GUARD_DISCLOSURE_CHECK.md` finds that it is incomplete about who sees the data, what is collected and how long it is kept; that it does not say location is collected when the app is closed or not in use (Google's wording); and that two claims need checking (the unremovable notification, "stops when your shift ends"). The version Google sees must be the final reviewed version, in the build you upload.

Then, before the system prompt for "Allow all the time", the app shows (`perm.backgroundExplain`): "Next, choose 'Allow all the time' for SENTRY. It uses your location only during your shift and an SOS, also when the screen is off."

### 1.5 Other answers the form usually asks for

| Question                                              | Proposed answer                                                                                                                                                                                                                                                 | Source                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Does the app collect location data in the background? | Yes                                                                                                                                                                                                                                                             | Above                                                                   |
| Is location sold or shared for advertising?           | No. No advertising code and no data sales.                                                                                                                                                                                                                      | `PRODUCT_SPEC.md` §2.2                                                  |
| Can the user stop tracking?                           | Yes: "End shift" stops it at once, and the guard can remove permission in Android settings (the app then shows "Tracking problem" and reports it). Supervisors see the gap. A shift's scheduled end plus the auto-end limit (default 60 minutes) also stops it. | `en.ts` (`shift.endConfirm`, `problem.*`); `PRODUCT_SPEC.md` Appendix B |
| Video                                                 | `[VIDEO LINK: unlisted, no sign-in needed]`, script in section 5                                                                                                                                                                                                | —                                                                       |

---

## 2. Foreground service declaration (EXT-04)

| Field                                    | Answer                                                                                                                                        | Source                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Foreground service type                  | `location`                                                                                                                                    | `apps/mobile/scripts/android-manifest.ts` checks `foregroundServiceType="location"` in every release build (ADV-X08, EXT-31) |
| Permissions                              | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`                                                                                           | `apps/mobile/android-permissions.ts`                                                                                         |
| What task does the service perform?      | Collects location fixes during an active shift (or SOS) and stores them in a local queue; the queue uploads to the guard's employer's server. | `apps/mobile/src/platform/location.ts`; `docs/ARCHITECTURE.md` §8                                                            |
| Why must it run in a foreground service? | It must continue while the screen is off and the app is not on screen, for hours. Short background work would be killed by Android.           | `ARCHITECTURE.md` §8.2                                                                                                       |
| How does the user know it runs?          | A persistent notification: "SENTRY — Shift active — sharing location with {organization} until your shift ends".                              | `en.ts` `notification.body`                                                                                                  |
| How is it started?                       | By the guard tapping "Start shift" in the foreground (and restored after a reboot or process kill during a shift).                            | `ARCHITECTURE.md` §8.2; EXT-31                                                                                               |
| How does it stop?                        | "End shift", the shift's local auto-end deadline, the server saying the shift is no longer active, sign-out, or a revoked device.             | `ARCHITECTURE.md` §8.8                                                                                                       |
| Wake locks                               | None held through the shift. Wake-ups come from location callbacks.                                                                           | `ARCHITECTURE.md` §8.4; EXT-46                                                                                               |
| Video                                    | Shows the service starting and its notification (section 5)                                                                                   | —                                                                                                                            |

---

## 3. Permissions declaration

The full list is in `apps/mobile/android-permissions.ts` and is checked in every release build against the merged manifest (ADV-X08). A library that adds an unlisted permission fails the build.

| Permission                    | Why the app has it                                                                                                 | Needs a Play declaration?                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `ACCESS_FINE_LOCATION`        | Precise location during shifts, for site geofences and checkpoint checks                                           | Part of the location story; prominent disclosure |
| `ACCESS_COARSE_LOCATION`      | Android requires it together with fine location                                                                    | Same                                             |
| `ACCESS_BACKGROUND_LOCATION`  | "Allow all the time": resume tracking after a reboot or process kill during a shift (section 1)                    | **Yes** (EXT-05)                                 |
| `FOREGROUND_SERVICE`          | The shift's location service                                                                                       | Part of EXT-04                                   |
| `FOREGROUND_SERVICE_LOCATION` | The service's declared type on Android 14 and later                                                                | **Yes** (EXT-04)                                 |
| `POST_NOTIFICATIONS`          | The persistent tracking notification and shift messages (Android 13 and later)                                     | No                                               |
| `RECEIVE_BOOT_COMPLETED`      | Lets the task manager restore an active shift's location updates after a reboot                                    | No (expect a question; see section 1.3)          |
| `CAMERA`                      | Scan QR codes (enrollment, patrol checkpoints) and take incident photos. The camera is used only on those screens. | No                                               |
| `VIBRATE`                     | Haptic feedback for critical actions and the SOS hold                                                              | No                                               |
| `ACCESS_NETWORK_STATE`        | Upload when the network returns. It is only a hint; success is judged by the server's answer.                      | No                                               |
| `INTERNET`                    | Added by React Native itself                                                                                       | No                                               |

**Blocked in every build** (`BLOCKED_ANDROID_PERMISSIONS`): audio recording, contacts, accounts, phone state and numbers, call and SMS permissions (`SEND_SMS`, `RECEIVE_SMS`, `READ_SMS`, `CALL_PHONE`, call logs), storage and media-library permissions, Wi-Fi state, activity recognition, battery-optimization exemption request, exact alarms, full-screen intents, Bluetooth, NFC, body sensors, biometrics, **advertising ID**. In release builds the system-alert-window overlay is also blocked.

Points a reviewer may raise:

- **"Call supervisor"** opens the dialer with the company's number. The app does not hold `CALL_PHONE`; the guard presses call.
- **"Send SMS"** opens the messaging app with a prefilled text. The app does not hold `SEND_SMS`; the guard presses send (EXT-34).
- **Battery optimization:** the app opens the system settings page. It does not request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (EXT-33).
- **Photos:** gallery images come through the system photo picker, which needs no storage permission (D-18).
- **Target API level:** the build must target API 36 (checked in CI, `MIN_TARGET_SDK`; EXT-06).
- **Backups:** cloud backup is off (`allowBackup: false`), so location queues and identity are never copied to another phone.

---

## 4. Enterprise monitoring tool declaration (EXT-20)

### 4.1 What the build declares

`apps/mobile/app.config.ts` adds `<meta-data android:name="isMonitoringTool" android:value="enterprise_management" />` to the application element in every build on every track (`withMonitoringToolDeclaration`). CI fails if it is missing or has another value (ADV-X08, `apps/mobile/scripts/android-manifest.ts`).

`[OWNER TO CONFIRM — TOP RISK: open Google's current Play policy page on monitoring apps and check that "enterprise_management" is an accepted value for this flag, and what else the policy asks. The repository records this value but its register says every item "must be re-verified against the current official source" (EXT-45). If the accepted value is different, the manifest and the ADV-X08 rule must change together.]`

### 4.2 Statement for the form or a review reply

> The app is designed for private security companies to manage their own guards during assigned shifts. It is not designed or marketed for secret monitoring of anyone. The guard's phone is enrolled with a code that the employer gives to the guard in person. Before any location permission is requested, the guard sees an in-app notice that says what is collected, when, why, who can see it and how long it is kept, and taps "I understand"; the acceptance is recorded with the notice version and language. While tracking runs the app shows a persistent notification and cannot be hidden. Tracking starts only when the guard starts a shift and stops when the shift ends. The app does not collect contacts, messages, calls, microphone audio or other apps' data. The employer's supervisors see the guard's location only through the employer's dashboard, and each view of location history is recorded in an audit log.

Every claim in the paragraph is backed: `docs/PRODUCT_SPEC.md` §4.3, §7.2, §8.1; `docs/SECURITY_AND_INVARIANTS.md` §16; `apps/mobile/android-permissions.ts`. The tracking notice wording itself must be fixed first (section 1.4).

### 4.3 Listing disclosure

The store listing must state the monitoring purpose. A ready sentence is in `LISTINGS.md` section 2.4.

### 4.4 Persistent-notification rule

The register notes: "The policy also requires a persistent notification whenever the app is running; whether that extends outside shifts must be confirmed against the policy text (EXT-20)." Today the app shows the notification only while the location service runs (during a shift or SOS). Outside a shift the app tracks nothing, so there is no service and no notification. `[OWNER TO CONFIRM: read the policy and decide whether a notification is needed when the app is merely open.]`

### 4.5 Android developer verification (EXT-47)

Google is introducing developer verification for apps on certified phones, including apps installed directly. This matters for the pilot's direct installs (D-34) and for 2027. It is not a store declaration, but register the app in the Play Console once the organization account exists. Source: `docs/EXTERNAL_DEPENDENCIES.md` EXT-47.

---

## 5. Demo video script

**Goal:** show Google's reviewer, on a real Android phone, (a) the in-app disclosure, (b) every location permission request, (c) the foreground service and its notification, (d) background location in use with the screen off, (e) that tracking stops. Use the **demo organization** (`REVIEW_NOTES.md`), never real people.

**Rules.** One continuous screen recording of a real Android 14 or newer phone (a test phone, not a personal one). Show the Android version once, if easy (Settings > About). Clean phone: no personal notifications, accounts, wallpapers or contacts. Use the demo guard's number and code only. Enable "Show touches". Record in English. Add captions. Host it where reviewers can open it without signing in (an unlisted video link). Length: as short as the story allows, about 3 to 4 minutes. `[OWNER TO CONFIRM: any size or length limit on the current form.]`

**Before filming (checklist).**

- [ ] Final reviewed tracking notice is in the build (section 1.4)
- [ ] A fresh single-use demo enrollment code exists (never written in this repository)
- [ ] The demo shift is startable (`REVIEW_NOTES.md`)
- [ ] The dashboard is open on a second screen with the demo organization and a guard visible on the live map
- [ ] Phone is a release build from the same pipeline as the one you upload

### 5.1 Shot list

| #   | Time | On screen                                                                                                                                                         | Voice-over (read aloud)                                                                                                                                                                                                                                                                                                                     |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 0:00 | Title card: app name, package name, one line: "Shift-based location sharing for security guards".                                                                 | "This is the guard app for [APP NAME]. Security companies use it so that their guards share their location with the company's control room while they are on shift. This video shows the disclosure, the permissions, and background location in use."                                                                                      |
| 2   | 0:15 | Phone home screen. Tap the app icon. Language screen. Tap "English".                                                                                              | "A guard installs the app from the store and opens it."                                                                                                                                                                                                                                                                                     |
| 3   | 0:25 | Enrollment screen. Type the demo code and the demo guard's number. Tap "Set up phone".                                                                            | "The guard's supervisor gives them a single-use code. The guard enters it with their own mobile number. This is a demo company with no real people."                                                                                                                                                                                        |
| 4   | 0:50 | The tracking notice, full screen. Scroll slowly through all of it, then pause.                                                                                    | "Before any permission is requested, the app shows this notice. It says what is collected, when, why, who sees it and how long it is kept. Location is collected only during the guard's shift and during an SOS. It is collected when the app is closed or the screen is off." _(Say the last sentence only if the final notice says it.)_ |
| 5   | 1:15 | Tap "I understand".                                                                                                                                               | "The guard taps 'I understand'. The app records which version they accepted."                                                                                                                                                                                                                                                               |
| 6   | 1:25 | Readiness card. Tap "Allow notifications": the system prompt appears. Tap "Allow".                                                                                | "First the app asks for notifications, which it needs to show the tracking notification."                                                                                                                                                                                                                                                   |
| 7   | 1:40 | Tap "Allow location". System prompt appears: choose precise, "While using the app".                                                                               | "Next, location. The app needs precise location to confirm the guard is at the site."                                                                                                                                                                                                                                                       |
| 8   | 1:55 | The explanation: "Next, choose 'Allow all the time'...". Tap "Allow all the time". Android Settings opens: choose "Allow all the time". Back to the app.          | "Then the app explains why it needs 'Allow all the time': tracking must continue during the shift when the screen is off. Android sends the guard to settings to choose it."                                                                                                                                                                |
| 9   | 2:20 | Battery optimization: tap "Battery settings", show the system page, go back.                                                                                      | "Some phones stop apps in the background, so the app opens the system battery page. The guard chooses."                                                                                                                                                                                                                                     |
| 10  | 2:35 | Tap "Start shift". "Getting your location…" then "SHIFT ACTIVE".                                                                                                  | "The guard taps Start shift. Tracking begins only now."                                                                                                                                                                                                                                                                                     |
| 11  | 2:50 | Pull down the notification shade. Zoom on the persistent notification "Shift active — sharing location with Demo Company until your shift ends".                  | "While tracking runs, Android shows this notification. It stays for the whole shift."                                                                                                                                                                                                                                                       |
| 12  | 3:00 | Press the home button. Open another app briefly. Lock the screen. Wait 30 seconds. Unlock and show the notification still there and "Tracking active · 20 s ago". | "The guard puts the phone away. The screen is off and the app is in the background. Tracking continues."                                                                                                                                                                                                                                    |
| 13  | 3:20 | Second screen: the dashboard live map. The demo guard's marker is visible with "LIVE · last update …".                                                            | "On the company's dashboard the supervisor sees the guard's position and how recent it is."                                                                                                                                                                                                                                                 |
| 14  | 3:35 | _(Optional. Only after the device tests pass.)_ Swipe the app away from recent apps. The notification stays. Dashboard still updates.                             | "If the guard closes the app, tracking continues, because it runs as a foreground service."                                                                                                                                                                                                                                                 |
| 15  | 3:50 | Tap "End shift", "Yes, end shift". Notification disappears. "Tracking off". Dashboard marker changes.                                                             | "When the guard ends the shift, tracking stops at once and the notification goes."                                                                                                                                                                                                                                                          |
| 16  | 4:05 | Closing card: the privacy policy URL.                                                                                                                             | "The app collects no contacts, audio, messages or other apps' data. Our privacy policy is at this address. Thank you."                                                                                                                                                                                                                      |

### 5.2 Things not to do in the video

- Do not show a real person's name, number, photo or home address.
- Do not show a real enrollment code after filming. Expire or use up the demo code once the video is shot, and issue a new one for the reviewers.
- Do not say or show the word "guarantee", "emergency services" or any claim the product does not make (see `LISTINGS.md`).
- Do not show SOS being pressed unless the SOS feature is switched on in the reviewed build. If it is, use the demo organization (drill only) and say: "SOS alerts the company's control room. It does not call the police or an ambulance." Source: `en.ts` `sos.disclaimer`.

### 5.3 Possible reviewer questions and answers

| Question                                  | Answer                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Is location used for anything else?       | No. Shift verification, patrol verification and, when SOS is on, emergencies (`PRODUCT_SPEC.md` §8).                              |
| Who is the user? Can anyone install it?   | The user is an employee of a security company. The app does nothing without a code from the employer.                             |
| Is it hidden?                             | No. A persistent notification and an in-app status are always visible while it runs.                                              |
| What if the user declines the permission? | The app explains what is missing and how to fix it, never crashes or loops, and does not start tracking (`PRODUCT_SPEC.md` §4.3). |
| Why not a foreground-only permission?     | Section 1.3                                                                                                                       |

---

## 6. Order of work

1. Fix and review the tracking notice (`docs/legal/GUARD_DISCLOSURE_CHECK.md`), including the Urdu text.
2. Check the monitoring-tool flag against Google's policy (4.1).
3. Run the device tests.
4. Build the release build, film the video (section 5), upload the build.
5. Fill the Data safety form (`DATA_SAFETY_PLAY.md`) and these declarations.
6. Submit and expect questions.
