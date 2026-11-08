# Data Processing Agreement (customer template)

> **DRAFT for lawyer review. Not legal advice. Date: 2026-11-08.**
> Prepared by an AI coding assistant from the code and the specifications, not by a lawyer. It is a template to be reviewed, not a signed or signable contract. Open points are marked `[OWNER TO CONFIRM: ...]` and `[LAWYER: ...]`.

This agreement is made between:

- **The Customer:** `[CUSTOMER LEGAL NAME]`, `[CUSTOMER ADDRESS]`, a private security company that uses the service (the **"Controller"**); and
- **The Processor:** `[COMPANY LEGAL NAME]`, `[COMPANY ADDRESS]`, registration number `[REGISTRATION NUMBER]`, which runs `[APP NAME]` (working name: SENTRY) (the **"Processor"**, "we").

It forms part of the agreement for the service (`TERMS_OF_SERVICE.md`). `[LAWYER: which document wins if they conflict?]`

`[LAWYER: this template uses the roles "controller" and "processor". Pakistan has no enacted general data protection law that we have found (the bill was still a draft when D-13 was written, 2026-10-08). Should the template use these terms anyway, adopt the GDPR model by contract, or something else? Does the Customer, or any guard, fall under GDPR, UK GDPR or a US state law?]`

## 1. Meaning of terms

- **Customer Personal Data:** personal data that the Service processes for the Customer. It is described in Annex 1.
- **Service:** the guard mobile app, the web dashboard and the API.
- **Sub-processor:** an outside company we use to process Customer Personal Data. The list is `SUB_PROCESSORS.md`.
- **Guard:** a person employed or engaged by the Customer who uses the app.
- **Dashboard user:** a person the Customer lets sign in to the dashboard.
- **Cell:** one complete deployment of the Service in one region, with its own database, files, API and workers. Each Customer's organization lives in one cell, chosen when it is set up. Moving between cells is not offered in the first version. Source: `docs/DECISIONS.md` D-13.

## 2. Roles

2.1 For Customer Personal Data the Customer is the controller and we are the processor.
2.2 We are a **controller** only for (a) the sign-in data of dashboard users held by our identity provider (email, password, authenticator set-up) and (b) the data we need to run, secure and improve the Service (logs, audit records, error reports). Section 15 covers that data.
2.3 The Customer decides whether to track its guards, what it tells them, and how long data is kept (within the settings the Service offers). The Customer is responsible for having a lawful basis, for telling guards, and for following labour and monitoring rules that apply to it. See section 14.

## 3. Subject matter, duration and purpose

- **Subject matter:** the Service for managing guards, sites, shifts, patrols, incidents and alerts, with shift-bound location tracking.
- **Duration:** as long as the Customer uses the Service, plus the periods in section 11 and Annex 4.
- **Nature:** storing, retrieving, displaying, exporting and deleting the data; sending notifications; producing reports.
- **Purpose:** to provide the Service to the Customer. We do not use Customer Personal Data for advertising, and we do not sell or share location data. Source: `docs/PRODUCT_SPEC.md` §2.2.

## 4. Instructions

4.1 We process Customer Personal Data only on the Customer's documented instructions. The Customer's instructions are: this agreement, the Terms, the Customer's use of the Service's functions and settings, and later written instructions that we accept.
4.2 We tell the Customer if we think an instruction breaks a law that applies to us. `[LAWYER]`
4.3 We do not use Customer Personal Data for our own purposes, except to run, secure and support the Service as described in section 15.

## 5. Confidentiality

5.1 Everyone who works for us and can reach Customer Personal Data is bound to keep it confidential. `[OWNER TO CONFIRM: this needs signed confidentiality terms with each employee and contractor before real data is held.]`
5.2 Our staff have no standing access to a Customer's data through the Service. Support or incident access uses a break-glass procedure: limited in time, a reason is required, and it is recorded as `PLATFORM_ACCESS` in the Customer's audit log. In the first version this is a written procedure, not a tool. Source: `docs/SECURITY_AND_INVARIANTS.md` §4.6; `docs/DECISIONS.md` D-19. `[OWNER TO CONFIRM: the written procedure must exist before production. It was not found in the repository on 2026-11-08.]`

## 6. Security measures

