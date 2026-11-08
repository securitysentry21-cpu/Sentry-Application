# Privacy Policy

> **DRAFT for lawyer review. Not legal advice. Date: 2026-11-08.**
> Prepared by an AI coding assistant from the code and the specifications, not by a lawyer. It is not final and must not be published as it is. Open points are marked `[OWNER TO CONFIRM: ...]` and `[LAWYER: ...]`. A guard-facing Urdu version is needed and must be checked by a native speaker `[OWNER TO CONFIRM]`.

**Service:** `[APP NAME]` (working name: SENTRY), the guard app and the web dashboard.
**Run by:** `[COMPANY LEGAL NAME]`, `[COMPANY ADDRESS]`, registration number `[REGISTRATION NUMBER]`.
**Privacy contact:** `[PRIVACY EMAIL]`. Data protection officer: `[DPO NAME OR CONTACT, IF REQUIRED]` `[LAWYER: is one required?]`
**Last updated:** `[DATE]`

## 1. What this policy covers

This policy is for two groups of people:

- **Guards** who use the mobile app.
- **Dashboard users** (owners, administrators, supervisors, dispatchers and duty officers) who use the web dashboard.

The service is sold to private security companies. We call them "your company" or "the customer" in this policy.

## 2. Who is responsible for your data

| Data                                                                                                               | Who decides what is done with it                                                                                        | Our role                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Data about **guards**: shifts, location, patrols, incidents, photos, phone status                                  | **Your company** (the customer). It chooses to track guards, sets the retention settings and decides who sees the data. | We are the **processor.** We process this data only on your company's instructions, under a data processing agreement. |
| Data about **dashboard users** that your company sets up: role, membership, the phone number entered for SOS texts | **Your company**                                                                                                        | We are the processor.                                                                                                  |
| **Sign-in data of dashboard users:** email address, password and authenticator-app set-up                          | **We decide**                                                                                                           | We are the **controller.**                                                                                             |
| **Running and securing the service:** logs, audit records, error reports, abuse prevention                         | **We decide**                                                                                                           | We are the **controller.**                                                                                             |

Source: `docs/PRODUCT_SPEC.md` §1.1, §4.1; `docs/SECURITY_AND_INVARIANTS.md` §16.1; brief for this draft.

`[LAWYER: is this split right in each country that matters (Pakistan, and the EU, UK and US where customers or guards are)? Is SENTRY a joint controller for dashboard users' membership data? Is the "controller for operating the service" role correct for logs and audit records that include guards' IDs?]`

**If you are a guard,** your company is the first contact for questions about your data. See section 11.

## 3. What we collect

### 3.1 About guards

