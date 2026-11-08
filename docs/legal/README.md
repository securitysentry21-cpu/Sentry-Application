# Legal drafts: what they are and how to review them

> **DRAFT for lawyer review. Not legal advice. Date: 2026-11-08.**
> Everything in `docs/legal/` and `docs/store/` was prepared by an AI coding assistant from the code and the specifications (`docs/PRODUCT_SPEC.md`, `docs/DECISIONS.md`, `docs/SECURITY_AND_INVARIANTS.md`, `docs/ARCHITECTURE.md`). None of it was written by a lawyer. None of it is final. Nothing in it should be published, signed or submitted to a store before a lawyer, the owner and (for Urdu) a native speaker have reviewed it.

This is plan item B10 (legal drafts) and B11 (store material) of `docs/phases/phase-10/PLAN.md`, and it feeds EXT-17 (legal review), EXT-16 (public policy URLs), EXT-06, EXT-20 and EXT-21 (`docs/EXTERNAL_DEPENDENCIES.md`).

**How to read the markers.** `[OWNER TO CONFIRM: ...]` is something only the owner can answer. `[LAWYER: ...]` is something only a lawyer can answer. Placeholders like `[COMPANY LEGAL NAME]` stand for facts that were deliberately not guessed. Every factual statement about what the product collects, keeps or shows has a "Source:" note with a file and section, so a reader can check it.

**Current reality, in one paragraph.** No real guard has used the service yet. The only environment is a test environment in Sydney with test data only. Production (Frankfurt) is decided but not built. SOS is switched off for pilot guards. The SMS provider and the email provider are not chosen. The Firebase project does not exist, so the phone does not receive pushes. There is no iOS build. The company's legal name, address, domain and final app name are not in the repository. Source: `docs/DECISIONS.md`; `docs/EXTERNAL_DEPENDENCIES.md`; `TODO.md`.

## 1. The files

### In `docs/legal/` (B10)

| File                           | What it is                                                                                                                                | Reader                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `PRIVACY_POLICY.md`            | Public policy for guards and dashboard users: who is controller and processor, what is collected and when, who sees it, retention, rights | Lawyer, then the public            |
| `TERMS_OF_SERVICE.md`          | Terms between the company and the customer; limits on SOS and accuracy; customer duties                                                   | Lawyer, then customers             |
| `DATA_PROCESSING_AGREEMENT.md` | Customer-facing DPA template with annexes: data and subjects, security measures that exist today, sub-processors, retention               | Lawyer, then customers             |
| `SUB_PROCESSORS.md`            | Every outside company that touches data, with purpose, data, region and status. Items not yet chosen are marked                           | Lawyer, customers, store reviewers |
| `GUARD_DISCLOSURE_CHECK.md`    | The in-app tracking notice (English and Urdu) compared with what the code collects. Lists every mismatch and suggested wording            | Owner, lawyer, Urdu speaker        |
| `README.md`                    | This file                                                                                                                                 | Everyone                           |

### In `docs/store/` (B11)