We keep the measures in **Annex 2.** They are listed as they are today. Some apply to the production environment, which is **decided but not yet built**; the test environment has fewer controls and holds test data only. We may change the measures if the new level is not lower. `[LAWYER: standard wording]`

## 7. Sub-processors

7.1 The Customer agrees to the sub-processors in `SUB_PROCESSORS.md` (Annex 3) at the date of signing. Those marked _not chosen_ or _planned_ are not yet in use.
7.2 We have a written agreement with each sub-processor that gives data protection duties no weaker than these. `[OWNER TO CONFIRM: these agreements must be in place; AWS's standard terms are the likely route]`
7.3 We tell the Customer in advance of a new sub-processor or a change. The Customer may object on reasonable grounds. `[LAWYER: notice period [N] days, objection and exit rules]`
7.4 We remain responsible for our sub-processors' work.

## 8. Helping the Customer

8.1 **Guards' requests.** If a guard asks us directly, we pass the request to the Customer and do not answer it ourselves, unless the law requires.
8.2 **Tools in the Service today.**

- An Owner or Administrator can export one guard's data: a ZIP of four CSV files (profile, shifts, location, incidents the guard wrote). It holds everything still kept, and every download is audited. Source: `docs/DECISIONS.md` (Phase 9, "A guard's data"); `docs/SECURITY_AND_INVARIANTS.md` §16.6.
- Other exports (attendance, patrol, incident and location reports) are limited to 92 days per export and are CSV. Source: `docs/PRODUCT_SPEC.md` §15.2.
  8.3 **What the Service does not yet do:** delete or anonymize one guard's records on request, or anonymize a departed guard after the retention period. These were left out of the first version (`docs/phases/phase-10/PLAN.md`, "Not in this phase"). `[OWNER TO CONFIRM: how requests for deletion or anonymization will be handled by hand until a tool exists, and who does it]`
  8.4 **Impact assessments and regulators.** We give reasonable help with impact assessments and with dealings with a regulator, about the Service. `[LAWYER: scope and cost]`

## 9. Personal data breach

9.1 We tell the Customer **without undue delay and within `[NUMBER OF HOURS]` hours** after we become aware of a breach of Customer Personal Data. `[LAWYER/OWNER: choose the period]`
9.2 The notice says what we know: what happened, the data and approximate number of people affected, likely effects, and what we are doing.
9.3 The Customer decides whether and how to tell regulators and guards.
9.4 The Service has no automatic breach-detection feature of its own for customers. Operators receive alarms about the pipeline (SOS, job lag, ingest errors, provider failures), and AWS GuardDuty is planned for production. Source: `docs/ARCHITECTURE.md` §18.4; `infra/terraform/cell/monitoring.tf`.

## 10. International transfers

10.1 **Where data is.** Production is planned for Frankfurt, Germany, with database backups copied to Ireland. The Customer's data is not moved between regions by us. Some sub-processors process limited data elsewhere (listed in Annex 3). The only environment today is a **test environment in Sydney with test data only.** Source: `docs/DECISIONS.md` D-13, D-37.
10.2 **Customer in Pakistan.** The Customer and its guards are expected to be in Pakistan. Data therefore moves from Pakistan to Germany and Ireland. The owner has said that this is acceptable (`docs/DECISIONS.md`, Owner answers, round 3, Q-16). We found no law in force requiring a private company's employee location data to be kept in Pakistan, but this may change if a data protection law is enacted, or if a customer's contract requires it (`docs/DECISIONS.md` D-13, "Law").
10.3 `[LAWYER: do we need transfer terms (for example standard contractual clauses) or other tools, in which directions, and for which parties? Any Pakistani rules for sending data abroad? Is a Pakistan-hosted cell needed for any customer?]`

## 11. Return and deletion

11.1 **During the term** the Customer can export its data with the Service's export functions (section 8.2).
11.2 **At the end of the agreement** we delete the Customer's organization data within `[NUMBER]` days of a written request, or return it first as CSV. `[OWNER TO CONFIRM: there is no self-service "close and delete organization" tool in the Service. The platform operator would do it by a documented procedure that does not yet exist.]`
11.3 **Backups.** Deleted data stays in backups for up to **35 days** in production and then expires (1 day in the test environment). Source: `docs/SECURITY_AND_INVARIANTS.md` §16.5; `infra/terraform/cell/variables.tf`.
11.4 **Automatic deletion in the Service.** The retention rules in Annex 4 run every day. The Customer may set shorter location retention.
11.5 We may keep what the law requires us to keep. `[LAWYER]`