| Data                                       | What it is                                                                                                                                                                                                                                                                                          | Where it comes from                          | Source                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Profile**                                | Employee number, name, mobile number, preferred language, status                                                                                                                                                                                                                                    | Entered by your company                      | `docs/PRODUCT_SPEC.md` §4.3; `docs/ARCHITECTURE.md` §6.3 `guards`                                       |
| **Phone number at set-up**                 | Your mobile number is typed on the phone to prove the code was meant for you                                                                                                                                                                                                                        | You, once, at set-up                         | `packages/contracts/src/mobile.ts` (`enrollmentRedeemRequestSchema`)                                    |
| **Phone and app details**                  | A random installation ID, the phone's brand, model and Android or iOS version, the app version, and a public key made on your phone (the private key never leaves the phone). We do not use hardware serial numbers or advertising IDs.                                                             | The app, at set-up and later                 | `mobile.ts`; `docs/ARCHITECTURE.md` §5.4; `apps/mobile/android-permissions.ts` (advertising ID blocked) |
| **Location, during shifts and SOS only**   | Latitude, longitude and accuracy. Also altitude, speed and heading when the phone gives them, whether the phone says the location is "mock" (fake), which location source was used, and the time the fix was taken.                                                                                 | The app, from your phone's location services | `mobile.ts` (`fixSchema`); `docs/ARCHITECTURE.md` §6.3 `location_points`                                |
| **Shift and patrol records**               | When you started and ended a shift, where you were at those moments, checkpoint scans and whether each was verified. The QR code you scan is checked by the server and is not stored.                                                                                                               | The app                                      | `docs/ARCHITECTURE.md` §6.3, §11.2                                                                      |
| **Phone status, during shifts**            | Whether location is allowed "all the time" and precise, whether location services and notifications are on, battery level, charging, power-saver and battery-optimization state, whether automatic time is on, whether the tracking service is running, and how many updates are waiting to be sent | The app                                      | `mobile.ts` (`deviceStatusSchema`); `apps/mobile/src/core/tracking/device-status.ts`                    |
| **Incident reports**                       | Type, severity, title and description you type, the location, the time, up to 5 photos, and later notes                                                                                                                                                                                             | You                                          | `docs/PRODUCT_SPEC.md` §10                                                                              |
| **Photos**                                 | Taken with the in-app camera or chosen from your gallery with the system photo picker. The phone re-saves each photo as a JPEG, which removes its metadata, including any GPS position. We keep the original privately as evidence and a copy without metadata for viewing.                         | You                                          | `docs/DECISIONS.md` (Phase 8, "Photos on the phone"); `docs/ARCHITECTURE.md` §12                        |
| **SOS**                                    | The time you pressed it, your location every 10 seconds until it is closed, and a note if you tap "I'm safe"                                                                                                                                                                                        | The app                                      | `docs/PRODUCT_SPEC.md` §11                                                                              |
| **Your acceptance of the tracking notice** | Which version and language you accepted, and when                                                                                                                                                                                                                                                   | You                                          | `docs/ARCHITECTURE.md` §6.3 `tracking_consents`                                                         |
| **Alerts about you**                       | Alerts the system raises from the above, for example "left site" or "low battery"                                                                                                                                                                                                                   | The system                                   | `docs/PRODUCT_SPEC.md` §12.1                                                                            |
| **Error reports**                          | See section 3.3                                                                                                                                                                                                                                                                                     | The app                                      | See 3.3                                                                                                 |

### 3.2 About dashboard users

| Data                                                                                                                                                                              | Source                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Email address, name, password and authenticator-app set-up, held by our sign-in provider (Amazon Cognito). We never store passwords ourselves.                                    | `docs/SECURITY_AND_INVARIANTS.md` §5; `docs/DECISIONS.md` D-01 |
| Role and organization membership                                                                                                                                                  | `docs/ARCHITECTURE.md` §6.3                                    |
| A mobile number for SOS texts, if your company's owner or administrator entered one                                                                                               | `docs/DECISIONS.md` (Phase 8, "SOS text numbers")              |
| The address and keys your browser gives us for notifications, if you turn them on                                                                                                 | `docs/ARCHITECTURE.md` §6.3 `push_tokens`                      |
| Audit records of what you do in sensitive areas: your user, the action, the time, **your IP address and browser details**, and the reason you give when you open location history | `docs/SECURITY_AND_INVARIANTS.md` §17                          |
| A session cookie that keeps you signed in. We use no advertising or analytics cookies. `[OWNER TO CONFIRM]`                                                                       | `docs/SECURITY_AND_INVARIANTS.md` §10                          |

Supervisors and other dashboard users are **never tracked** by the app. Source: `docs/PRODUCT_SPEC.md` §7.10.

### 3.3 Error reports from the guard app

If the guard app fails, it sends a short, scrubbed error report to **our own server only.** No other company receives it.

- **What it holds:** the kind of failure (unhandled error, screen error or unexpected close), the error type name, source-file and line references from our own app code, the app version, the OS version, the platform, whether it was fatal, the time, and the device ID and organization ID as opaque IDs.
- **What it never holds:** message text, names, phone numbers, locations or incident text.
- **Where it goes:** our server's service log in AWS. It is **kept 30 days and then deleted.** It is not stored in a database table.

