# OPEN_QUESTIONS.md

These questions are waiting for the product owner. When one is answered, record the answer in `docs/DECISIONS.md` and delete its row here.

On 2026-10-08 (round 6) the owner delegated every open question. Q-13 and Q-18–Q-21 and D-11 were decided under that delegation; `docs/DECISIONS.md` records each decision and its reason, so any of them can be reversed.

| ID | Question | Why it matters | Needed by |
|---|---|---|---|
| — | Make the GitHub repository private (recommended), then push, or confirm it should stay public | It is public today; pushing would publish the code and the security design. Nothing has been pushed. | before the first push |

## Owner actions (long lead times; start now)

| Action | Why | Blocks |
|---|---|---|
| **Open the AWS account** (two accounts for staging and production) | The pilot needs a server the phones can reach; Cognito (D-01) lives there too | Pilot 0 |
| **Start the legal review**: data protection and employee monitoring in Pakistan, hosting in the EU, the trademark search for "SENTRY", and the AI-generated logo | EXT-17; needed before any real guard data | Pilot 0 |
| Ask the pilot customer for a device census: phone brand and model, Android version, mobile operator | Picks the Phase 0B test phones and the manufacturer setup screens | Phase 0B |
| Create an Expo account | Cloud builds of the guard app (the pilot installs it directly, D-34) | Pilot 0 |
| Put the wordmark vector file in `design/brand/` | App icon, splash screen, store listing, printed QR labels | Phase 2 |
| Get a D-U-N-S number for the company, then enroll in the Apple Developer Program and Google Play Console as an organization | Developer accounts; avoids Play's closed-testing gate for new personal accounts (EXT-01–03) | store release |
| Open an account with a Pakistani SMS aggregator and register a sender ID | Guard invitations by SMS (D-02) and SOS SMS to duty officers (D-04). Until then, codes are handed over from the dashboard | Phase 8 (SOS) |
