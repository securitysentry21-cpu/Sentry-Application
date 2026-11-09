# To-do (owner)

Everything that is left, in the order that matters, with what to do step by step. Tick an item by changing `[ ]` to `[x]`, or tell me and I'll update it. Updated 2026-11-08.

**You pay for everything on this page; I never buy anything** (standing rule). Every step that spends money says so, and I show the cost before I ask.

Facts about outside companies change (store policy changes every year, EXT-45). Each one below says where it came from and when it was checked. **Verify** means I could not confirm it from the company's own page: check it on the screen where you act.

## Waiting on you right now (noted 2026-11-09)

0. **Run Fable pass 2** (2026-11-09): give Fable `docs/FABLE_LAUNCH_AUDIT.md` (its "Pass 2" section), the zip `sentry-<commit>.zip` I make on your Desktop once CI has passed, and Fable's own pass-1 report. Bring the findings back to me.
1. **Answer the five questions from Fable's pass 1** (2026-11-09): `docs/DECISIONS.md`, "Fable launch audit, pass 1": a disabled guard's SOS (Q1), Object Lock for photos (Q2), the WAF and SOS (Q3, built per INV-15, for your veto), the device key (Q4), who may run operator commands in production (Q5), and two small spending items. Every other finding is fixed and tested (`docs/phases/phase-10/FABLE-PASS-1.md`), committed on branch `fable-pass-1` in a draft pull request, not merged and not applied: the next Terraform apply needs you to read its plan first.
2. **Confirm the AWS alarm email** (item 1): until you click "Confirm subscription", the alarms email nobody.
3. **Answer the lawyer's questions** (items B and C, and item 3 for finding the lawyer): `docs/legal/README.md`, `docs/legal/GUARD_DISCLOSURE_V2_DRAFT.md`, `docs/store/`.
4. **Create the Firebase test project** (item 5) and **the Expo account** (item 6): guard push cannot be tried on a phone without them.

Not waiting on you, but not yet in `main`: the runbook trial results and the Fable pass-1 fixes, two commits on branch `fable-pass-1`, in a draft pull request. Say "merge" once you have read it.

## The shortest path to the first real guard

Almost all of the time is waiting for other people, so **start the long waits first**. Your own work adds up to about two days.