## 12. Audit

12.1 We give the Customer the information needed to show we follow this agreement. `[LAWYER: whether to allow on-site audits, audit reports, questionnaires; how often; costs.]`
12.2 The Customer can also read its own audit log, which records administrative and security-sensitive actions, location-history access and exports, kept 24 months by default. Only Owners can open it. Source: `docs/PRODUCT_SPEC.md` §3.2; `docs/SECURITY_AND_INVARIANTS.md` §17.
12.3 We do **not** hold an independent security certification (such as ISO 27001 or SOC 2) and do not claim one. An internal review of the built code by an AI audit agent is planned (`docs/phases/phase-10/PLAN.md`, B12). That is not an independent audit. `[OWNER TO CONFIRM]`

## 13. Liability, term and law

`[LAWYER: liability and caps, how they relate to the Terms, indemnities, term and termination, governing law ([GOVERNING LAW]), disputes, and notices]`

## 14. The Customer's duties (important)

The Customer confirms that it:

1. has a lawful basis under the law that applies to it to monitor its guards' location during shifts, and has told its guards clearly, before tracking starts, what is collected, why, who sees it and for how long; `[LAWYER: what exactly the Customer must do, and in what form]`
2. makes sure its guards see the in-app tracking notice and that the notice matches what it does (the Customer chooses the retention setting and who holds each role);
3. uses the Service only for its own employees or contractors on assigned shifts, and not to follow people who are not told and not on duty;
4. enters only accurate guard details and only numbers that belong to the right people;
5. staffs the control room if it switches SOS on. SOS alerts the Customer's own control room. **It does not call emergency services.** The Customer must not tell guards otherwise.

## 15. Data for which we are the controller

