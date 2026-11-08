# Apple App Store privacy answers and review notes

> **DRAFT for owner review. Date: 2026-11-08.** Prepared by an AI coding assistant from the code and the specifications. **iOS comes later:** there is no iOS build, no Apple Developer account and no App Store Connect record yet. These answers describe what the app is expected to send once an iOS build exists, based on the shared code. Apple changes its forms and guidelines often (EXT-45): **re-check everything on the day you submit.** Open points are marked `[OWNER TO CONFIRM: ...]` and `[LAWYER: ...]`.

**App:** `[APP NAME]` (working name SENTRY), bundle identifier `pk.sentryops.guard` (can still change until the first submission; `docs/DECISIONS.md` Q-20).

## 1. Where iOS stands

| Item                                         | Status                                                                         | Source                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Apple Developer Program (organization)       | **Not started.** Waits for the D-U-N-S number.                                 | `docs/EXTERNAL_DEPENDENCIES.md` EXT-01, EXT-02           |
| Distribution route                           | Public or unlisted App Store. Apple Business custom apps do not list Pakistan. | EXT-23; `docs/PRODUCT_SPEC.md` D-25                      |
| iOS build                                    | None. The shared code is written for both platforms; Android goes first.       | `docs/DECISIONS.md` D-26; `docs/phases/phase-10/PLAN.md` |
| Push (APNs)                                  | Waits for the Apple account. The server can send; the phone does not register. | EXT-09; D-26                                             |
| iOS `Info.plist` check in CI                 | Waits for a macOS build.                                                       | `PLAN.md` A2                                             |
| Critical Alerts entitlement                  | **Not needed** (no native supervisor app).                                     | EXT-07; D-04                                             |
| Temporary full accuracy for checkpoint scans | **Not built.** An approximate fix gives "QR only", never a wrong verification. | `docs/DECISIONS.md` (Phase 7)                            |
| Notifications state in the phone report      | Android only today ("iOS needs expo-notifications")                            | `apps/mobile/src/platform/device.ts`                     |

## 2. App Privacy answers ("nutrition label")

Apple asks which data types the app collects, whether each is linked to the user's identity, whether it is used to track the user, and for what purposes. "Collect" means data leaves the device in a way the developer or a partner can read.

**Tracking.** The app does not track users. Apple defines tracking as linking data with other companies' data for advertising, or sharing it with data brokers. The app has no advertising or analytics code and the privacy manifest sets `NSPrivacyTracking` to false (`apps/mobile/app.config.ts`). **Answer: "No, we do not track."**