| Gate                                                                              | What it needs                                                                                                                 | The long wait                                            |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Legal sign-off** (before any real guard data)                                   | a lawyer engaged; my drafts (disclosure, privacy policy, agreement with customers); the Urdu text checked by a native speaker | weeks, depending on the lawyer                           |
| **A server real guards may use**                                                  | the name cleared → the domain → AWS's Paid plan → I build production in Frankfurt                                             | days, once the name is settled                           |
| **The app on the guards' phones**                                                 | Expo account → a cloud build; the Firebase files; device tests on the pilot's own phones                                      | the customer's phone list                                |
| **SOS switched on**                                                               | real-phone SOS checks; an SMS provider with an approved sender name; your approval                                            | 5–45 working days for the sender name (vendors disagree) |
| **A Google Play listing** (the full rollout, and Google's developer verification) | D-U-N-S number → Play organization account → Google's declarations                                                            | D-U-N-S up to 30 working days; Play review rounds        |
| **Audit clean**                                                                   | Fable's pass 1, my fixes, pass 2                                                                                              | your time to run Fable                                   |

SOS is off for the pilot guards, so the SMS provider does not block the pilot. It is on this page now only because it is the longest wait.

## 0. Finished by me, waiting for a decision from you (2026-11-08)

- [x] **A. Merge the pull request** — done 2026-11-08 at your word: PR #17 is merged into `main` as bb6a9ad, and CI on `main` passed.
- [ ] **B. Read the lawyer's questions** in `docs/legal/README.md` and the owner's questions in the same place and in `docs/store/`. Answer what only you know (company name, address, contact addresses, which provider). Nothing in the drafts is invented: a blank says so.
- [ ] **C. The guard disclosure** says less than the product does. `docs/legal/GUARD_DISCLOSURE_CHECK.md` lists where, and `docs/legal/GUARD_DISCLOSURE_V2_DRAFT.md` is a corrected text for the lawyer (English, with Urdu suggestions marked for your native speaker). The app still shows the old text until the lawyer approves. When it does, the new build must reach every phone **before** the server announces the new version, or guards cannot accept it. The draft is about 550 words against 150 today; section 2.3 says what to cut first.
- [x] **D. Firebase's two permissions** (`com.google.android.c2dm.permission.RECEIVE` and `WAKE_LOCK`) — you kept my decision on 2026-11-08. Still open as a check, not a decision: Play's wake-lock figure on the device tests.
- [x] **E. Try the runbooks on the test environment** — done 2026-11-08: the look-in commands, worker and API restarts, the operator commands (with their error cases), a revoke-and-undo, an evidence copy and snapshot, and the key-rotation plans. Each runbook's Status section says exactly what was and was not tried; none was tried against a real failure, a signed-in dashboard or a phone. `docs/RUNBOOKS/README.md` now lists 26 gaps. The environment is paused again and runs bb6a9ad.
- [x] **F. Run Fable pass 1** — done; you brought the findings on 2026-11-09 and I fixed all but the five that need your answer (item 1 at the top). Pass 2 comes after Phase 10 and re-checks these fixes.

Done and no longer waiting: the new alarms and the app-version variables are **applied to the test environment** (2026-11-08, 14 added, 2 replaced, about $0.20 a month; the environment is still paused). Until you confirm the alarm email (item 1 below) they email nobody.

## 1. This week

Do these in order. The first four take under an hour in all, and start the longest waits.

- [ ] **1. Confirm the AWS alarm email** (1 minute). AWS sent "AWS Notification - Subscription Confirmation" to your email. Click **Confirm subscription**, or the SOS pipeline alarms reach nobody. Look in spam if it is not in the inbox.

- [ ] **2. Request a D-U-N-S number for the company** (15 minutes, then waiting). Google Play and Apple both require one for a company account. Google's own help page confirms it for Play; Apple's enrollment page confirms it for Apple (both checked 2026-11-08).
  1. Check whether the company already has one: Apple's lookup tool, developer.apple.com/enroll/duns-lookup/.
  2. If not, request it free from Dun & Bradstreet: dnb.com/en-us/smb/duns/get-a-duns-form.html. Choose Pakistan. It must be requested by an owner or officer.
  3. Enter the legal name **exactly as on the company registration certificate** (for a limited company, the SECP certificate), the registered address, a phone number, the number of employees and the owner's name. Decline the paid extras: the free request is enough. (An "expedited" paid option exists.)
  4. D&B's pages say standard processing can take up to 30 working days (reported by D&B-related pages, **verify**). Plan for six weeks.
  5. Keep the name and address identical in the Google and Apple forms later. A mismatch with D&B's record is the usual reason for delay.
  6. A Pakistani agent advertises a D-U-N-S service. I could not confirm it is a D&B partner, so I do not recommend it.

- [ ] **3. Engage a lawyer** (a few emails, then weeks of waiting). The review must be finished before any real guard data is collected (EXT-17).
  1. Look for counsel with experience in Pakistani data protection and employment law and in technology contracts. Your pilot customer's lawyer or your accountant can usually recommend one.
  2. Ask the lawyer to cover these six things:
     - data protection law in Pakistan (its status needs checking at launch);
     - rules on monitoring employees;
     - hosting guards' data in the EU (Frankfurt) and sending it out of Pakistan;
     - a trademark search for "SENTRY" and for the AI-generated logo, including who owns the logo;
     - the guard disclosure and consent text, in English and Urdu;
     - the privacy policy, terms of service and the data-processing agreement with customers.
  3. I prepare a **legal pack** for them (what data, why, who sees it, how long it is kept, where it is hosted, which companies handle it) plus first drafts of the documents. Tell me when the lawyer is chosen, or say "legal pack" and I'll write it first so they can start.

- [ ] **4. Ask the pilot customer for the phone list** (one message). Ask for one row per kind of phone: **brand, model, Android version, mobile operator, how many guards carry it**, and whether the phones are the guards' own. I choose the test phones from it, and it fixes the manufacturer setup screens (EXT-32). It decides which phones the device tests run on.

- [ ] **5. Create the test Firebase project** (15 minutes). It is for pushes to the guard app (D-26), free on the Spark plan: never click "Upgrade". Production gets its own project later, because each environment keeps separate push keys (ARCH §19.1).
  1. Go to console.firebase.google.com and sign in with the company Google account.
  2. **Create a project** named `SENTRY Test`. Turn **off** Google Analytics and the Gemini (AI assistance) option.
  3. Choose **Add app → Android**. Package name `pk.sentryops.guard.dev`, nickname `SENTRY Dev`. Leave SHA-1 empty. Click **Register app**, then skip the remaining steps.
  4. Add a second Android app the same way: `pk.sentryops.guard.staging`, nickname `SENTRY Staging`.
  5. Open **Project settings** (the gear icon) → **General**. Under "Your apps", download **`google-services.json`**. Downloaded now, it covers both apps.
  6. In **Project settings → Cloud Messaging**, check that "Firebase Cloud Messaging API (V1)" says **Enabled**.
  7. In **Project settings → Service accounts**, click **Generate new private key**, then **Generate key**. **This file is a real secret:** it can send notifications to every installed test app. Never email it, paste it in chat or put it in the repository folder.
  8. Put both files in a folder **outside** the repository, for example `C:\Users\HP\Documents\SENTRY keys\firebase-test\`, and tell me the folder. I load the key into the git-ignored Terraform file without printing it, and apply it (no cost).

- [ ] **6. Create the Expo account** (10 minutes). It builds the guard app in the cloud.
  1. Sign up at expo.dev with the company email, on the **Free plan**. Turn on two-factor authentication.
  2. In the VS Code terminal run `npx eas-cli@latest login`.
  3. Tell me when it is done. I link the project and start the first build. The Free plan gives up to 15 Android builds a month, in a low-priority queue that can wait a while at busy times (expo.dev/pricing, checked 2026-11-08). That is enough for now. Extra builds are paid, so I'll tell you before any.

- [ ] **7. Get SMS quotes** (an hour of emails, then waiting). SOS texts the duty officers, and enrollment and new-phone codes can go by SMS. Until a provider exists, codes are handed over from the dashboard, and SOS texts fail visibly.
  1. Write to two or three providers for a quote. These advertise a bulk-SMS service in Pakistan, **and I cannot vouch for any of them**: sendpk.com, brain.net.pk, h3techs.com, robosms.pk, bulksms.com.pk.
  2. Ask each of them:
     - Is there an **HTTP API with delivery reports** (a callback for delivered or failed)?
     - Which **sender name** can we use (a registered "mask" of about 3 to 11 letters), who files it with the PTA, and how many working days does it take? Vendors quote 5, 15 and 30–45 working days. **Verify**.
     - What do the mask and each message cost on Jazz, Zong, Telenor and Ufone?
     - Do they deliver reliably to numbers on the Do Not Call list? (SOS texts are transactional.)
     - Is there a separate **test account** that sends only to numbers we list (ARCH §19.1)?
     - Where are the phone numbers stored, and will they sign a data-processing agreement? They see guards' and officers' numbers.
  3. Choose, and tell me which. I write the sender (the code has a place for it). Do not pay for a sender name until the lawyer's trademark search is back, if the name will be "SENTRY".

- [ ] **8. Run the Fable audit, pass 1.** Give Fable `docs/FABLE_LAUNCH_AUDIT.md` as the prompt, with the repository at commit `8854af8` (download https://github.com/securitysentry21-cpu/Sentry-Application/archive/8854af8.zip). The brief tells Fable to work from the code only. **Do not give it AWS access or any password or key.** Paste Fable's findings **into the chat with me, not into a file in the repository**: the repository is public and the findings describe weaknesses. I fix them during Phase 10. Pass 2 comes at the end.

## 2. When those are under way

- [ ] **9. Settle the name.** The app identifier `pk.sentryops.guard` and the name "SENTRY" become **permanent at the first Play upload** (Q-20). Ask the lawyer for the trademark result (item 3), and do a free first screen yourself: WIPO's Global Brand Database (branddb.wipo.int) and EUIPO's TMview (tmdn.org/tmview), which are not legal advice. Do not upload anything to Play until the name is settled.
- [ ] **10. Buy the domain** (about $10–15 a year, set by the registrar). Buy it after item 9, from a registrar such as Namecheap, Porkbun or Cloudflare. Use a **.com** on a company-owned account with two-factor authentication, automatic renewal and privacy protection. The dashboard and API will live at `app.<domain>`. Apple also wants a public website and a work email on the company's domain (see item 14), so a small web page and a company mailbox come with it. Tell me the name, and I set up production (`infra/terraform/env/production.tfvars`).
- [ ] **11. Move AWS to the Paid plan and activate its advanced features.** **Only after the domain exists**, and I'll say when. The step is **irreversible** and costs money: production is about $130–170 a month (my estimate in `infra/README.md`). The Free plan suspends the whole account when its credit runs out or after six months (2027-04-08), so real guards must never depend on it. I walk through the screens with you, because AWS changes them. I destroy the test environment afterward.
- [ ] **12. Open the Google Play Console as an organization** once the D-U-N-S number arrives.
  1. Use a company Google account with two-factor authentication, not a personal one.
  2. Sign up at play.google.com/console/signup and choose **Organization**.
  3. Pay the one-time registration fee. Third-party guides say about $25; Google's help page does not state it. **Verify** on the sign-up page.
  4. Enter the organization's details exactly as D&B has them, then verify the contact person's identity and phone. This can take days to a few weeks.
  5. Check that Pakistan is accepted on the sign-up screen. I could not confirm it from Google's pages. A free app needs no merchant account.
  6. Create the app, but **do not upload** until item 9. I prepare Google's declarations: foreground-service location with a video (EXT-04), background location with a video (EXT-05), the monitoring-tool declaration (EXT-20) and the Data safety form (EXT-06). Plan for at least two review rounds.
- [ ] **13. Register the app with Google's developer verification** (checked on developer.android.com, 2026-11-08). From 30 September 2026 Google has applied a verification rule in Brazil, Indonesia, Singapore and Thailand, and it **expands to all certified Android phones in 2027**; Google had not published a date for Pakistan. Apps from unregistered developers will be refused unless the user goes through an advanced flow. **This reaches your pilot, because the pilot installs the app directly (D-34).** Google's fee-free "limited distribution" account covers only 20 devices, too few for 50 or more guards. Once the Play account exists, register the app in the Play Console (apps on Play are registered automatically; others are added by hand). I'll re-check Google's page before the pilot.
- [ ] **14. Run the device tests on the pilot's phones.** After the first build is installed (item 6), I send the install link and the checklists, and you run them. The list is in `apps/mobile/README.md` under "Device tests (human)": reboot mid-shift (ADV-O05), airplane mode, app update mid-shift, permission changes, Urdu on a low-end phone, and the 12-hour soak. Record the results in `docs/testing/device-matrix.md`. `docs/phases/status.json` moves only after these are done.
- [ ] **15. Have a native Urdu speaker check the guard app's Urdu.** Say "Urdu sheet" and I generate a spreadsheet of every Urdu text beside its English one and where it appears on screen. The translations were written without a native speaker's check.
- [ ] **16. Look at the demo on your computer** (`pnpm db:up`, `pnpm api:dev`, `pnpm web:dev`, then `pnpm demo`):
  - [ ] Patrols: the Patrols page, and Sites → a site's checkpoints and patrol routes.
  - [ ] Incidents and SOS: at 2 minutes a report with a photo arrives; at 3 minutes an SOS covers the screen. Click "Enable alarm sound", then acknowledge and resolve it on its SOS page.
  - [ ] Reports and exports: Reports → each tab, then "Export CSV", and the Exports page to download it.
- [ ] **17. Install the test guard app on an Android phone** once item 6 has produced a build, run a test shift, print one QR label (Sites → Print QR labels) and scan it during the shift.
- [ ] **18. Accept your dashboard invitation** with an authenticator app. The link of 2026-10-09 lasted 7 days. Tell me, and I send a new one when the test setup is next switched on.
- [ ] **19. Protect your AWS sign-in:** Google 2-Step Verification if you signed up with Google, otherwise settings.aws.com → Manage security and sign-in → Register device.

## 3. Later

- [ ] **Apple Developer Program and iOS** (EXT-02, EXT-08, EXT-21, EXT-23). Not needed for Android pilots. When you want iPhones: $99 a year in USD (Apple's enrollment page, checked 2026-11-08). Apple requires a D-U-N-S number, a legal entity (no trade names), someone with authority to sign for the company, a public website with the company's domain, and a work email on that domain. Apple's page does not say which countries can enroll, so **verify Pakistan** by starting enrollment. iPhone pushes (APNs) and the iOS release wait for this.
- [ ] **The production Firebase project**, when production exists.
- [ ] **Re-check store policy** at every submission (EXT-45), and Google's target-API deadline each year (31 August).

## 4. Before the first real guard

Every box must be ticked. SOS stays off for pilot guards until its own three boxes are.

- [ ] Legal review signed off: disclosure, privacy policy, customer agreement (item 3).
- [ ] Production live on your domain, and the guard app built against it.
- [ ] Device tests done on the pilot's phones and recorded (item 14); `status.json` moved.
- [ ] Urdu text checked by a native speaker (item 15).
- [ ] The Fable audit's pass 1 and pass 2 done, with no open Critical or High finding (PROD §18).
- [ ] The pilot customer has printed its QR labels, its phones meet the minimum Android version, and its guards have mobile data.
- [ ] For SOS only: a real-phone SOS test, an SMS provider live with an approved sender name, and your approval.

## 5. What I am doing (Phase 10)

| Item                                                                       | State                                                   | Needs from you                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| Restore drill, smoke test                                                  | done on test, 2026-11-02                                | —                                  |
| Audit brief for Fable                                                      | done                                                    | item 8                             |
| Test IDs through Phase 10                                                  | done; only ADV-O05 (device test) is open                | item 14                            |
| **ADV-X08, the release manifest check**                                    | written and tested here; **its CI job has not run yet** | say "commit" so I can run it in CI |
| Guard push on the phone                                                    | not started                                             | items 5 and 6                      |
| Browser tests (Playwright)                                                 | not started                                             | —                                  |
| Load and simulator tests                                                   | not started; a real-size run needs production           | item 11                            |
| Remaining operator alarms                                                  | not started                                             | I show the cost before applying    |
| Crash reports to our own server                                            | not started                                             | —                                  |
| Nine runbooks and the operator commands they need                          | not started                                             | —                                  |
| Legal pack and drafts                                                      | not started                                             | item 3                             |
| Store material: Data safety, declarations, review notes, demo organization | not started                                             | items 9, 12                        |
| Production                                                                 | waits for items 9–11                                    | items 9–11                         |
| Fixes from Fable's findings                                                | pass 1 fixed and tested, uncommitted; Q1–Q5 open        | item 1 at the top                  |

## 6. Dates

- **About 2026-11-15** (it was started and paused again on 2026-11-08): AWS restarts the stopped test database by itself (every 7 days), at about $0.80 a day until I stop it again. Tell me "re-pause AWS": I start the sign-in (it opens a browser page for you to approve) and pause it.
- **2027-04-08:** the AWS Free plan ends. Upgrade (item 11) or lose the test environment.
- **2027:** Google's developer verification reaches all certified Android phones (item 13).
- **Every 31 August:** Google raises its minimum target API level; `MIN_TARGET_SDK` in the manifest check changes with it.
- **Every quarter:** a restore drill (`docs/testing/restore-drills.md`).

## 7. What it costs you

| Item                                           | Cost                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firebase (Spark), Expo (Free), D-U-N-S request | $0                                                                                                                                                                   |
| D-U-N-S, faster                                | an optional paid extra; skip it                                                                                                                                      |
| Google Play organization account               | one time, about $25 (**verify**)                                                                                                                                     |
| Apple Developer Program                        | $99 a year, when you want iPhones                                                                                                                                    |
| Domain                                         | about $10–15 a year                                                                                                                                                  |
| Company mailbox on the domain                  | a monthly price per mailbox, set by the provider                                                                                                                     |
| AWS test environment                           | from the $100 credit: about $80 a month switched on, almost nothing paused                                                                                           |
| AWS production                                 | about $130–170 a month, once real guards are on it                                                                                                                   |
| SMS                                            | a sender-name fee and a price per message, set by the provider (one vendor lists Rs 5,000 for the name; unverified)                                                  |
| Lawyer                                         | their quote                                                                                                                                                          |
| Maps                                           | $0. The map uses OpenStreetMap data from OpenFreeMap (D-12 revised), so **no Google Maps billing account is needed**. I check OpenFreeMap's terms before production. |

## Done

- [x] **GitHub repository.** Pushed on 2026-10-08. It is public, as you chose; to make it private later: Settings → General → Danger Zone → Change visibility.
- [x] **Open the AWS account.** Done (2026-10-09). The Free plan hosts the test setup in Sydney.
- [x] **Phase 8 and 9's additions on AWS:** approved and applied 2026-11-02. Phase 9 released to the test setup the same day.
- [x] **Confirm the location-history reason rule** (D-21): 2026-11-01. (D-22, guards seeing their own trail: you said no.)
- [x] **Look at the Live map with 1,000 guards** on a computer: 2026-11-01.
- [x] **Answer Q-22:** 2026-11-02. A replaced QR label says "Old QR code — report to supervisor".
- [x] **Commit and push Phase 9 and the start of Phase 10:** 2026-11-02 and 2026-11-08.
