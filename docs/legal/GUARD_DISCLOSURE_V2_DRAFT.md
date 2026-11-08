# Guard disclosure V2: corrected draft

> **DRAFT for lawyer review, then a native Urdu speaker. Not legal advice. Date: 2026-11-08.**
> Prepared by an AI coding assistant from the code and the specifications. It proposes a corrected version of the tracking notice that guards see in the app. **The app text has not been changed and stays as it is (version `1`) until the lawyer, the owner and a native Urdu speaker approve this draft.** This file changes nothing else: not `apps/mobile/src/core/i18n/disclosure.ts`, not `CURRENT_DISCLOSURE_VERSION`. Open points are marked `[LAWYER: ...]`, `[OWNER TO CONFIRM: ...]` and, for Urdu, `[URDU REVIEW: ...]`. Text in such markers is not part of the notice.

**Where the mismatches come from:** `docs/legal/GUARD_DISCLOSURE_CHECK.md` (IDs M-01 and so on). Every fact below was checked against the code on 2026-11-08 where the "Source" column says so; section 6 lists what could not be checked.

## 1. Status, and what changes in the app if this is approved

**Nothing changes in the app today.** If the draft is approved (possibly after edits), someone must do the following, in a separate piece of work:

1. **Add a new version of the text.** A new key (for example `'2'`) goes into `DISCLOSURES` in `apps/mobile/src/core/i18n/disclosure.ts`, in English and Urdu. Version `'1'` stays in the file. The notice has the shape the screen draws (`apps/mobile/src/ui/screens/Disclosure.tsx`): a title, an intro, a bullet list ("purposes") and paragraphs. This draft keeps that shape and the order of the existing parts.
2. **Name it as the current version.** `CURRENT_DISCLOSURE_VERSION` in `packages/contracts/src/mobile.ts` (the server announces it in `GET /mobile/config`; `apps/api/src/config.ts` line 51 reads it from `DISCLOSURE_VERSION`, default = the constant; no Terraform file sets it today).
3. **Release order matters.** A phone whose build does not contain the announced version shows "Your organization has a new tracking notice that this version of the app cannot show. Update the app." and **has no button to accept** (`Disclosure.tsx`, `disclosure.unknownVersion`). The guard then cannot start a shift. So the new app build must reach the guards **before** the server announces the new version. The `DISCLOSURE_VERSION` setting can hold `1` on the server until then.
4. **Tests.** `apps/mobile/test/i18n.test.ts` requires the same number of bullets and paragraphs in English and Urdu, at least three bullets, and (for version `1` only) a first paragraph containing "only during your assigned shift and during an SOS". A new version needs its own checks. No `{placeholders}` are used in this draft, so the placeholder test is not affected.

**What every guard then experiences.** When the app is opened and tracking is not running, the notice is shown again (`apps/mobile/src/ui/App.tsx` line 167: `consent.required && !tracking`). The guard taps "I understand" and the app records the acceptance with the version and language (`POST /tracking-consents`, append-only, audit action `TRACKING_CONSENT_RECORDED`). The readiness check treats "notice accepted" as blocking, so **a shift cannot be started until the new notice is accepted** (`apps/mobile/src/core/tracking/readiness.ts` line 42). A guard who is already tracking is never interrupted mid-shift (PROD §7.2: "a new disclosure version is shown again before the next shift start").

**SOS on or off.** SOS exists in the app but is off for pilot guards (`FEATURE_SOS=false`, `infra/terraform/cell/services.tf`; the button is hidden when `features.sos` is false). Section 2 gives one text (**Text A, SOS off**) and a list of exact replacements (**Variant B, SOS on**). The simplest way to use both is two versions: `'2'` now, and `'3'` on the day SOS is switched on. Version `'3'` would make every guard accept again, which is right because a new kind of collection (location every 10 seconds, also off shift) starts. `[OWNER TO CONFIRM: is that the plan, or one text for both?]`

**Length.** The corrected Text A is about 550 words; today's notice is about 150, so this is nearly four times as long, more than "a little longer". The extra words are the facts the check found missing (who, what exactly, how long, what is not collected, backups, error reports, who to ask). Paragraphs are kept short and each has one subject. If a shorter screen is wanted, see section 2.3 for what to cut first, and question 5 in section 5.

## 2. Proposed English text

Written for a guard reading on a phone, often in poor light: plain words, short sentences. Parts are labelled (T, I, B, P) only so the table in section 3 and the Urdu in section 4 can point to them; the labels are not shown to guards. **The order of the existing parts is unchanged.** New parts sit next to the part they belong to.

### 2.1 Text A: SOS off (use for the pilot)

**T. Title**

Why we need your location

**I. Intro**

During an active security shift, the app uses your location to:

**B. Bullets**

- **B1.** verify you are at your assigned site;
- **B2.** record patrol activity and shift times;
- **B3.** tell your company's control room if something looks wrong, for example if you leave your site.

**P1. When tracking runs and when it stops**

Location tracking runs only during your assigned shift, also when the app is closed or the screen is off. It stops when you tap End shift. If you forget, it stops by itself 60 minutes after your shift was due to end (the default). It also stops if your company ends your shift and your phone gets that message.

`[OWNER TO CONFIRM: the "closed or screen off" words answer Google's rule for background location (check doc M-11). Re-read Google's current policy text before the store submission. If Google refuses "Allow all the time" and the fallback in ARCH §20 is used (tap to resume), this sentence is no longer true.]`
`[LAWYER: "60 minutes" is the default of shift.auto_end_after_minutes (range 15 to 240). Say "the default" as here, or give a fixed number, or leave the number out?]`

**P2. What is collected: location**

What is collected during your shift: your location and its accuracy; speed, direction and height, when the phone gives them; the location source; whether the phone says the location is fake; and the time. A fresh location is also taken when you start or end a shift, scan a checkpoint or send an incident report. An incident report also holds what you write and your photos.

**P3. What is collected: your phone**

We also collect your phone's status: battery level, charging and power saver; whether location and notifications are allowed; battery-optimization and automatic-time settings; whether tracking is running; and how many updates are waiting to be sent. We also collect your phone's brand, model and system version, and the app version.

