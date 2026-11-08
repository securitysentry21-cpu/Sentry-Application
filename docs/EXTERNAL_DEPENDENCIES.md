# EXTERNAL_DEPENDENCIES.md — live register

This is the live copy of ARCH §20, with an owner and a status for each item. Update it whenever an item moves.

**Re-check every policy against the official source when you act on it; store policies change.**

Status on 2026-11-08 (Phase 10). Rows changed since 2026-10-08 say so; the owner's step-by-step guide is `TODO.md`.

## Approvals and accounts

| ID | Item | Owner | Status | Needed by | Next step |
|---|---|---|---|---|---|
| EXT-01 | Legal entity verification: D-U-N-S number for organization enrollment | Faraz | **Not filed yet (2026-11-08):** the company is registered in Pakistan. D&B's free request can take up to 30 working days | Before the Play organization account | `TODO.md` item 2 |
| EXT-02 | Apple Developer Program, as an organization | Faraz | Not started | Phase 0B (iOS builds) | Enroll once the D-U-N-S number arrives |
| EXT-03 | Google Play Console, as an organization | Faraz | Not started | Phase 4 | Enroll as an organization: new personal accounts need 12 testers for 14 days |
| EXT-04 | Play foreground-service (location) declaration and video | Faraz + Claude Code | Not started | First Play track release | Submit at the end of Phase 4 |
| EXT-05 | Play background-location declaration and video | Faraz + Claude Code | Not started | First Play track release | Submit at the end of Phase 4; plan for at least two review rounds |
| EXT-06 | Play Data safety form; target API level 36 | Claude Code | The target level is checked in every release build by CI (ADV-X08, `MIN_TARGET_SDK`); the Data safety answers are Phase 10 work | Phase 10 | — |
| EXT-07 | Apple Critical Alerts entitlement | — | **Not needed:** there is no native supervisor app (D-04) | — | — |
| EXT-08 | App Store review: background location, login-gated B2B app | Faraz + Claude Code | Not started | Phase 10 | Review notes and the demo organization (PROD §17) |
| EXT-09 | APNs key and Firebase project (FCM) for guard push | Faraz | **2026-11-08:** the test Firebase project's steps are in `TODO.md` (item 5), waiting on the owner. The server can send (D-26). The phone does not register yet. APNs waits for the Apple account | Phase 10 | `TODO.md` item 5 |
| EXT-10 | Pakistani SMS aggregator, with sender-ID registration | Faraz | **Not started; start now** | Phase 2 (guard enrollment), Phase 8 | Shortlist aggregators that deliver well on Jazz, Zong, Telenor and Ufone; register a sender ID with the company's documents |
| EXT-11 | Identity provider for dashboard users | — | **Done (Phase 1):** Amazon Cognito (D-01), MFA required, in the AWS account | — | — |
| EXT-12 | Background-location library licence (only if D-07 picks a commercial one) | Faraz | Waiting on Phase 0B evidence | Phase 4 | — |
| EXT-13 | Google Maps Platform billing (D-12) | — | **Not needed (2026-11-08):** D-12 was revised to MapLibre with OpenFreeMap tiles. Before production, check OpenFreeMap's terms and availability, and list it as a sub-processor | Phase 10 | — |
| EXT-14 | AWS account for the first cell: eu-central-1, backups in eu-west-1 (D-37) | Faraz | **Test environment done (2026-10-09):** Sydney, Free plan, released and restore-drilled. **Production waits** for the domain, the Paid plan and its advanced features | Before the first real guard | `TODO.md` items 10–11 |
| EXT-15 | Email sending domain with SPF, DKIM and DMARC | Faraz | Not started | Phase 1 | Needs the company domain (Q-20) |
| EXT-16 | Public privacy policy, terms and support URLs | Faraz | Not started | Phase 10 | — |
| EXT-17 | Legal review: data protection, employee monitoring, EU hosting, trademark, AI-generated logo, disclosure texts | Faraz | **Not started; start now** | Before Pilot 0 | Engage counsel |
| EXT-18 | Expo account and EAS plan; signing credentials | Faraz | Not started | Phase 0B | Create a free Expo account |
| EXT-19 | Customer readiness: QR labels, guards' phones meet the minimum OS, guards have mobile data | Pilot customer | Not started | Pilot | Device census first |
| EXT-20 | Play monitoring-tool declaration, persistent-notification rule, listing disclosure | Claude Code + Faraz | The manifest declaration is checked in every release build by CI (ADV-X08). The notification rule and the listing text are open | First Play track release | Confirm whether the notification must show outside shifts |
| EXT-21 | Apple guideline 5.1.5: describe SOS as alerting the company's control room, not as an emergency service | Claude Code | Planned | Phases 8 and 10 | — |
| EXT-22 | Reviewer access without a Pakistani SMS (demo enrollment code) | Claude Code | Planned | First review | — |
| EXT-23 | iOS distribution route: public or unlisted App Store | Faraz | Planned | Phase 10 (D-25) | — |
| EXT-24 | GitHub repository for CI | Faraz | **Done (2026-10-08):** public, at the owner's choice; CI runs on every push, including a history-wide secret scan | — | — |
| EXT-47 | Google's Android developer verification: apps on certified phones must come from a registered developer, **including apps installed directly**. Live in Brazil, Indonesia, Singapore and Thailand since 2026-09-30; **all countries in 2027**, no date for Pakistan yet (developer.android.com/developer-verification, checked 2026-11-08). The no-fee limited-distribution account covers 20 devices only | Faraz | **Added 2026-11-08; not started** | Before the pilot installs the app directly (D-34), and at the latest when 2027's rule reaches Pakistan | Register the app in the Play Console once the organization account exists (`TODO.md` item 13); re-check Google's page before the pilot |

