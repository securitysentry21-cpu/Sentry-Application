# OPEN_QUESTIONS.md

These questions are waiting for the product owner. When one is answered, record the answer in `docs/DECISIONS.md` and delete its row here.

Answered so far (2026-10-08): questions 1–6 of the review and Q-07–Q-17, except the pilot start date (Q-13). `docs/DECISIONS.md` records every answer.

| ID | Question | Why it matters | Needed by |
|---|---|---|---|
| Q-18 | Answered in part: there are both stationed guards and roaming patrols. Still open: can each patrol beat be described by a circle of up to 5 km radius, or do beats need boundaries drawn on the map? Default if you don't know yet: circles first, then add drawn boundaries if the pilot shows beats don't fit. | Drawn boundaries (polygon geofences) are out of V1 scope today; adding them is extra Phase 2 work. | Phase 2 |
| Q-19 | Which colony size is right? 312,000–313,000 kanals is about 39,000 acres or 158 km²; 331 km² would be about 82,000 acres. | Not blocking; it sets the map's default view and gives a rough count of sites. Worth fixing if the figure is used in sales material. | Phase 2 |
| Q-13 | Is there a target date for the pilot? | Planning only; the architecture doesn't depend on it. | Phase 0 |
| D-11 | Please confirm: PostgreSQL also runs the background jobs and the realtime fan-out (pg-boss, LISTEN/NOTIFY). Redis is added only if measurements show a need. | The kept outbox, SSE replay and job design (D-09) assume it, and it means no extra server to run or pay for. | Phase 1 |
| Q-20 | Which internet domain does the company own, or will it register, for the app identifiers? Android and iOS identify the app by a reversed domain, for example `pk.yourcompany.sentry.guard`. Placeholder today: `com.example.sentry.guard`. | Permanent once the app is in a store; Apple also registers it with the first iPhone build. | Phase 0B |
| Q-21 | Can dispatchers view the shift schedule (view only)? PROD §3.2 has no row for viewing shifts. Built as **yes**: Dispatchers and above see shifts, guards only their own. | Authorization: the answer becomes a row in the PROD §3.2 permission matrix. | Phase 3 |

## Owner actions (long lead times; start now)

| Action | Why | Blocks |
|---|---|---|
| Put the wordmark vector file in `design/brand/` | App icon, splash screen, store listing, printed QR labels | Phase 2 |
| Get a D-U-N-S number for the company, then enroll in the Apple Developer Program and Google Play Console as an organization | Developer accounts; avoids Play's closed-testing gate for new personal accounts (EXT-01–03) | Phase 0B (iOS builds), Phase 4 (Play) |
| Open an account with a Pakistani SMS aggregator and register a sender ID | Guard invitations and new-phone codes (D-02); SOS SMS to duty officers (D-04) | Phase 2 |
| Ask the pilot customer for a device census: phone brand and model, Android version, mobile operator | Picks the Phase 0B test phones and the manufacturer setup screens | Phase 0B |
| Start the legal review: data protection and employee monitoring in Pakistan, hosting in the EU, the trademark search for "SENTRY", and the AI-generated logo | EXT-17; needed before any real guard data | before Pilot 0 |