**P4. Outside shifts**

Outside shifts, no location is collected. We still hold your mobile number and phone details from set-up, and a record that you accepted this notice. Our servers also see your phone's internet (IP) address and may keep it in security records.

`[OWNER TO CONFIRM: "may keep it": PRIVACY_POLICY.md 3.5 says the request log very likely holds it for 30 days but nobody has read a real log line. Audit records do store the IP address and the app's user-agent text (apps/api/src/repositories/audit.ts lines 45-46), including for the guard's acceptance of this notice.]`

**P5. What is not collected**

We do not collect your contacts, microphone, call history, text messages, other apps or photo library. The app opens only the photos you choose.

**P6. Who sees it**

Who sees it: in your company, owners, administrators, supervisors and dispatchers (control room staff) see your live location and phone status during your shift. Owners, administrators and supervisors can also open and export your location history. Dispatchers also see the location sent with an incident report. Every view of location history is recorded; looking at the live map is not. Other guards cannot see your location.

`[LAWYER: name the roles as here, or say only "your company's control room staff and managers"? Naming is exact and matches PROD §3.2; a generic phrase is shorter but hides that owners and dispatchers are included.]`
`[LAWYER: this draft says nothing about our own staff. Under SEC §4.6 and D-19 the platform operator has no standing access, but may open a company's data in an emergency, for a limited time, with a reason, recorded as PLATFORM_ACCESS in the company's audit log. Must guards be told? Optional sentence if yes: "Our own staff can open your company's data only in an emergency, for a short time and with a written reason. Each time is recorded in your company's log."]`

**P7. How long it is kept**

How long it is kept (default settings; some can be changed): location, including positions in shift and patrol records, 90 days; phone status, 30 days; shift, patrol and incident records, 12 months after they close; records of actions in the dashboard (audit records), 24 months. Location and photos saved with an incident stay as long as that incident. Backups can keep deleted data for up to 35 days.

`[LAWYER: publish the numbers (as here) or keep them out and refer to the privacy policy? SEC §16.5 requires the 35-day backup period to be disclosed "in the privacy policy"; this draft also puts it here. PROD §16 and Appendix B call all defaults "product defaults, not legal requirements; legal review required".]`
`[OWNER TO CONFIRM: 35 days is the production setting (infra/terraform/cell/variables.tf, db_backup_retention_days). Production is not built; the test environment keeps 1 day.]`

**P8. What the guard sees while tracking is on**

While tracking is on, the app shows a notification in your notification bar. iPhone shows the location indicator.

`[OWNER TO CONFIRM: remove the iPhone sentence until an iOS build exists (check doc M-13)? The current notice says it too.]`

**P9. Android monitoring notice** (unchanged from version 1)

Android may show a notice that SENTRY is a workplace monitoring app. Google Play requires this notice; it is expected.

**P10. Error reports**

If the app has a problem, it sends our server a short error report: the kind of error, where it happened in the app, the app and system versions, and ID codes for your phone and company. It has no names, numbers, locations or incident text. It is kept 30 days.

`[OWNER TO CONFIRM: check this list against the finished crash-report code. The contract (packages/contracts/src/diagnostics.ts) and the route (apps/api/src/routes/diagnostics.ts) match it; the phone-side scrubbing was not re-read for this draft.]`

**P11. Your data, and who to ask**

You can see your own shifts and incident reports in the app, but not your location history. Your company decides how your data is used. To ask for a copy of your data, or to ask a question, contact [COMPANY CONTACT]. More: [PRIVACY POLICY URL].

`[OWNER TO CONFIRM: the notice is the same text for every company (it is bundled in the app), so a single [COMPANY CONTACT] cannot be written into it. Options: say "your supervisor or your company's office"; or add a per-company contact to GET /mobile/config (a code change). Which?]`
`[LAWYER: is "ask your company" enough for a guard's rights, given that the first version has no tool to delete or anonymise a guard's data (PRIVACY_POLICY.md 11)? The text deliberately promises a copy, not deletion.]`

### 2.2 Variant B: SOS on (exact changes to Text A)

Use this only when SOS is switched on for the guards who will read it.

| Part          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B4** (new)  | Add a fourth bullet: "tell your control room if you press SOS."                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **P1**        | Replace the first sentence with: "Location tracking runs only during your assigned shift and during an SOS, also when the app is closed or the screen is off." (This keeps the sentence the existing test checks.)                                                                                                                                                                                                                                                                                                           |
| **P1b** (new) | Add after P1: "SOS: when you hold the SOS button, the app sends an alert and your location about every 10 seconds, also when you are not on a shift. This goes on until your company closes the SOS, or for 4 hours at most. SOS alerts your company's control room. It does not call the police or an ambulance. The app cannot promise that anyone will see your alert or answer it. If there is no network, the app can write a text message with your name, site, location and time. It is sent only if you press send." |
| **P2**        | In the second sentence, end with: "...scan a checkpoint, send an incident report or press SOS."                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **P4**        | First sentence: "Outside shifts and an SOS, no location is collected."                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **P6**        | Replace the dispatcher sentence with: "Dispatchers also see the location sent with an incident report or an SOS." Then add after it: "When you press SOS, control room staff are alerted first, then administrators and owners, and your company's emergency contacts may get a text message."                                                                                                                                                                                                                               |
| **P7**        | Change the records item to "shift, patrol, incident and SOS records, 12 months after they close" and the next sentence to "Location and photos saved with an incident or SOS stay as long as that record."                                                                                                                                                                                                                                                                                                                   |

`[LAWYER: the SOS paragraph says what the product does and refuses to promise delivery or a response, as PROD §11.1 and INV-10 require. Is "The app cannot promise that anyone will see your alert or answer it" the right strength?]`
`[OWNER TO CONFIRM: the text message in P1b is the phone's own fallback (PROD §11.7: the guard must press send; it holds name, site, position and time). The emergency-contact text in P6 needs an SMS provider, which is not chosen yet (EXT-10); drop that clause until one exists.]`