**Third-party partners.** Apple's label includes data collected by third-party code in the app. The app contains none beyond the Expo and React Native libraries and no analytics, advertising or crash SDK (`apps/mobile/DEPENDENCIES.md`). The employer (our customer) receives the data, but it is not "third-party code" in the app. `[OWNER TO CONFIRM: ask Apple's current wording whether data we pass to the employer must be declared differently. The Play form treats the employer as a third party, see DATA_SAFETY_PLAY.md section 4.]`

| Apple category                                                                                                                | Data type                                                       | Collected?                          | Linked to identity?                              | Used to track? | Purposes (Apple's list)                                  | What and source                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ | -------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contact Info                                                                                                                  | **Phone Number**                                                | Yes                                 | Yes                                              | No             | App Functionality                                        | Guard types it at enrollment. `packages/contracts/src/mobile.ts` (`enrollmentRedeemRequestSchema.phone`)                                                                                                                                                               |
| Contact Info                                                                                                                  | Name, Email Address, Physical Address, Other                    | **No**                              | —                                                | —              | —                                                        | The company enters names in the dashboard. Nothing is sent from the phone.                                                                                                                                                                                             |
| Location                                                                                                                      | **Precise Location**                                            | Yes                                 | Yes                                              | No             | App Functionality                                        | During shifts and SOS only. `mobile.ts` `fixSchema`; `docs/SECURITY_AND_INVARIANTS.md` INV-08                                                                                                                                                                          |
| Location                                                                                                                      | Coarse Location                                                 | No (precise covers it)              | —                                                | —              | —                                                        |                                                                                                                                                                                                                                                                        |
| Identifiers                                                                                                                   | **User ID**                                                     | Yes                                 | Yes                                              | No             | App Functionality                                        | Session tokens and device ID identify the guard.                                                                                                                                                                                                                       |
| Identifiers                                                                                                                   | **Device ID**                                                   | Yes                                 | Yes                                              | No             | App Functionality                                        | A random installation ID made by the app and the device public key. **Not** the advertising identifier. `docs/ARCHITECTURE.md` §5.4                                                                                                                                    |
| User Content                                                                                                                  | **Photos or Videos**                                            | Yes (photos only; optional)         | Yes                                              | No             | App Functionality                                        | Incident photos, re-encoded on the phone without metadata. `apps/mobile/src/platform/photos.ts`                                                                                                                                                                        |
| User Content                                                                                                                  | **Other User Content**                                          | Yes (optional)                      | Yes                                              | No             | App Functionality                                        | Incident title, description and notes the guard types.                                                                                                                                                                                                                 |
| User Content                                                                                                                  | Audio Data; Emails or Text Messages; Customer Support; Gameplay | **No**                              | —                                                | —              | —                                                        |                                                                                                                                                                                                                                                                        |
| Usage Data                                                                                                                    | **Product Interaction**                                         | Yes                                 | Yes                                              | No             | App Functionality                                        | Shift start and end, checkpoint scans, incident submissions, SOS presses. Work records, not analytics.                                                                                                                                                                 |
| Usage Data                                                                                                                    | Advertising Data; Other Usage Data                              | **No**                              | —                                                | —              | —                                                        |                                                                                                                                                                                                                                                                        |
| Diagnostics                                                                                                                   | **Crash Data**                                                  | Yes (when the crash reporter ships) | Yes (carries opaque device and organization IDs) | No             | App Functionality; `[OWNER TO CONFIRM: also Analytics?]` | Scrubbed report to our own API: error type name, source-file:line:column of our code, versions, platform, fatal flag, timestamp. No message text, names, numbers, locations or incident text. Written to our service log, kept 30 days. `docs/DECISIONS.md` (Phase 10) |
| Diagnostics                                                                                                                   | **Other Diagnostic Data**                                       | Yes                                 | Yes                                              | No             | App Functionality                                        | Phone status during shifts: permission, precise or approximate, location services, battery level and charging, power-saver, tracking-service state, unsent-queue size. `mobile.ts` `deviceStatusSchema`                                                                |
| Diagnostics                                                                                                                   | Performance Data                                                | No                                  | —                                                | —              | —                                                        |                                                                                                                                                                                                                                                                        |
| Sensitive Info; Health and Fitness; Financial Info; Contacts; Search History; Browsing History; Purchases; Surroundings; Body | —                                                               | **No**                              | —                                                | —              | —                                                        | Not asked and not sent                                                                                                                                                                                                                                                 |

`[LAWYER: free text in incident reports could contain anything, including sensitive information. Does Apple's label need "Sensitive Info"? The app does not ask for it.]`

**Privacy policy URL:** `[PRIVACY POLICY URL: [DOMAIN]/privacy]`. **User privacy choices URL (optional):** `[OWNER TO CONFIRM]`.

## 3. Privacy manifest and purpose strings

Already in `apps/mobile/app.config.ts` (the iOS part):

| Item                 | Setting                                                                                                        | Source                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `NSPrivacyTracking`  | `false`                                                                                                        | `app.config.ts`                              |
| Required-reason APIs | System boot time (reason `35F9.1`); user defaults (`CA92.1`); file timestamp (`C617.1`); disk space (`E174.1`) | `app.config.ts`; `docs/ARCHITECTURE.md` §8.2 |
| Background mode      | `location` only. The `fetch` mode that `expo-task-manager` adds is removed.                                    | `withoutBackgroundFetch`                     |
| Plain HTTP           | App Transport Security with no exceptions outside development                                                  | `app.config.ts`                              |

`[OWNER TO CONFIRM: the manifest of each third-party library must be merged at build time on macOS. Check the generated privacy report then.]`

**Purpose strings (English only today):**

| Key                     | Text                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location when in use    | "SENTRY uses your location during your security shift to confirm you are at your assigned site and to help your control room in an emergency."                                |
| Location always         | "SENTRY shares your location with your security company's control room while your shift is active, including when the screen is locked. Tracking stops when your shift ends." |
| Camera                  | "SENTRY uses the camera to scan QR codes (your enrollment code and patrol checkpoint labels) and to take the photos you add to an incident report."                           |
| Photos                  | "SENTRY opens your photos only when you choose one to add to an incident report."                                                                                             |
| Temporary full accuracy | "SENTRY needs your precise location to confirm this patrol checkpoint scan." (declared; the feature is not built)                                                             |

Source: `apps/mobile/app.config.ts` (`IOS_USAGE`). Issues to settle before submission:

- **No Urdu version** of these strings exists. `[OWNER TO CONFIRM: add Urdu InfoPlist localizations if the guard's iPhone is set to Urdu; needs the native-speaker review.]`
- The "always" string says tracking "stops when your shift ends", and the app can run up to the auto-end limit (default 60 minutes) after the scheduled end. See `docs/legal/GUARD_DISCLOSURE_CHECK.md` M-06b.
- The "in an emergency" wording must match the SOS wording below (EXT-21).

## 4. SOS must be described as alerting the control room (EXT-21)

Apple guideline 5.1.5 says location-based APIs must not be used to provide emergency services. The product is built to avoid the claim (`docs/PRODUCT_SPEC.md` §11.1; `docs/EXTERNAL_DEPENDENCIES.md` EXT-21):

- The app says: "SOS alerts your company's control room. It does not call the police or an ambulance." (`apps/mobile/src/core/i18n/en.ts` `sos.disclaimer`).
- The listing, the review notes and the privacy policy say the same.
- Never use "emergency services", "emergency response", "rescue" or "help is on the way" for SOS in any Apple-facing text.
- The word "emergency" in the current location string (`whenInUse` above) can be read as an emergency service. `[OWNER TO CONFIRM: reword to "to help your control room if you need help"]`.

## 5. Text for App Review Information > Notes

Paste after the placeholders are filled. Keep it short.

> **What the app is.** [APP NAME] is a business app for employees of private security companies. A security company assigns a guard a shift. The guard starts the shift in the app, and the app shares the phone's location with the company's control room until the shift ends. It also lets the guard scan patrol checkpoints with the camera, report incidents with photos, and send an SOS to the company's control room. There is no public sign-up: a guard needs a one-time enrollment code from their employer.
>
> **How to sign in.** Use the demo company. Open the app, choose English, enter the enrollment code `[DEMO ENROLLMENT CODE: generated by the owner at submission]` and the phone number `[DEMO GUARD PHONE NUMBER: shown in the submission form]`. No SMS is needed. Then accept the tracking notice. Full steps are in the attachment/notes: `[REVIEW STEPS: see REVIEW_NOTES.md]`.
>
> **Background location (why).** The app uses the `location` background mode only while a shift is active, after the guard taps "Start shift". iOS shows the blue location indicator while it runs. Tracking stops at "End shift". The guard sees an explanation and the notice before any permission request. We use "Always" because a guard keeps the phone locked in a pocket for a whole shift.
>
> **SOS.** The SOS button alerts the guard's own company's control room and its duty officers. **It does not contact the police, an ambulance or any emergency service**, and the app, the listing and these notes say so. In the demo company, SOS is a drill and is routed only to our own test recipients. `[OWNER TO CONFIRM: SOS may be switched off in the first review build; then say "SOS is not enabled in this build."]`
>
> **Camera and photos.** The camera is used only to scan QR codes and to take incident photos. Gallery photos come through the system photo picker. The app has no microphone access and no contacts access.
>
> **Accounts.** Accounts are created by the employer, not in the app. There is no sign-up and no in-app purchase. `[OWNER TO CONFIRM: Apple's current rules on account deletion; guards cannot create accounts in the app.]`
>
> **Privacy.** No advertising, analytics or tracking. Privacy policy: `[PRIVACY POLICY URL]`. Contact for review questions: `[REVIEW CONTACT NAME, EMAIL, PHONE]`.

Sources: `docs/PRODUCT_SPEC.md` §11.1, §17; `docs/EXTERNAL_DEPENDENCIES.md` EXT-08, EXT-21, EXT-22; `apps/mobile/app.config.ts`.

## 6. Why the reviewer gets a code instead of an SMS

Apple requires a working demo account (guideline 2.1 in the register, EXT-22). A reviewer outside Pakistan cannot receive a +92 SMS. So the notes carry a pre-issued, single-use demo enrollment code. Codes expire after 7 days and allow 5 wrong tries. Issue the code close to submission and be ready to issue another if the review takes longer. Source: `docs/PRODUCT_SPEC.md` §17; `docs/SECURITY_AND_INVARIANTS.md` §5, §9. `REVIEW_NOTES.md` has the full procedure.

## 7. Risks to expect

| Risk                                 | Why                                                     | What to do                                                                                              |
| ------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Rejection for background location    | Apple wants "Always" justified by a user-facing feature | Show the shift flow in the notes and the blue indicator; keep the notice and purpose strings consistent |
| Rejection for "emergency" wording    | Guideline 5.1.5                                         | Section 4                                                                                               |
| Cannot sign in                       | Login-gated app, +92 numbers                            | Section 6; a demo that always works (`REVIEW_NOTES.md` section 3)                                       |
| Questions about monitoring employees | Location tracking of workers                            | The in-app notice, the in-app indicator, the employer-only audience                                     |
| Mismatch between label and app       | The notice in the app is incomplete today               | Fix the notice first (`docs/legal/GUARD_DISCLOSURE_CHECK.md`)                                           |
