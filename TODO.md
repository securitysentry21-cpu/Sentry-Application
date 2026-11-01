# To-do (owner)

Things only you can do, in order. Tick an item by changing `[ ]` to `[x]`, or tell me and I'll update the list. The full A–Z plan, with my steps too, is in the chat of 2026-10-09.

## Done

- [x] **GitHub repository.** Pushed on 2026-10-08. It is public, as you chose; to make it private later: Settings → General → Danger Zone → Change visibility.
- [x] **Open the AWS account.** Done (2026-10-09). It stays on the Free plan for the test setup in Sydney.

## Now: the test setup (free)

- [ ] **Accept your dashboard invitation** with your email and an authenticator app. The link of 2026-10-09 lasted 7 days; if you didn't use it, I'll send a new one when the test setup is next switched on.
- [ ] **Protect your AWS sign-in:** Google 2-Step Verification if you signed up with Google, otherwise settings.aws.com → Manage security and sign-in → Register device.
- [ ] **Create a free Expo account** at expo.dev (Free plan only), then run `npx eas-cli@latest login` in the VS Code terminal.
- [ ] **Install the test guard app** on an Android phone from the link I send, and run a test shift.
- [x] **Confirm the location-history reason rule** (D-21): confirmed 2026-11-01. A reason is asked for every time someone views a guard's location history; it is optional unless you switch it to mandatory in Settings. (D-22, guards seeing their own trail: you said no on 2026-11-01.)
- [x] **Look at the Live map with 1,000 guards** on a computer: done 2026-11-01 ("Map looks good"). On a phone it waits for the test setup on AWS.

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