**Optional one-liner for Text A (SOS off), if the owner wants guards told:** "The SOS button is not switched on in your app yet. If you need urgent help, call your supervisor or the emergency number." Place it after P1. `[OWNER TO CONFIRM: keep, or say nothing about a button the guard cannot see? The sentence gives advice (call the emergency number) and is not a product promise.]`

### 2.3 If the lawyer wants it shorter: cut in this order

1. In P2 and P3, the fine-grain items: "the location source", "battery-optimization and automatic-time settings", "whether tracking is running". The privacy policy section 3.1 lists them.
2. P8's iPhone sentence, until iOS exists.
3. In P7, the audit-record item.
4. P10, the list of what an error report holds (keep "no names, numbers, locations or incident text" and "30 days").

Do not cut: who sees it (P6), when it stops (P1), what is not collected (P5), backups (P7), who to ask (P11).

## 3. Change table

Current wording is from `apps/mobile/src/core/i18n/disclosure.ts`, version `1`. "Check" means `docs/legal/GUARD_DISCLOSURE_CHECK.md`.

| ID   | Current wording                                                                                                                     | Proposed wording                                                                                                                                                                                                                                                  | Why                                                                                                                                                                                                                                                                                                                  | Source                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | B3 "help supervisors respond to emergencies."                                                                                       | B3 "tell your company's control room if something looks wrong, for example if you leave your site." Variant B adds B4 "tell your control room if you press SOS."                                                                                                  | SOS is off for pilot guards, so "emergencies" promised a feature they do not have (M-05). The alerts that do run are left site, tracking problems, offline, late or missed shift, missed checkpoint. "Control room" is the app's own word.                                                                           | Check D4, S-1; `infra/terraform/cell/services.tf` (FEATURE_SOS); `apps/api/src/routes/mobile.ts` line 78; `apps/mobile/src/ui/screens/Home.tsx`; `en.ts` `sos.disclaimer`; PROD §12.1                                                             |
| C-02 | B2 "record patrol activity;"                                                                                                        | B2 "record patrol activity and shift times;"                                                                                                                                                                                                                      | Completeness, not a listed mismatch: start and end times feed attendance records and reports. `[LAWYER: must the notice also say whether the company may use the data for pay or discipline?]`                                                                                                                       | PROD §6.8, §15; Check section 3                                                                                                                                                                                                                   |
| C-03 | P1 "Location tracking runs only during your assigned shift and during an SOS."                                                      | Text A: "...only during your assigned shift, also when the app is closed or the screen is off." Variant B keeps "and during an SOS" and adds the same words.                                                                                                      | Text A: no SOS exists for these guards. Both: Google's rule for background location asks for words like "when the app is closed or not in use" (M-11).                                                                                                                                                               | Check M-05, M-11, S-9; PROD §7.3, §8.1; `docs/ARCHITECTURE.md` §20 (background location and its fallback)                                                                                                                                         |
| C-04 | P1 "It stops when your shift ends."                                                                                                 | "It stops when you tap End shift. If you forget, it stops by itself 60 minutes after your shift was due to end (the default). It also stops if your company ends your shift and your phone gets that message."                                                    | Tracking stops at once on "End shift". If the guard forgets, the phone's own deadline is the scheduled end plus `shift.auto_end_after_minutes` (default 60, range 15 to 240). A shift the company ends stops tracking when the phone next hears it (M-06b).                                                          | `apps/mobile/src/core/shift/local-shift.ts` (`END_QUEUED`, `CLOCK`, `failsafeDeadlineMs`, `SERVER_STATUS`); PROD §6.6, Appendix B; `packages/contracts/src/settings.ts`                                                                           |
| C-05 | P2 "What is collected: your location and its accuracy, and the phone's tracking status (location permission, battery, connection)." | P2 and P3: the full list (location, accuracy, speed, direction, height, source, fake-location flag, time; battery, charging, power saver, location and notification state, settings, queue size; brand, model, system and app version). "Connection" is dropped.  | Incomplete list (M-02). The status has no "connection" field: it holds the unsent-queue size and the last sync time.                                                                                                                                                                                                 | `packages/contracts/src/mobile.ts` (`fixSchema` 128-141, `deviceStatusSchema` 158-173, `enrollmentRedeemRequestSchema` 25-38); `apps/mobile/src/core/tracking/device-status.ts`; Check section 3                                                  |
| C-06 | (not said)                                                                                                                          | P2: a fresh location at start, end, checkpoint scan and incident report; an incident report holds what the guard writes and the photos.                                                                                                                           | The notice never said these. The server keeps coordinates for them only inside a shift or an SOS; outside one it stores no coordinates (SEC §16.2).                                                                                                                                                                  | `mobile.ts` `syncItemSchema` (`INCIDENT`, `CHECKPOINT_SCAN`, `SHIFT_START`, `SHIFT_END`); PROD §8.2, §10; SEC §16.2                                                                                                                               |
| C-07 | P2 "Nothing is collected outside shifts and an SOS."                                                                                | P4 "Outside shifts, no location is collected. We still hold your mobile number and phone details from set-up, and a record that you accepted this notice. Our servers also see your phone's internet (IP) address and may keep it in security records."           | "Nothing" is untrue: set-up sends the mobile number, phone brand, model and system version, app version, an installation ID and a public key; the acceptance is stored; servers see IP addresses (M-03). Phone status is sent only while a shift is tracked (read from the call sites, not device-tested).           | `mobile.ts` `enrollmentRedeemRequestSchema`; `apps/api/src/repositories/guards.ts` `insertConsent`; `apps/api/src/repositories/audit.ts` 45-46; `apps/mobile/src/core/app.ts` (`#reportDeviceStatus` call sites); `PRIVACY_POLICY.md` 3.5         |
| C-08 | (not said)                                                                                                                          | P5 "We do not collect your contacts, microphone, call history, text messages, other apps or photo library. The app opens only the photos you choose."                                                                                                             | The spec promises this list; guards are never shown it (M-07). The blocked-permission list backs it.                                                                                                                                                                                                                 | PROD §16; SEC §16.2; `apps/mobile/android-permissions.ts` (blocked: `READ_CONTACTS`, `RECORD_AUDIO`, `READ_CALL_LOG`, `READ_SMS`, media and activity-recognition permissions)                                                                     |
| C-09 | P3 "Who sees it: your company's supervisors and administrators."                                                                    | P6 names owners, administrators, supervisors and dispatchers for live location and phone status; owners, administrators and supervisors for history and export; other guards: none.                                                                               | Owners and dispatchers were left out (M-01). Live: `live.read`. History and exports: `location.history.read`. A guard has neither.                                                                                                                                                                                   | PROD §3.2; `packages/contracts/src/permissions.ts` (`DISPATCHER`, `SUPERVISOR`, `ADMIN`, `OWNER`, `GUARD`); `apps/api/src/routes/live.ts` (policies); `packages/contracts/src/live.ts` (`liveGuardSchema`: battery, charging, app version, queue) |
| C-10 | (not said)                                                                                                                          | P6 "Dispatchers also see the location sent with an incident report." Variant B: "...or an SOS."                                                                                                                                                                   | A dispatcher has `incidents.read` (the incident detail returns its location) and `sos.read` (the SOS detail returns the position and trail, audited as `SOS_VIEWED`), although PROD §3.2 shows "-" for a dispatcher's location history. The notice must not suggest dispatchers see no location beyond the live map. | `permissions.ts` (`DISPATCHER`); `apps/api/src/routes/incidents.ts` line 126; `packages/contracts/src/incidents.ts` 131-137; `apps/api/src/routes/sos.ts` 143-148; `packages/contracts/src/sos.ts` 15-17, 50-52                                   |
| C-11 | P3 "Every view of your location history is recorded."                                                                               | P6 "Every view of location history is recorded; looking at the live map is not."                                                                                                                                                                                  | The live map is not recorded; a guard could read "location history" as "any view" (M-12).                                                                                                                                                                                                                            | `apps/api/src/routes/live.ts` (`STREAM_POLICY` has `audit: null`; history route audits `LOCATION_HISTORY_VIEWED`); SEC INV-14; PROD §3.2                                                                                                          |
| C-12 | P4 "How long it is kept: your company's settings decide. By default, location is kept for 90 days."                                 | P7: location 90 days (also the positions in shift and patrol records); phone status 30 days; shift, patrol and incident records 12 months after they close; audit records 24 months; incident location and photos as long as the incident; backups up to 35 days. | Only the 90 days was said (M-04). SEC §16.5 requires the backup period to be disclosed. "Your company's settings decide" overstates: only `retention.location_days` can be edited in the dashboard; the others are set by the operator.                                                                              | PROD Appendix B, §16; SEC §16.5; `docs/DECISIONS.md` Phase 9 (operational records, positions on records); `apps/api/src/services/retention.ts`; `packages/contracts/src/settings.ts` 173-177; `infra/terraform/cell/variables.tf`                 |
| C-13 | P5 "While tracking is on, Android shows a notification that you cannot swipe away, and iPhone shows the location indicator."        | P8 "While tracking is on, the app shows a notification in your notification bar. iPhone shows the location indicator."                                                                                                                                            | "Cannot swipe away" is not verified on newer Android (M-06). The code starts a foreground service with a notification and sets no "cannot dismiss" option. The iPhone clause describes a build that does not exist (M-13).                                                                                           | `apps/mobile/src/platform/location.ts` (`foregroundService`); PROD §16; Check D12                                                                                                                                                                 |
| C-14 | P6 "Android may show a notice that SENTRY is a workplace monitoring app. Google Play requires this notice; it is expected."         | P9 unchanged.                                                                                                                                                                                                                                                     | Matches PROD §7.2 and the `isMonitoringTool` declaration. How and when Android or Play shows it is untested on a device.                                                                                                                                                                                             | PROD §7.2; `apps/mobile/app.config.ts` 72-78; Check D13                                                                                                                                                                                           |
| C-15 | (not said)                                                                                                                          | P10 error reports: what they hold, that they hold no names, numbers, locations or incident text, kept 30 days.                                                                                                                                                    | New feature (M-18). Fields are held to identifier-like patterns by the schema; the API writes them to the service log only; the log group is kept 30 days.                                                                                                                                                           | `packages/contracts/src/diagnostics.ts`; `apps/api/src/routes/diagnostics.ts`; `docs/DECISIONS.md` Phase 10; `infra/terraform/cell/services.tf` line 30                                                                                           |
| C-16 | (not said)                                                                                                                          | P11 own shifts and reports visible in the app, not the location history; the company decides; ask the company for a copy; contact and policy placeholders.                                                                                                        | Guards are not told how to get their data (M-08, S-7). An Owner or Administrator can export one guard's data, location included (`exports.guard_data`). The app's shift list covers the last 24 hours and the next 7 days, not a full history (see section 6, item D1).                                              | PROD §16; SEC §16.3, §16.6; `docs/DECISIONS.md` Phase 9 ("A guard's data"); `apps/api/src/routes/shifts.ts` 631-653; `en.ts` `incident.mine.none`                                                                                                 |
| C-17 | (not said)                                                                                                                          | Variant B: paragraph P1b about SOS, with the 10-second interval, off-shift tracking, the 4-hour limit, the "does not call the police" line and no promise of an answer.                                                                                           | SOS wording must match the product (check P5 to P7, M-15): the interval, off-shift start, the 4-hour limit (`trackingUntil`), the phone's text-message fallback (guard must press send).                                                                                                                             | PROD §11.1, §11.2, §11.7, §11.4; `en.ts` `sos.disclaimer`; `packages/contracts/src/mobile.ts` (`sosStatusResponseSchema.trackingUntil`); `apps/api/src/services/notifications.ts` 503-515                                                         |
| C-18 | Button "I understand" (`disclosure.accept`)                                                                                         | Unchanged in this draft.                                                                                                                                                                                                                                          | Whether a tap is valid consent for employee monitoring is a legal question (M-14). The button is not part of the notice text.                                                                                                                                                                                        | Check D14; `en.ts` `disclosure.accept`                                                                                                                                                                                                            |
| C-19 | Footer "Notice version 1"                                                                                                           | Shows the new version number by itself.                                                                                                                                                                                                                           | The footer is `disclosure.version` with the version as its only placeholder.                                                                                                                                                                                                                                         | `en.ts` / `ur.ts` `disclosure.version`                                                                                                                                                                                                            |