For sign-in data of dashboard users and for running and securing the Service, we are the controller. That covers: sign-in data held by Amazon Cognito; request logs and the guard app's scrubbed error reports (kept 30 days in AWS CloudWatch Logs); and audit records. An error report holds only the kind of failure, the error type name, source-file:line:column references to our own app code, the app version, OS version and platform, a fatal flag, a timestamp, and the device ID and organization ID as opaque IDs. It holds no message text, names, phone numbers, locations or incident text. It goes to our own API only, is written to the service log and is not stored in a database table (source: owner decision in `docs/DECISIONS.md`, Phase 10; `infra/terraform/cell/services.tf`). `[OWNER TO CONFIRM: check the field list against the finished crash-report code.]` Our privacy policy (`PRIVACY_POLICY.md`) describes this. `[LAWYER: is this the right line? Audit records belong to the Customer's audit log and hold the Customer's users' IP addresses.]`

---

## Annex 1: Data subjects, categories of data and processing

| Data subjects                                                          | Categories of personal data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Special or sensitive?                                                                                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Guards** (employees or contractors of the Customer)                  | Employee number, name, mobile number, language, status. Installation ID, phone brand, model, OS and app version, device public key. **Location** (latitude, longitude, accuracy, and altitude, speed, heading, mock-location flag, source, capture time) **during shifts and SOS only.** Shift and patrol records. Phone status (permissions, battery, charging, power-saver, notifications, tracking service, queue size). Incident reports, photos, notes. SOS events and trail. Acceptance records of the tracking notice. Alerts derived from these. Audit records with IP address and browser. | Precise location of identifiable people is sensitive in many laws `[LAWYER]`. Incident photos may show other people, such as suspects, which the guard (not the Service) chooses to take. `[LAWYER]` |
| **Dashboard users** (Owners, Administrators, Supervisors, Dispatchers) | Email, name, role, membership status. A mobile number for SOS texts if the Customer enters one. Notification subscription (browser address and keys). Audit records of their actions with IP address and browser.                                                                                                                                                                                                                                                                                                                                                                                   | —                                                                                                                                                                                                    |
| **Others who appear in data**                                          | Names or descriptions typed by guards in incident text; people visible in incident photos; the Customer's client names and site addresses                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `[LAWYER]`                                                                                                                                                                                           |

Source: `packages/contracts/src/mobile.ts`; `docs/ARCHITECTURE.md` §6.3; `docs/PRODUCT_SPEC.md` §3–§10; `docs/DECISIONS.md` Phase 8.

**Processing activities:** collection from the phone; storage; display on the dashboard; alert detection (geofence, freshness, patrol rules); notifications; reports and exports; retention deletion.

## Annex 2: Security measures that are actually in place

Each line says where it is proven. "Test" means it runs in the test environment today. "Production" means it is in the Terraform code for production, which has not been applied yet (`docs/EXTERNAL_DEPENDENCIES.md` EXT-14).

| Area                         | Measure                                                                                                                                                                                                                                                                                                                            | Source                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Separation of customers      | Row-level security on every tenant table; the organization comes only from the sign-in session, never from the request body; other organizations' records answer "not found"; the API and workers refuse to start as a database role that bypasses these rules; a generated test reads every tenant table across two organizations | `docs/SECURITY_AND_INVARIANTS.md` §4, INV-01, INV-04, INV-17; `docs/DECISIONS.md` D-33             |
| Access control               | Fixed roles with a permission matrix; every route has a policy; self-promotion and last-owner removal are refused                                                                                                                                                                                                                  | `docs/PRODUCT_SPEC.md` §3; SEC §6                                                                  |
| Sign-in                      | Dashboard: Amazon Cognito, authenticator-app MFA required for every user, 12-character minimum password. Guards: one-time enrollment code, bound to the guard's phone number; device key pair that never leaves the phone; refresh tokens rotated and stored hashed; presenting an already-rotated token revokes the whole session | `infra/terraform/cell/auth.tf`; SEC §5; `docs/DECISIONS.md` D-02, D-30                             |
| Encryption in transit        | TLS. Production load balancer accepts TLS 1.2 or higher. The app refuses to build a non-development version that uses plain HTTP. Storage rejects non-TLS requests.                                                                                                                                                                | `docs/ARCHITECTURE.md` §19.8; `apps/mobile/app.config.ts`; `infra/terraform/cell/attachments.tf`   |
| Encryption at rest           | Database and file storage encrypted with keys in AWS KMS. The phone's session and device key are in the secure store (Keychain or Keystore). The phone's local queue relies on the operating system's file protection; **it has no extra database encryption** (decision D-27 is still open).                                      | `infra/terraform/cell/database.tf`, `attachments.tf`; SEC §11; SEC Appendix A D-27                 |
| Network                      | Database in private subnets with no public endpoint. Production adds an AWS firewall (WAF) in front of the API. The test environment has no WAF.                                                                                                                                                                                   | `infra/terraform/cell/database.tf`, `edge.tf`; `docs/DECISIONS.md` (Infrastructure)                |
| Files                        | Incident photos only through signed links (upload 15 minutes at most, view 5 minutes at most); never overwritten; real file type, size and pixel checks; viewing copy has no metadata; originals only for Owners and Administrators, audited                                                                                       | SEC §12; `docs/ARCHITECTURE.md` §12                                                                |
| Records that must not change | Location, scans, shift events, incident events, alert events, consent and audit records cannot be edited or deleted by the service's runtime role. Only the retention job deletes.                                                                                                                                                 | SEC INV-05; `docs/ARCHITECTURE.md` §6.1                                                            |
| Privacy by design            | Location is accepted only inside a shift window or an open SOS; coordinates are not kept on records made outside one; reading location history is audited **before** data is returned                                                                                                                                              | SEC INV-08, INV-14, §16                                                                            |
| Logs                         | Tokens, codes, coordinates, incident text and phone numbers are redacted. IP addresses are **not** redacted (see `SUB_PROCESSORS.md` note A)                                                                                                                                                                                       | `apps/api/src/logger.ts`                                                                           |
| Web safety                   | No place in the dashboard renders user text as HTML; CSV exports are protected against spreadsheet formulas; CSRF protection; security headers                                                                                                                                                                                     | SEC §8, §10; `docs/PRODUCT_SPEC.md` §15.2                                                          |
| Secrets                      | Kept in AWS Secrets Manager, separate per environment; secret scanning in CI over the whole history                                                                                                                                                                                                                                | SEC §13; `docs/DECISIONS.md` Phase 0                                                               |
| Supply chain                 | Exact dependency versions, a dependency audit and a licence check in CI                                                                                                                                                                                                                                                            | SEC §14                                                                                            |
| Backups and recovery         | Automated database backups with point-in-time recovery. Production: 35 days, a copy in Ireland. A restore drill passed on the test environment on 2026-11-02; production's drill is still to do. Recovery time target 4 hours.                                                                                                     | `infra/terraform/cell/database.tf`; `docs/testing/restore-drills.md`; `docs/ARCHITECTURE.md` §19.6 |
| Monitoring                   | Alarms to the operator for the SOS pipeline, provider failure, canary failure. More alarms are planned. GuardDuty in production.                                                                                                                                                                                                   | `infra/terraform/cell/notifications.tf`, `monitoring.tf`; `docs/phases/phase-10/PLAN.md`           |
| Testing                      | A suite of adversarial tests (cross-customer, authorization, privacy, files) runs in CI.                                                                                                                                                                                                                                           | SEC §18                                                                                            |

**Not in place (do not promise):** certificate pinning in the app (D-28: not in V1); an independent security audit or certification; encrypted local queue (D-27); file replication to a second region (see `SUB_PROCESSORS.md` note C); a tamper-evident hash chain on audit logs (SEC §17.2: not in V1); legal holds (not in V1).

## Annex 3: Sub-processors

See `SUB_PROCESSORS.md`. At the date of this draft: Amazon Web Services (including Cognito and CloudWatch) is in use in the test environment; Google (Firebase Cloud Messaging) and browser push services are built but not active; OpenFreeMap is in use; the SMS provider, the email provider and Apple's push service are **not chosen / planned.**

## Annex 4: Retention periods (defaults)

| Data                                                                                                                                                      | Default                                                      | Customer can change?                                                | Source                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Location points                                                                                                                                           | 90 days                                                      | Yes, 7–3,650 days (never more than 30 times the operational months) | `docs/PRODUCT_SPEC.md` Appendix B; `packages/contracts/src/settings.ts` |
| Phone status events                                                                                                                                       | 30 days                                                      | Operator setting                                                    | Appendix B                                                              |
| Operational records (shifts with events, patrol rounds and scans, alerts with events, incidents with notes and photos, SOS, notification records, drills) | 12 months after they closed                                  | Operator setting                                                    | Appendix B; `docs/DECISIONS.md` (Phase 9)                               |
| Audit logs                                                                                                                                                | 24 months (minimum 12)                                       | Operator setting                                                    | Appendix B                                                              |
| Positions on shift start/end, scans and live state                                                                                                        | Removed after the location period                            | follows location setting                                            | `docs/DECISIONS.md` (Phase 9)                                           |
| Positions on incidents and SOS, and their photos                                                                                                          | As long as the incident or SOS                               | no                                                                  | `docs/DECISIONS.md` (Phase 9); SEC §16.5                                |
| Location near an incident or SOS (evidence window)                                                                                                        | ±30 minutes of the incident or SOS, kept as long as it       | Operator setting                                                    | Appendix B                                                              |
| Export files                                                                                                                                              | Link 15 minutes; file deleted after 7 days; record 12 months | no                                                                  | `docs/PRODUCT_SPEC.md` §15.2; `docs/DECISIONS.md`                       |
| Sync items put aside after a server error                                                                                                                 | 30 days                                                      | no                                                                  | `docs/DECISIONS.md` (Phase 9)                                           |
| Request logs and guard-app error reports                                                                                                                  | 30 days                                                      | no                                                                  | `infra/terraform/cell/services.tf`                                      |
| Guard, site, member profiles                                                                                                                              | Until removed by the Customer                                | n/a                                                                 | `docs/DECISIONS.md` (Phase 9)                                           |
| Tracking-notice acceptance records                                                                                                                        | No deletion step was found `[OWNER TO CONFIRM]`              | n/a                                                                 | `apps/api/src/repositories/retention.ts`                                |
| Database backups                                                                                                                                          | 35 days (production)                                         | no                                                                  | SEC §16.5                                                               |

Retention runs daily from 03:00 in the organization's time zone, one organization at a time, and writes one audit entry with counts only. Source: `apps/api/src/services/retention.ts`.

`[LAWYER: do these defaults meet any labour or data-protection rule that applies to the Customer? They are product defaults, not legal requirements (SEC §16.5).]`