## Platform constraints

These shape the design (ARCH §20.2).

| ID | Constraint | Where the design handles it |
|---|---|---|
| EXT-30 | Android 11+ grants background location separately, in system settings | Two-step permission flow (PROD §7.3) |
| EXT-31 | Android 14+ foreground-service types; Android 12+ restricts starting services from the background | Tracking starts from a user action; reboot path tested in Phase 0B |
| EXT-32 | Manufacturer battery killers (Xiaomi, Oppo/Realme, Vivo, Samsung, Huawei, Transsion) | Guided setup for the census brands, readiness check, device matrix |
| EXT-33 | Play restricts `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Open the settings screen instead |
| EXT-34 | Play restricts SMS permissions to default SMS apps | The phone opens the SMS composer; it never sends in the background |
| EXT-35 | Full-screen intents are restricted on Android 14+ | Not used: there is no native supervisor app |
| EXT-36 | Exact alarms are restricted | Failsafes run on location callbacks |
| EXT-37 | Android revokes permissions of unused apps | Readiness item |
| EXT-38 | iOS stops background location after a user force-quit | Stale/offline detection and an interruption report |
| EXT-39 | Silent and Do Not Disturb suppress web push and SMS too | SMS to duty officers at 0 s; staffed control room; setup test |
| EXT-40 | Browsers block audio until the user interacts | "Enable alarm sound" control and warning |
| EXT-41 | Serverless can't host SSE, listeners or workers | Long-lived ECS containers (D-37) |
| EXT-42 | Transaction poolers break session `SET` and `LISTEN` | `set_config(..., true)` inside transactions (**done**); a dedicated listener connection |
| EXT-43 | Unique indexes on partitioned tables must include the partition key | Ingest-keys table if partitioning arrives (ARCH §6.5) |
| EXT-44 | Expo Go can't do background location; OTA can't change native config; SDK 55+ is New Architecture only | Development builds; OTA policy; module compatibility checked in Phase 0B |
| EXT-45 | Store policies change yearly | Re-verify at each submission |
| EXT-46 | Play counts wake locks held by foreground services in its vitals (since 1 Mar 2026) | Heartbeats ride on location callbacks; Phase 0B checks each library |