## 4. Urdu: suggested wording

> **THIS IS A SUGGESTION. It must be reviewed and rewritten as needed by a native Urdu speaker before any guard sees it.** The author reads Urdu but is not a native speaker. Sentences are kept short and literal. Words are reused from the current notice and from `apps/mobile/src/core/i18n/ur.ts` where the same idea exists there: لوکیشن, ٹریکنگ, شفٹ, سپروائزر, ایڈمنسٹریٹرز, کنٹرول روم, سائٹ, گشت, چیک پوائنٹ, واقعے کی رپورٹ, درستگی, اپڈیٹس, فون کی حالت, نوٹیفکیشن, حذف, ریکارڈ ہوتا ہے, "میں نے سمجھ لیا". New words that the author is unsure about are marked `[URDU REVIEW: ...]` on the line below. Terms such as SOS, IP and SENTRY stay in Latin letters, as in the current text (check doc U5, U7). The same number of bullets and paragraphs as in the English is kept (the test requires it). No `{placeholders}` are used. "By default" is written "طے شدہ" (preset), not "عام طور پر" (usually), because of check doc U1. The word "بروقت" (check doc U2) is not used.

### 4.1 Text A: SOS off

**T. Title** (unchanged)

ہمیں آپ کی لوکیشن کیوں چاہیے

