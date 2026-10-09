# OPEN_QUESTIONS.md

These questions are waiting for the product owner. When one is answered, record the answer in `docs/DECISIONS.md` and delete its row here.

On 2026-10-08 (round 6) the owner delegated every open question. Q-13 and Q-18–Q-21 and D-11 were decided under that delegation; `docs/DECISIONS.md` records each decision and its reason, so any of them can be reversed.

No questions are open. (The last one, whether the repository stays public, was answered on 2026-10-08: public, and pushed.)

## Owner actions (long lead times; start now)

| Action | Why | Blocks |
|---|---|---|
| **Open the AWS account** (two accounts for staging and production) | The pilot needs a server the phones can reach; Cognito (D-01) lives there too | Pilot 0 |
| **Start the legal review**: data protection and employee monitoring in Pakistan, hosting in the EU, the trademark search for "SENTRY", and the AI-generated logo | EXT-17; needed before any real guard data | Pilot 0 |
| Ask the pilot customer for a device census: phone brand and model, Android version, mobile operator | Picks the Phase 0B test phones and the manufacturer setup screens | Phase 0B |
| Run the device tests in `apps/mobile/README.md` on the pilot's phones (reboot mid-shift, app killed, app updated, a 12-hour battery and data soak, permission flows, Urdu on a low-end phone) | Phase 4's exit needs them (ADV-O04, O05, O08, U02); they can only be run by a person with the phones | Pilot 0 |
| Have a native Urdu speaker review the guard app's Urdu text | The translations were written without a native-speaker check | Pilot 0 |
| Create an Expo account | Cloud builds of the guard app (the pilot installs it directly, D-34) | Pilot 0 |
| Put the wordmark vector file in `design/brand/` | App icon, splash screen, store listing, printed QR labels | Phase 2 |
| Get a D-U-N-S number for the company, then enroll in the Apple Developer Program and Google Play Console as an organization | Developer accounts; avoids Play's closed-testing gate for new personal accounts (EXT-01–03) | store release |
| Open an account with a Pakistani SMS aggregator and register a sender ID | Guard invitations by SMS (D-02) and SOS SMS to duty officers (D-04). Until then, codes are handed over from the dashboard | Phase 8 (SOS) |