Source: owner decision `docs/DECISIONS.md` (Phase 10); `infra/terraform/cell/services.tf` (30-day log retention); `docs/SECURITY_AND_INVARIANTS.md` §15. `[OWNER TO CONFIRM: the crash-report code was still being built when this draft was written. Check this list against the finished code.]`

### 3.4 What we do not collect

The app does not collect your contacts, microphone or audio, call logs, text messages, other apps, or your photo library (it opens only the one photo you pick). It asks for no motion or physical-activity permission, and there is no advertising or analytics code in it. We use no facial recognition. We do not sell or share location data for advertising.

Source: `docs/SECURITY_AND_INVARIANTS.md` §16.2; `docs/PRODUCT_SPEC.md` §2.2, §16; `apps/mobile/android-permissions.ts` (the blocked list); `apps/mobile/DEPENDENCIES.md`.

### 3.5 Technical data

Our servers see your IP address when the app or dashboard connects. The request log line very likely includes it, and it is kept 30 days with the log. `[OWNER TO CONFIRM: read a real log line; see SUB_PROCESSORS.md note A]`.

## 4. When location is collected

- **Only** during your assigned shift, and during an SOS. Tracking stops when your shift ends. Nothing is collected at sign-in, when you open the app off shift, or in the background between shifts.
- If the phone sends a location from outside a shift or an SOS, the server rejects it and does not store it.
- The phone also takes a fresh location for a few actions: starting or ending a shift, a checkpoint scan, and an incident report. These only happen during a shift or an SOS. Outside one, the records keep only facts such as a distance band, not coordinates.
- The check of your phone before a shift (the "readiness check") keeps its location on the phone. Only the location sent with the "start shift" action is uploaded.
- While tracking runs, Android shows a notification in the notification area, and iPhone shows its location indicator.

Source: `docs/SECURITY_AND_INVARIANTS.md` INV-08, §16.2; `docs/PRODUCT_SPEC.md` §7.4, §8.1; `apps/mobile/src/core/i18n/en.ts` (`notification.body`).

## 5. Why we use it

| Purpose                                                                                    | Data used                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Show your company who is working, and that guards are at their sites                       | Shifts, location, phone status                                                                                                 |
| Record patrols and check that checkpoints were visited                                     | Scans, location at the scan                                                                                                    |
| Let guards report incidents with photos                                                    | Incident data                                                                                                                  |
| Alert your company's control room if you press SOS                                         | SOS and location. **The SOS feature is off for pilot guards at present.** `[OWNER TO CONFIRM: change when SOS is switched on]` |
| Let your company produce attendance and patrol reports for its clients                     | Shift and patrol records                                                                                                       |
| Keep the service working and secure: sign-in, audit trail, abuse prevention, fixing faults | Account data, logs, audit records, error reports                                                                               |

**Safety note.** SOS alerts your company's control room. **It does not call the police, an ambulance or any emergency service.** Source: `apps/mobile/src/core/i18n/en.ts` (`sos.disclaimer`); `docs/PRODUCT_SPEC.md` §11.1.

**What the product does not promise.** Location shown on the map is device location evidence. It is not proof of where a person stood. A last-known location is never shown as live. Source: `docs/PRODUCT_SPEC.md` §1.3, §8.3.

**Legal basis.** `[LAWYER: the legal basis (or equivalent) for each purpose in each country. Note that guards are employees and a tap on "I understand" may not be valid consent because of the imbalance between employer and employee. Which basis should be used, and what must the employer do? Which Pakistani law applies: PECA 2016, labour law, the status of any personal data protection bill? Which parts of GDPR or UK GDPR apply, if any?]`

## 6. Who can see guard data

Inside your company, by role. The company's owner or administrator can change who holds a role.

| Role          | Live location | Location history and location exports                                 | Incidents   | Alerts and SOS |
| ------------- | ------------- | --------------------------------------------------------------------- | ----------- | -------------- |
| Owner         | yes           | yes                                                                   | yes         | yes            |
| Administrator | yes           | yes                                                                   | yes         | yes            |
| Supervisor    | yes           | yes                                                                   | yes         | yes            |
| Dispatcher    | yes           | **no**                                                                | view        | yes            |
| Guard         | own data only | **no** (the guard sees their own shift history, not a location trail) | own reports | own SOS status |