**I. Intro** (unchanged)

سیکیورٹی شفٹ کے دوران یہ ایپ آپ کی لوکیشن ان کاموں کے لیے استعمال کرتی ہے:

**B1.** (unchanged)

یہ تصدیق کرنا کہ آپ اپنی مقررہ سائٹ پر موجود ہیں؛

**B2.**

گشت کی سرگرمی اور شفٹ کے اوقات ریکارڈ کرنا؛

`[URDU REVIEW: "شفٹ کے اوقات" for "shift times". Check it reads as start and end times.]`

**B3.**

اگر کچھ غلط لگے تو آپ کی کمپنی کے کنٹرول روم کو اطلاع دینا، مثلاً جب آپ سائٹ چھوڑ دیں۔

`[URDU REVIEW: "اگر کچھ غلط لگے" for "if something looks wrong". "اطلاع دینا" follows sos.disclaimer.]`

**P1.**

لوکیشن ٹریکنگ صرف آپ کی مقررہ شفٹ کے دوران چلتی ہے، ایپ بند ہو یا اسکرین بند ہو تب بھی۔ جب آپ "شفٹ ختم کریں" دبائیں تو یہ بند ہو جاتی ہے۔ اگر آپ بھول جائیں تو یہ شفٹ ختم ہونے کے مقررہ وقت سے 60 منٹ بعد (طے شدہ طور پر) خود بند ہو جاتی ہے۔ اگر آپ کی کمپنی آپ کی شفٹ ختم کر دے اور فون کو یہ اطلاع مل جائے تو بھی یہ بند ہو جاتی ہے۔

`[URDU REVIEW: "ایپ بند ہو یا اسکرین بند ہو تب بھی" for "also when the app is closed or the screen is off". "شفٹ ختم کریں" is the button label in ur.ts. "طے شدہ طور پر" for "by default" (see U1). Check that "the shift was due to end" is clear in "شفٹ ختم ہونے کے مقررہ وقت".]`

**P2.**

شفٹ کے دوران کیا جمع کیا جاتا ہے: آپ کی لوکیشن اور اس کی درستگی؛ رفتار، سمت اور اونچائی (جب فون دے)؛ لوکیشن کا ذریعہ؛ فون کے مطابق لوکیشن جعلی ہے یا نہیں؛ اور وقت۔ شفٹ شروع یا ختم کرتے وقت، چیک پوائنٹ اسکین کرتے وقت یا واقعے کی رپورٹ بھیجتے وقت تازہ لوکیشن بھی لی جاتی ہے۔ واقعے کی رپورٹ میں آپ کی لکھی ہوئی تفصیل اور تصاویر بھی ہوتی ہیں۔

`[URDU REVIEW: new words: رفتار (speed), سمت (direction), اونچائی (height), ذریعہ (source), جعلی (fake). "جب فون دے" for "when the phone gives them" may be too short. "تفصیل" follows incident.descriptionLabel.]`

**P3.**

ہم آپ کے فون کی حالت بھی جمع کرتے ہیں: بیٹری کی سطح، چارجنگ اور پاور سیور؛ لوکیشن اور نوٹیفکیشنز کی اجازت ہے یا نہیں؛ بیٹری آپٹیمائزیشن اور خودکار وقت کی سیٹنگز؛ ٹریکنگ چل رہی ہے یا نہیں؛ اور بھیجنے کے انتظار میں کتنی اپڈیٹس ہیں۔ ہم آپ کے فون کا برانڈ، ماڈل اور سسٹم ورژن، اور ایپ کا ورژن بھی جمع کرتے ہیں۔

`[URDU REVIEW: چارجنگ, پاور سیور, برانڈ, سسٹم ورژن are transliterations; check if guards say something else (for example "بیٹری سیور"). "بیٹری آپٹیمائزیشن" and "خودکار وقت" are from ur.ts.]`

**P4.**

شفٹ کے علاوہ کوئی لوکیشن جمع نہیں کی جاتی۔ پھر بھی فون سیٹ اپ کے وقت کا آپ کا موبائل نمبر اور فون کی تفصیلات، اور ٹریکنگ نوٹس قبول کرنے کا ریکارڈ ہمارے پاس رہتا ہے۔ ہمارے سرور آپ کے فون کا انٹرنیٹ ایڈریس (IP) بھی دیکھتے ہیں اور اسے سیکیورٹی ریکارڈ میں رکھ سکتے ہیں۔

