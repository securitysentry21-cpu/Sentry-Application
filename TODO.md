# To-do (owner)

Things only you can do, in order. Tick an item by changing `[ ]` to `[x]`, or tell me and I'll update the list. The full A–Z plan, with my steps too, is in the chat of 2026-10-09.

## Done

- [x] **GitHub repository.** Pushed on 2026-10-08. It is public, as you chose; to make it private later: Settings → General → Danger Zone → Change visibility.
- [x] **Open the AWS account.** Done (2026-10-09). It stays on the Free plan for the test setup in Sydney.

## Now: the test setup (free)

- [ ] **Accept your dashboard invitation** with your email and an authenticator app. The link of 2026-10-09 lasted 7 days; if you didn't use it, I'll send a new one when the test setup is next switched on.
- [ ] **Protect your AWS sign-in:** Google 2-Step Verification if you signed up with Google, otherwise settings.aws.com → Manage security and sign-in → Register device.
- [ ] **Create a free Expo account** at expo.dev (Free plan only), then run `npx eas-cli@latest login` in the VS Code terminal.
- [ ] **Install the test guard app** on an Android phone from the link I send, and run a test shift. Print one QR label from the dashboard (Sites → Print QR labels) and scan it during the shift.
- [x] **Confirm the location-history reason rule** (D-21): confirmed 2026-11-01. A reason is asked for every time someone views a guard's location history; it is optional unless you switch it to mandatory in Settings. (D-22, guards seeing their own trail: you said no on 2026-11-01.)
- [x] **Look at the Live map with 1,000 guards** on a computer: done 2026-11-01 ("Map looks good"). On a phone it waits for the test setup on AWS.
- [ ] **Look at patrols in the demo** on a computer (`pnpm demo`, as for the map): the Patrols page, and Sites → a site's checkpoints and patrol routes.
- [x] **Answer Q-22:** answered 2026-11-02. A replaced QR label says "Old QR code — report to supervisor".
- [ ] **Look at incidents and SOS in the demo** on a computer (`pnpm demo`, as for the map):
  - at 2 minutes, a report with a photo arrives on the Incidents page;
  - at 3 minutes, an SOS covers the screen. Click "Enable alarm sound", then acknowledge and resolve it on its SOS page.
- [x] **Phase 8 and 9's additions on AWS:** approved and applied 2026-11-02 (photo and export storage, the push keys, alarm emails and the retention connection, under $0.10 a month in all). Phase 9 released to the test setup the same day.
- [ ] **Confirm the AWS alarm emails.** AWS sent "AWS Notification - Subscription Confirmation" to your email. Click "Confirm subscription" in it, or the SOS pipeline alarms reach nobody. Check the spam folder if it isn't there.
- [ ] **Look at reports and exports** on a computer (`pnpm demo` fills them): Reports → each tab, then "Export CSV", and the Exports page to download it.
- [ ] **Create the test Firebase project** for pushes to the guard app (D-26). It's free (the Spark plan); never click "Upgrade". This one is for testing only: production gets its own project later, because each environment keeps its own push keys (ARCH §19.1).
  1. Go to console.firebase.google.com and sign in with the company Google account.
  2. **Create a project** named `SENTRY Test`. Turn **off** Google Analytics and the Gemini (AI assistance) option; neither is needed.
  3. On the project's page choose **Add app → Android**. Package name `pk.sentryops.guard.dev`, nickname `SENTRY Dev`. Leave the SHA-1 empty. Click **Register app**, then skip the remaining steps (Next, Next, Continue to console).
  4. Add a second Android app the same way: `pk.sentryops.guard.staging`, nickname `SENTRY Staging`.
  5. Open **Project settings** (the gear icon) → **General**, scroll to "Your apps" and download **`google-services.json`**. Downloaded now, it covers both apps.
  6. In **Project settings → Cloud Messaging**, check that "Firebase Cloud Messaging API (V1)" says **Enabled**.
  7. In **Project settings → Service accounts**, click **Generate new private key**, then **Generate key**. A `.json` file downloads. **This is a real secret:** it can send notifications to every installed test app. Never email it, paste it in chat or put it in the repository folder.
  8. Move both files into one folder **outside** the repository, for example `C:\Users\HP\Documents\SENTRY keys\firebase-test\`. Tell me the folder. I'll load the key into the git-ignored Terraform file without printing it, apply it (no cost), and use `google-services.json` for the next guard-app build.
- [ ] **Run the Fable audit, pass 1.** Give Fable `docs/FABLE_LAUNCH_AUDIT.md` as the prompt, with the repository at commit `8854af8` (download it from https://github.com/securitysentry21-cpu/Sentry-Application/archive/8854af8.zip). Send me its findings; I'll fix them during Phase 10. Pass 2 comes at the end of Phase 10.

## Start now: these take weeks of waiting on others

- [ ] **Start the legal review of the tracking disclosure.** It must be done before any real guard data is collected.
- [ ] **Get a D-U-N-S number for the company** (free; days to weeks). Google Play and Apple need it for a company developer account.
- [ ] **Open a Google Play developer account as a company** (a one-time fee of about $25, which you pay). Play checks apps that track location in the background strictly and often turns down the first submission, so plan for two rounds or more. The first pilot sites install the app directly (D-34); the rollout to all ~1,000 guards needs Play.
- [ ] **Choose a Pakistani SMS provider and register a sender ID** with the company's documents. SOS texts the duty officers (Phase 8); without the provider, that part of SOS can't work.

## Before the first real guard

- [ ] **Get the pilot's phone models** (the device census).
- [ ] **Run the device tests** in `apps/mobile/README.md` on the most common of those phones.
- [ ] **Have a native speaker check the Urdu** in the guard app.
- [ ] **Buy the domain** (about $10–15 a year, outside AWS while on the Free plan; namecheap.com or porkbun.com). The guard app has the server address built in.
- [ ] **Switch AWS to the Paid plan, then "activate advanced features"** (irreversible; unlocks Frankfurt). The Free plan suspends the whole account when the credit runs out, so real guards must never depend on it. Then I build production (`infra/README.md`).