Every view or export of **location history** is recorded in an audit log **before** the data is shown. The company can require a reason for each view. Viewing the live map is not recorded as history. Incident photos (originals) can be downloaded only by owners and administrators, and each download is recorded. Source: `docs/PRODUCT_SPEC.md` §3.2; `docs/SECURITY_AND_INVARIANTS.md` §16.3, §16.4, INV-14; `docs/DECISIONS.md` D-21, D-22.

**Platform staff.** Our staff have no standing access to a customer's data through the product. Access for support or incident response uses a documented emergency procedure: limited in time, a reason is required, and it is recorded as `PLATFORM_ACCESS` in the customer's audit log. In this first version it is a procedure, not a tool. Source: `docs/SECURITY_AND_INVARIANTS.md` §4.6; `docs/DECISIONS.md` D-19.

**Your company's clients.** Reports for a company's clients (attendance, patrol, incident and site-activity summaries) contain times, results and counts. The location report holds no coordinates. Exports of location history do hold coordinates and are limited to people with location-history access. Source: `docs/DECISIONS.md` (Phase 9, "The location report").

## 7. Who we share data with

We use outside companies to run the service. Each is listed, with what it handles and where, in `SUB_PROCESSORS.md` `[LINK TO PUBLISHED SUB-PROCESSOR PAGE: [DOMAIN]]`. In short:

- **Amazon Web Services** hosts the service: database, files, sign-in (Cognito), logs and backups.
- **Google (Firebase Cloud Messaging)** delivers app notifications to guards. _Not yet active._
- **Browser push services** deliver dashboard notifications, encrypted.
- **OpenFreeMap** supplies map tiles. The viewer's browser contacts it directly, so it sees the viewer's IP address and the map area on screen.
- **An SMS provider and an email provider** will be added. _Not chosen yet._ `[OWNER TO CONFIRM: add the names before any real data is sent]`

We do not sell personal data. We do not share it for advertising. We may have to disclose data to authorities if the law requires it. `[LAWYER: wording and process for legal requests]`

## 8. Where data is stored

The first production deployment is planned for **Frankfurt, Germany** (AWS `eu-central-1`). Database backups are copied to **Ireland** (`eu-west-1`). Your company is assigned to one deployment when it is set up, and it is not moved in the first version. Some providers (sign-in emails, notifications, map tiles) process limited data outside that region. SMS is expected to go through a Pakistani provider.

Today the only environment is a **test environment in Sydney, Australia, with test data only.**

Source: `docs/DECISIONS.md` D-13, D-37, Infrastructure; `infra/terraform/env/*.tfvars`.

`[LAWYER: the rules for sending personal data from Pakistan to Germany and Ireland, from Germany to other countries, and for guards or customers in the EU, UK or US. Which transfer terms are needed?]`

## 9. How long we keep data

These are the product's **default** settings. Your company can change some of them, so your company's own policy may differ. They are product defaults, not legal requirements, and they await legal review. Source: `docs/PRODUCT_SPEC.md` Appendix B, §16; `docs/DECISIONS.md` (Phase 9).