`[URDU REVIEW: "انٹرنیٹ ایڈریس (IP)" is unusual for a guard; maybe "آپ کے فون کا نیٹ ورک ایڈریس". "رکھ سکتے ہیں" for "may keep".]`

**P5.**

ہم آپ کے کانٹیکٹس، مائیکروفون، کال ہسٹری، ٹیکسٹ میسجز، دوسری ایپس یا فوٹو لائبریری جمع نہیں کرتے۔ ایپ صرف وہی تصاویر کھولتی ہے جو آپ خود چنتے ہیں۔

`[URDU REVIEW: کانٹیکٹس, کال ہسٹری, ٹیکسٹ میسجز, فوٹو لائبریری are transliterations. "چنتے ہیں" follows incident.photo.pick.]`

**P6.**

کون دیکھتا ہے: آپ کی کمپنی کے مالکان، ایڈمنسٹریٹرز، سپروائزرز اور ڈسپیچرز (کنٹرول روم کا عملہ) شفٹ کے دوران آپ کی لائیو لوکیشن اور فون کی حالت دیکھتے ہیں۔ مالکان، ایڈمنسٹریٹرز اور سپروائزرز آپ کی لوکیشن ہسٹری بھی کھول سکتے ہیں اور اسے ایکسپورٹ کر سکتے ہیں۔ ڈسپیچرز واقعے کی رپورٹ کے ساتھ بھیجی گئی لوکیشن بھی دیکھتے ہیں۔ لوکیشن ہسٹری دیکھنے کا ہر عمل ریکارڈ ہوتا ہے؛ لائیو نقشہ دیکھنا ریکارڈ نہیں ہوتا۔ دوسرے گارڈز آپ کی لوکیشن نہیں دیکھ سکتے۔

`[URDU REVIEW: new words: مالکان (owners), ڈسپیچرز (dispatchers), لائیو (live), نقشہ (map), ایکسپورٹ (export), عملہ (staff). The label "کون دیکھتا ہے" and the sentence about recording every view of location history are adapted from the current notice. If the English is changed to a generic phrase (question 1), this paragraph changes too.]`

**P7.**

کتنی دیر رکھا جاتا ہے (طے شدہ سیٹنگز؛ کچھ بدلی جا سکتی ہیں): لوکیشن، شفٹ اور گشت کے ریکارڈ میں محفوظ لوکیشن سمیت، 90 دن؛ فون کی حالت، 30 دن؛ شفٹ، گشت اور واقعے کے ریکارڈ، بند ہونے کے بعد 12 مہینے؛ ڈیش بورڈ میں کی گئی کارروائیوں کے ریکارڈ (آڈٹ ریکارڈ)، 24 مہینے۔ واقعے کے ساتھ محفوظ لوکیشن اور تصاویر اس واقعے کے ساتھ ہی رکھی جاتی ہیں۔ بیک اپ میں حذف کیا ہوا ڈیٹا 35 دن تک رہ سکتا ہے۔

`[URDU REVIEW: "کتنی دیر رکھا جاتا ہے" is from the current notice. New: ڈیش بورڈ, آڈٹ ریکارڈ, بیک اپ. "کچھ بدلی جا سکتی ہیں" for "some can be changed". Check the long first sentence; it may need to be split into separate sentences for readability.]`

**P8.**

ٹریکنگ کے دوران ایپ آپ کے نوٹیفکیشن بار میں ایک نوٹیفکیشن دکھاتی ہے۔ آئی فون لوکیشن کا نشان دکھاتا ہے۔

`[URDU REVIEW: "نوٹیفکیشن بار" for "notification bar". The claim "that cannot be removed" (ہٹایا نہیں جا سکتا) was deliberately removed, see C-13 and check doc U3.]`

**P9.** (unchanged)

اینڈرائیڈ یہ نوٹس دکھا سکتا ہے کہ SENTRY دفتری نگرانی کی ایپ ہے۔ گوگل پلے اس نوٹس کا تقاضا کرتا ہے؛ یہ معمول کی بات ہے۔

**P10.** (from check doc S-8, extended)

اگر ایپ میں کوئی خرابی آئے تو وہ ہمارے سرور کو ایک مختصر رپورٹ بھیجتی ہے: خرابی کی قسم، ایپ میں کہاں ہوئی، ایپ اور سسٹم کے ورژن، اور آپ کے فون اور کمپنی کے آئی ڈی کوڈ۔ اس رپورٹ میں نام، نمبر، لوکیشن یا واقعے کی تفصیل نہیں ہوتی۔ یہ 30 دن تک رکھی جاتی ہے۔

`[URDU REVIEW: the second and third sentences are the earlier suggestion S-8 and are not yet reviewed either. "آئی ڈی کوڈ" for "ID codes".]`

**P11.**

آپ ایپ میں اپنی شفٹیں اور واقعے کی رپورٹس دیکھ سکتے ہیں، لیکن اپنی لوکیشن ہسٹری نہیں۔ آپ کا ڈیٹا کیسے استعمال ہوتا ہے، یہ آپ کی کمپنی طے کرتی ہے۔ اپنے ڈیٹا کی کاپی مانگنے یا کوئی سوال پوچھنے کے لیے رابطہ کریں: [COMPANY CONTACT]۔ مزید تفصیل: [PRIVACY POLICY URL]۔

`[URDU REVIEW: "آپ کی شفٹیں" and "میری رپورٹس" are the app's own labels. "کاپی مانگنے" for "to ask for a copy". Replace the two bracketed placeholders before use; do not ship them.]`

### 4.2 Variant B: SOS on (Urdu for the changes in section 2.2)

**B4.**

اگر آپ SOS دبائیں تو اپنے کنٹرول روم کو اطلاع دینا۔

**P1 first sentence.**

لوکیشن ٹریکنگ صرف آپ کی مقررہ شفٹ کے دوران اور SOS کے دوران چلتی ہے، ایپ بند ہو یا اسکرین بند ہو تب بھی۔