| File                   | What it is                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DATA_SAFETY_PLAY.md`  | Answers for Google Play's Data safety form, row by row, verified against the code                                            |
| `PLAY_DECLARATIONS.md` | Background-location, foreground-service, permissions and monitoring-tool declarations, and the script for the required video |
| `APP_STORE_PRIVACY.md` | Apple's App Privacy answers and the review notes (iOS comes later)                                                           |
| `LISTINGS.md`          | Store listing texts in English and Urdu (Urdu is suggested wording), screenshots plan                                        |
| `REVIEW_NOTES.md`      | Instructions for store reviewers and the demo organization                                                                   |

## 2. Suggested review order

1. **`GUARD_DISCLOSURE_CHECK.md`** first. It is the shortest and most important. The in-app notice is what guards actually see, and it is incomplete today. The other documents repeat its facts, so fix this first.
2. **`SUB_PROCESSORS.md`**. A short list. The privacy policy and the DPA point to it.
3. **`PRIVACY_POLICY.md`**.
4. **`DATA_PROCESSING_AGREEMENT.md`**, especially Annex 2 (security measures) and Annex 4 (retention).
5. **`TERMS_OF_SERVICE.md`**.
6. **`docs/store/DATA_SAFETY_PLAY.md`** and **`PLAY_DECLARATIONS.md`**, because Google's background-location review is the longest store wait.
7. **`APP_STORE_PRIVACY.md`**, **`LISTINGS.md`**, **`REVIEW_NOTES.md`**.
8. The Urdu lines go to a native speaker (`GUARD_DISCLOSURE_CHECK.md` section 7 and `LISTINGS.md` section 3).

## 3. What the review found in the code and the specs

These are the most useful findings. The first nine are about the gap between what guards are told and what the product does. Details and sources are in the file named.

| #   | Finding                                                                                                                                                                                                                                                                                  | Where                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | The tracking notice says only "supervisors and administrators" see location. Owners and dispatchers see live location too, and platform staff have an emergency-access route.                                                                                                            | `GUARD_DISCLOSURE_CHECK.md` M-01            |
| 2   | The notice lists only location, accuracy and "permission, battery, connection". The phone also sends altitude, speed, heading, a fake-location flag, charging, power saver, notification state, queue size, phone brand, model and OS.                                                   | M-02                                        |
| 3   | The notice says "nothing is collected outside shifts". Enrollment data (mobile number, phone details) and server-side IP records are. It should say "no location".                                                                                                                       | M-03                                        |
| 4   | The notice's "90 days" leaves out: positions on incidents and SOS (kept with the incident), backups (35 days, which `SEC` §16.5 says must be disclosed), phone status (30 days), audit logs (24 months).                                                                                 | M-04                                        |
| 5   | The "emergencies" purpose and SOS wording promise a feature that is off for pilot guards (`FEATURE_SOS=false`).                                                                                                                                                                          | M-05                                        |
| 6   | "Notification you cannot swipe away" is unverified on newer Android. "Stops when your shift ends" is not exact: tracking can run until the auto-end limit (default 60 minutes after the scheduled end).                                                                                  | M-06, M-06b                                 |
| 7   | Google's rule for background location asks for wording like "even when the app is closed or not in use". Neither the notice nor the permission explanation says it.                                                                                                                      | M-11                                        |
| 8   | The server's request log very likely includes client IP addresses for 30 days (Fastify's default log line; the redaction list does not cover it). Audit records keep the IP and browser for 24 months. The notice and `SEC` §15 do not mention IPs.                                      | `SUB_PROCESSORS.md` note A                  |
| 9   | Retention has no deletion step for acceptance records of the tracking notice, and guard profiles are never deleted or anonymized in V1. A guard's deletion request has no tool.                                                                                                          | `DATA_PROCESSING_AGREEMENT.md` 8.3, Annex 4 |
| 10  | `docs/ARCHITECTURE.md` says incident photos and files are replicated to Ireland and versioned. The Terraform code replicates only database backups. No document here claims file replication.                                                                                            | `SUB_PROCESSORS.md` note C                  |
| 11  | The reviewers' demo (PROD §17) is only partly built: the organization kind exists, but the "always startable shift" job and a production seed were not found.                                                                                                                            | `REVIEW_NOTES.md` section 3                 |
| 12  | Dashboard sign-in requires two-step codes for everyone, so reviewers cannot be given a dashboard login. Offer a recording.                                                                                                                                                               | `REVIEW_NOTES.md` section 4                 |
| 13  | One guard has one active phone. Two store teams sharing one demo guard would sign each other out.                                                                                                                                                                                        | `REVIEW_NOTES.md` section 2                 |
| 14  | The monitoring-tool flag value `enterprise_management` must be checked against Google's current policy before the first submission.                                                                                                                                                      | `PLAY_DECLARATIONS.md` 4.1                  |
| 15  | Older documents still name Google Maps (D-12 body, ARCH §17) and Clerk (D-01 body), and D-13 lists "error tracking" as a provider. The later decisions replace them (MapLibre with OpenFreeMap, Amazon Cognito, crash reports to our own server). The drafts follow the later decisions. | `docs/DECISIONS.md`                         |

## 4. Placeholders to fill (never guess these)

| Placeholder                                                                                                        | Needed by                                                          |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `[COMPANY LEGAL NAME]`, `[COMPANY ADDRESS]`, `[REGISTRATION NUMBER]`                                               | All legal files, store contacts                                    |
| `[PRIVACY EMAIL]`, `[SUPPORT EMAIL]`                                                                               | Privacy policy, terms, store forms                                 |
| `[DPO NAME OR CONTACT, IF REQUIRED]`                                                                               | Privacy policy (if a lawyer says one is needed)                    |
| `[DOMAIN]`, `[PRIVACY POLICY URL]`                                                                                 | Everywhere. EXT-16                                                 |
| `[APP NAME]`                                                                                                       | Everywhere. Working name SENTRY; trademark search pending (EXT-17) |
| `[GOVERNING LAW]`, `[COURTS OR ARBITRATION]`, `[LIABILITY CAP]`, `[PRICE]`, `[TERM]`                               | Terms, DPA                                                         |
| `[NUMBER OF HOURS]` (breach notice), `[NUMBER]` days (deletion), `[N]` days (sub-processor notice)                 | DPA, Sub-processors                                                |
| `[CUSTOMER LEGAL NAME]`, `[CUSTOMER ADDRESS]`                                                                      | DPA, filled per customer                                           |
| `[DEMO ENROLLMENT CODE: ...]`, `[DEMO GUARD PHONE NUMBER: ...]`, `[DEMO CALL NUMBER: ...]`, `[REVIEW CONTACT ...]` | Store consoles only. **Never in the repository.**                  |

## 5. Questions for the lawyer

Each can be answered in a sentence.

**Which law applies**

1. Which data protection and privacy laws apply to the company, to its customers and to the guards: in Pakistan (PECA 2016, labour law, and the status of any personal data protection bill when we launch), and GDPR, UK GDPR or US state laws where a customer or guard is there?
2. Do any Pakistani cyber-crime or surveillance rules (for example PECA 2016) restrict taking, storing or sharing incident photos that show people, or tracking employees' phones?
3. Do we or our customers have to register with a regulator, appoint a data protection officer or a local representative anywhere?

**Roles and contracts**

4. Is the split right: the customer is the controller of guard data and dashboard-user data, we are the processor, and we are the controller only for dashboard sign-in data and for running the service (logs, audit records, error reports)?
5. Are we exposed as a joint controller anywhere, for example for the guard's phone details or the audit log?
6. Is the DPA template enough in form, or must it follow a standard (for example standard contractual clauses) for some customers?
7. What breach-notice period, audit right, sub-processor notice period and deletion period should the DPA state?
8. Do the AWS and Google standard terms already give the data-protection duties our DPA promises to customers?

**Employee monitoring and consent**

9. What lawful basis should the customer use for tracking guards' precise location during shifts, and is a tap on "I understand" valid consent given the employer-employee imbalance?
10. Is precise employee location "sensitive" under the laws that matter, and what extra steps follow?
11. What must the customer do before tracking starts (written policy, employee notice, representatives, an impact assessment)?
12. Does the final tracking notice, English and Urdu, meet transparency rules, and are the suggested edits in `GUARD_DISCLOSURE_CHECK.md` section 8 enough?
13. Is it acceptable that enrollment details (mobile number, phone model) leave the phone before the guard reads the tracking notice?
14. Does it matter that guards cannot see their own location trail in the app (owner decision D-22), if the company can export it for them?

**Retention and rights**

15. Are the default retention periods acceptable: location 90 days, phone status 30 days, operational records 12 months after closing, audit logs 24 months, backups 35 days?
16. May incident and SOS positions and photos be kept as long as the incident (12 months after it closes)?
17. How should a guard's, or a departed guard's, request to delete or anonymize records be handled, given the first version has no tool for it?
18. Is it acceptable that guard profiles and tracking-notice acceptance records have no automatic deletion?
19. Which data-subject rights apply in each country, with what deadlines?
20. Is it right to keep request logs with client IP addresses for 30 days and audit records with IP addresses for 24 months?

**Hosting and transfers**

21. What is needed to move guard data from Pakistan to Frankfurt and Ireland, and on to US-based providers, including for guards or customers in the EU, UK or US?
22. Is hosting in Frankfurt with no copy in Pakistan acceptable for the pilot customer, and what if a later customer requires in-country storage?
23. Are the transfers to OpenFreeMap (viewer IP and map area) and to Firebase Cloud Messaging (push token, notification text) acceptable, and how must they be disclosed?
24. Is a short written notice enough to add a sub-processor, and may customers object?

**Terms and safety**

25. Are the liability cap, disclaimers and indemnities appropriate for a service that includes an SOS alert, and do they work with "SOS is not an emergency service and delivery is not guaranteed"?
26. Is the wording "SOS alerts your company's control room; it does not call the police or an ambulance" enough, and does any law put duties on us when an alert fails?
27. Do guards need to accept terms inside the app, or is the customer's responsibility enough?
28. What minimum age applies to guards, and do we need to say so?
29. Should the privacy policy and terms exist in Urdu to be fair or valid?

**Stores and brand**

30. For Google's Data safety form, is the guard's employer a "third party" with whom data is "shared", and how should Apple's label treat the same flow?
31. Is the manifest value `enterprise_management` accepted by Google's monitoring-app policy, and does our listing disclosure satisfy it?
32. Please run a trademark search for the final app name and say who owns the AI-generated logo (`docs/DECISIONS.md`, Brand).
33. Is a security statement without a certification acceptable ("we do not hold a security certification")?

## 6. Questions for the owner

1. What are the company's legal name, registered address, registration number, privacy email, support email, domain and final app name?
2. Who is the data protection officer, if the lawyer says one is needed?
3. What are the prices, the liability cap, the governing law and the term of the customer contract?
4. Will there be a separate pilot agreement?
5. Is SOS on or off when the stores review the app (the listing and the notice change with it)?
6. Which SMS provider and which email provider (names, countries)? They go on the sub-processor list before any data is sent.
7. What is the company's AWS contracting entity, and are the AWS data-protection terms accepted in the account?
8. Do you want files replicated to a second region as `ARCHITECTURE.md` says (it is not built), or should the architecture text change?
9. Can you read a real API log line and tell us whether the client IP appears?
10. Will you write the break-glass access procedure (SEC §4.6) and employee confidentiality terms before production?
11. Who handles a guard's deletion request by hand until a tool exists, and how long does it take?
12. Do you want a breach-notice period of how many hours?
13. What do OpenFreeMap's operator and terms say, and will you serve your own tiles before the pilot grows?
14. Can the device tests confirm whether the tracking notification can be swiped away on current Android, and whether tracking resumes after a reboot?
15. Will you build the reviewers' always-startable demo shift, a production seed and printed demo checkpoint labels before the first store submission?
16. Do reviewers get a dashboard login (needs an authenticator you control) or a recording?
17. Who is the native Urdu speaker, and can the same person review the store text?
18. Is the crash-report code finished? Please compare its fields with the list in the privacy policy section 3.3.
19. Should the company's legal name appear in the app's notice, or only the organization's?
20. Do you accept the code as the source of truth where an older document disagrees (Google Maps, Clerk, "error tracking")? The drafts do.

## 7. Rules these drafts follow

- No statement about the product without a source in the repository.
- No invented providers, retention periods, security measures or certifications.
- No promise about GPS accuracy, delivery or response times beyond what the specifications commit to.
- SOS is always described as alerting the company's control room, never as an emergency service (EXT-21).
- Location is collected only during a shift and an SOS (`docs/PRODUCT_SPEC.md` §8.1; `docs/SECURITY_AND_INVARIANTS.md` INV-08).
- Crash reports go to our own server only (owner decision, `docs/DECISIONS.md`, Phase 10) and are described as: scrubbed, written to the service log, kept 30 days. The code was still being written when these drafts were made.
- The repository is public. These files contain no personal email, name, phone number, account number, code or token. Before any commit, search the tree again (`git grep` for email domains, account numbers and personal names).