| Data                                                                             | Default                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location points                                                                  | **90 days** (your company can set 7 to 3,650 days)                                                                                                                                                                                                                                              |
| Location kept as evidence near an incident or SOS                                | Kept as long as that incident or SOS is kept. The window is 30 minutes either side.                                                                                                                                                                                                             |
| Position on a shift's start and end, on a checkpoint scan, and on the live state | Removed after the location period. The record keeps its times and results.                                                                                                                                                                                                                      |
| Position on an incident or SOS, and the photos                                   | As long as the incident or SOS is kept                                                                                                                                                                                                                                                          |
| Phone status events                                                              | **30 days**                                                                                                                                                                                                                                                                                     |
| Shifts, patrols, scans, alerts, incidents, SOS and delivery records              | **12 months** after they closed                                                                                                                                                                                                                                                                 |
| Audit logs                                                                       | **24 months**                                                                                                                                                                                                                                                                                   |
| Export files                                                                     | The download link works 15 minutes. The file is deleted after 7 days. The record of the export stays 12 months.                                                                                                                                                                                 |
| Error reports and request logs                                                   | **30 days**                                                                                                                                                                                                                                                                                     |
| Database backups                                                                 | Up to **35 days** after deletion in production. Deleted data therefore remains in backups for up to that time.                                                                                                                                                                                  |
| Guard, site and member profiles                                                  | Kept until your company removes them. Terminated guards keep their history under the rules above. `[OWNER TO CONFIRM: there is no automatic deletion or anonymization of a departed guard's profile, and no deletion step for acceptance records of the tracking notice, in the first version]` |

Source for backups: `docs/SECURITY_AND_INVARIANTS.md` §16.5 (the 35 days "is disclosed in the privacy policy"); `infra/terraform/cell/variables.tf` (`db_backup_retention_days`, default 35; the test environment uses 1 day).

## 10. How we protect data

What is actually in place today, so you can judge it. We do not hold a security certification, and we do not claim one. `[OWNER TO CONFIRM]`

- Traffic is encrypted with TLS. Production builds of the app refuse plain HTTP.
- The database is private (no public endpoint) and encrypted at rest. Incident photos and exports are in a private, encrypted bucket and are reached only through short-lived signed links (5 minutes to view, 15 minutes to upload or download).
- Each company's data is separated in the database by row-level security. The service refuses to start if it connects with a database role that could bypass it.
- Dashboard users sign in with a password and an authenticator-app code. Guards have no passwords: the phone is enrolled with a single-use code and holds its own key.
- Sensitive actions are written to an audit log.
- Logs are scrubbed of tokens, codes, coordinates, incident text and phone numbers.
- Backups are encrypted.

Source: `docs/SECURITY_AND_INVARIANTS.md` §4, §5, §11, §12, §15; `infra/terraform/cell/*.tf`; `apps/mobile/app.config.ts`. Some measures (the firewall, multi-zone database, threat detection) apply to production, which is not yet built. See the table in `DATA_PROCESSING_AGREEMENT.md` Annex 2.

If we learn of a breach that affects personal data, we will tell the affected customer without undue delay. `[LAWYER: required notice periods and regulator notification, by country]`

## 11. Your rights and how to use them

**Guards:** ask your company first. It decides what is done with your data and can use the dashboard to produce an export of your data (profile, shifts, location, incidents you wrote). You cannot see your own location trail in the app. You can also write to `[PRIVACY EMAIL]`, and we will pass your request to your company and help it answer. We cannot, on our own, open or delete a company's data.

**Dashboard users:** write to `[PRIVACY EMAIL]` about your sign-in data.

Depending on where you live you may have rights to access, correct, delete, restrict or object to the use of your data, to move it, and to complain to a regulator. `[LAWYER: which rights apply in Pakistan and elsewhere; the time limits; how a guard's deletion or anonymization request is handled, since the first version has no tool for it; how we verify who is asking]`

Source: `docs/SECURITY_AND_INVARIANTS.md` §16.6; `docs/DECISIONS.md` (Phase 9, "A guard's data"); `docs/phases/phase-10/PLAN.md` ("Not in this phase").

## 12. Children

The service is for adults employed by security companies. `[LAWYER: minimum age; guards under 18]`

## 13. Changes to this policy

We will post changes at `[DOMAIN]` and tell customers. When the tracking notice in the app changes, every guard sees the new version and must accept it again before the next shift. Source: `docs/PRODUCT_SPEC.md` §7.2.

## 14. Contact

`[COMPANY LEGAL NAME]`, `[COMPANY ADDRESS]`, `[PRIVACY EMAIL]`, support `[SUPPORT EMAIL]`.
Regulator or representative details: `[LAWYER: needed for any country?]`