`[URDU REVIEW: the first half is the current Urdu notice word for word.]`

**P1b (new).**

SOS: جب آپ SOS کا بٹن دبائے رکھتے ہیں تو ایپ الرٹ بھیجتی ہے اور تقریباً ہر 10 سیکنڈ بعد آپ کی لوکیشن بھی بھیجتی ہے، شفٹ کے بغیر بھی۔ یہ اس وقت تک جاری رہتا ہے جب تک آپ کی کمپنی SOS بند نہ کر دے، یا زیادہ سے زیادہ 4 گھنٹے۔ SOS آپ کی کمپنی کے کنٹرول روم کو اطلاع دیتا ہے۔ یہ پولیس یا ایمبولینس کو کال نہیں کرتا۔ ایپ یہ وعدہ نہیں کر سکتی کہ کوئی آپ کا الرٹ دیکھے گا یا جواب دے گا۔ اگر نیٹ ورک نہ ہو تو ایپ آپ کا نام، سائٹ، لوکیشن اور وقت کے ساتھ ایک ٹیکسٹ میسج لکھ سکتی ہے۔ یہ صرف تب جاتا ہے جب آپ خود بھیجنے کا بٹن دبائیں۔

`[URDU REVIEW: the third and fourth sentences are the app's own sos.disclaimer, word for word. "دبائے رکھتے ہیں" follows sos.hold. "ایپ یہ وعدہ نہیں کر سکتی کہ ..." for "cannot promise" is the author's wording. "یہ صرف تب جاتا ہے جب آپ خود بھیجنے کا بٹن دبائیں" for "it is sent only if you press send" is unsure.]`

**P2 end of second sentence.**

شفٹ شروع یا ختم کرتے وقت، چیک پوائنٹ اسکین کرتے وقت، واقعے کی رپورٹ بھیجتے وقت یا SOS دبانے پر تازہ لوکیشن بھی لی جاتی ہے۔

**P4 first sentence.**

شفٹ اور SOS کے علاوہ کوئی لوکیشن جمع نہیں کی جاتی۔

`[URDU REVIEW: current notice word order kept ("شفٹ اور SOS کے علاوہ").]`

**P6 additions.**

ڈسپیچرز واقعے کی رپورٹ یا SOS کے ساتھ بھیجی گئی لوکیشن بھی دیکھتے ہیں۔ جب آپ SOS دبائیں تو پہلے کنٹرول روم کے عملے کو اطلاع ملتی ہے، پھر ایڈمنسٹریٹرز اور مالکان کو، اور آپ کی کمپنی کے ایمرجنسی رابطوں کو ٹیکسٹ میسج جا سکتا ہے۔

`[URDU REVIEW: "ایمرجنسی رابطوں" for "emergency contacts". Drop the last clause if the English clause is dropped (no SMS provider yet).]`

**P7 changes.**

"شفٹ، گشت، واقعے اور SOS کے ریکارڈ، بند ہونے کے بعد 12 مہینے" and "واقعے یا SOS کے ساتھ محفوظ لوکیشن اور تصاویر اس ریکارڈ کے ساتھ ہی رکھی جاتی ہیں۔"

**Optional one-liner for Text A** (if the owner keeps it)

آپ کی ایپ میں SOS کا بٹن ابھی چالو نہیں ہے۔ اگر آپ کو فوری مدد چاہیے تو اپنے سپروائزر کو کال کریں یا ایمرجنسی نمبر ملائیں۔

`[URDU REVIEW: "چالو" for "switched on"; "ایمرجنسی نمبر ملائیں" for "call the emergency number". "اپنے سپروائزر کو کال کریں" is from ur.ts.]`

## 5. Questions for the lawyer and the owner

Each can be answered in a sentence. They are also marked inline in sections 2 and 4.

1. `[LAWYER: Should the notice name the roles (owners, administrators, supervisors, dispatchers), or say only "your company's control room staff and managers"?]` The draft names them because that is what the permission matrix says (PROD §3.2).
2. `[LAWYER: Must guards be told about the platform operator's emergency access (PLATFORM_ACCESS: time-limited, reason required, written to the company's audit log; SEC §4.6, D-19), and if yes, in the notice or only in the privacy policy?]`
3. `[LAWYER: Which retention numbers may be published as they are? PROD Appendix B calls them product defaults needing legal review: location 90 days, phone status 30, operational records 12 months after closing, audit 24 months, incident evidence as long as the incident, backups 35 days.]`
4. `[OWNER TO CONFIRM: Production backups will keep 35 days (SEC §16.5). The test environment keeps 1 day, and production is not built.]`
5. `[LAWYER: Is a long single notice acceptable on a phone, or do you want a short summary screen first (five or six lines) and the full text behind a "read more" screen?]` The second needs a code change, so it is the owner's call too.
6. `[LAWYER: Is the button "I understand" (Urdu "میں نے سمجھ لیا") enough for monitoring employees, or must the wording be an explicit consent, with a way to say no? (Check M-14.)]`
7. `[LAWYER: Must the notice say whether the company may use tracking data for pay, discipline or client reports? The product does not restrict this; the company decides.]`
8. `[LAWYER: Dispatchers see the location sent with an incident report or an SOS although PROD §3.2 gives them no location history. Is the draft's wording ("also see the location sent with an incident report") the right way to say it?]`
9. `[OWNER TO CONFIRM: Is the dispatcher access to incident and SOS positions intended? The permission matrix shows "-" for a dispatcher's location history; the code lets the incident and SOS routes return positions to dispatchers (section 6, item D2).]`
10. `[OWNER TO CONFIRM: Read one real API log line. Does it hold the client IP address? Until then P4 says "may keep it". (PRIVACY_POLICY.md 3.5.)]`
11. `[LAWYER: Is it acceptable that set-up data (mobile number, phone brand, model, system version) leaves the phone before the guard reads this notice? The order is enrol, then notice, then permissions (PROD §4.3). Check M-10.]`
12. `[OWNER TO CONFIRM: Re-read Google's current "prominent disclosure" text before the submission. Should the words "also when the app is closed or the screen is off" also be shown right before the "Allow all the time" request (perm.backgroundExplain)? (Check M-11.)]`
13. `[OWNER TO CONFIRM: SOS on or off for each rollout? Two versions (2 now, 3 when SOS goes live) means everyone accepts twice.]`
14. `[OWNER TO CONFIRM: Keep or drop the optional "SOS button not switched on" sentence, and the advice to call the emergency number?]`
15. `[OWNER TO CONFIRM: What goes in [COMPANY CONTACT] when the notice is the same for every company? Generic words ("your supervisor or your company's office"), or a per-company contact added to the app's configuration?]`
16. `[OWNER TO CONFIRM: PROD §16 and SEC §16.3 say the guard sees "their own shift history in the app". The app shows the last 24 hours and the next 7 days of shifts, and two weeks of incident reports. Change the spec wording or the app? The draft says "your own shifts and incident reports".]`
17. `[OWNER TO CONFIRM: Can the device tests show whether the tracking notification can be swiped away on current Android? Until then the draft makes no claim (C-13).]`
18. `[OWNER TO CONFIRM: Remove the iPhone sentence from P8 until an iOS build exists?]`
19. `[LAWYER: For employee data held after a guard leaves (profiles are never deleted automatically; acceptance records have no deletion step), is the sentence "ask your company for a copy" enough, since the draft promises no deletion?]`
20. `[OWNER TO CONFIRM: Who is the native Urdu speaker, and do they prefer Urdu words over Latin letters for SOS, IP and the role names (check doc U5)?]`

## 6. What was checked, what was not, and where the documents disagree

**Checked in the code on 2026-11-08** (file and place in the "Source" column of section 3): the list of fields the phone sends (`packages/contracts/src/mobile.ts`); the roles and permissions behind live location, history, incident and SOS positions (`packages/contracts/src/permissions.ts`, `apps/api/src/routes/live.ts`, `routes/incidents.ts`, `routes/sos.ts`); the shift stop rules (`apps/mobile/src/core/shift/local-shift.ts`); the retention defaults and which are editable (`packages/contracts/src/settings.ts`, `apps/api/src/services/retention.ts`); the crash-report fields and the 30-day log (`packages/contracts/src/diagnostics.ts`, `apps/api/src/routes/diagnostics.ts`, `infra/terraform/cell/services.tf`); the rollout behaviour of a new disclosure version (`apps/mobile/src/ui/App.tsx`, `Disclosure.tsx`, `core/app.ts`, `readiness.ts`, `apps/api/src/config.ts`).

**Not verified**

1. Whether the Android tracking notification can be swiped away: needs a device. The draft makes no claim.
2. When Android or Google Play shows the workplace-monitoring notice: untested. P9 is unchanged.
3. Whether the client IP appears in the request log: no real log line was read. The audit table does store `ip_address` and `user_agent`.
4. That the phone never sends phone status outside a shift: read from the call sites of `#reportDeviceStatus` in `apps/mobile/src/core/app.ts` (shift start, resume, heartbeat, and permission changes during a tracked shift); the contract itself allows a status with no shift (`shiftId` nullable). Not device-tested.
5. The 35-day backup figure in production: production does not exist; the Terraform default is 35, the test environment overrides it to 1 day.
6. Whether deleted incident photos linger anywhere: `infra/terraform/cell/attachments.tf` has no versioning, but `docs/ARCHITECTURE.md` §19.6 says "object storage versioning". The draft says only "backups can keep deleted data for up to 35 days" (database backups) and makes no claim about file storage. `PRIVACY_POLICY.md` and `SUB_PROCESSORS.md` note C already flag the difference.
7. That the phone-side scrubbing of error reports matches the schema: the server schema and route were read, the phone code was not.
8. "Also when the app is closed or the screen is off" depends on "Allow all the time"; if Google refuses it (ARCH §20), the fallback is tap-to-resume and the sentence would be wrong.
9. That the SMS text to emergency contacts can be sent at all: no SMS provider is chosen (EXT-10).

**Places where the specification and the code disagree about what guards are told or who sees data**

- **D1. Shift history.** PROD §16 and SEC §16.3 say the guard sees "their own shift history in the app". `GET /me/shifts` returns the last 24 hours to the next 7 days (`apps/api/src/routes/shifts.ts` lines 631-653), and incident reports show two weeks (`en.ts` `incident.mine.none`). The draft says only "your own shifts and incident reports".
- **D2. Dispatchers and location.** PROD §3.2 and `PRIVACY_POLICY.md` section 6 give a dispatcher no location history. In code a dispatcher holds `incidents.read` (incident location, not audited) and `sos.read` (SOS position and trail, audited as `SOS_VIEWED`). `CLAUDE.md` already calls the SOS trail "history too". The draft tells guards.
- **D3. SOS flag.** PROD §11.1 says SOS is available whenever a guard is signed in. `FEATURE_SOS` only hides the button through `GET /mobile/config` (`apps/api/src/routes/mobile.ts` line 78); the SOS routes themselves are not switched off by it.
- **D4. When the new notice appears.** PROD §7.2 says "before the next shift start"; the app shows it the next time it is opened while tracking is not running, and blocks starting a shift until accepted (`App.tsx` line 167, `readiness.ts` line 42). The effect is the same, but a guard sees it earlier than "at shift start".
- **D5. Who can change retention.** PROD Appendix B lists `retention.location_days` as the only retention value an organization can edit in the dashboard. The current notice says "your company's settings decide". The draft says "default settings; some can be changed".
- **D6. PROD §7.2 example text.** The "example core text" in PROD §7.2 includes "help supervisors respond to emergencies" and "during an SOS". Text A (SOS off) departs from it on purpose (C-01, C-03). The spec calls it an example; if a stricter reading is wanted, SEC wins and DECISIONS is next, and neither fixes the wording.

Privacy of this repository: this file contains no personal name, e-mail address, phone number, account number or secret. Placeholders in square brackets stand for facts that are deliberately not in the repository.
