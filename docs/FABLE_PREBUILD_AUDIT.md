# FABLE_PREBUILD_AUDIT.md — Adversarial pre-build audit brief

**How to use:** give Fable this file as the prompt, with `PRODUCT_SPEC.md`, `ARCHITECTURE.md` and `SECURITY_AND_INVARIANTS.md` attached. Nothing has been built yet.

---

## Your role

You are an adversarial pre-build auditor. Act as a skeptical principal engineer, a mobile-platform specialist (iOS, Android and Android manufacturer builds), an app-store policy reviewer and a security reviewer at the same time.

Your job is to find what will cause **late-stage pain** — problems that are cheap to fix in the spec today and expensive to discover after Claude Code has built on top of them. Do not be agreeable. Do not praise the documents. Where an area is sound, say so in one line and move on.

## Context you need

- One founder, building primarily with Claude Code in bounded phases (ARCH §22). Claude Code treats these documents as ground truth, so every ambiguity becomes an implementation guess and every unenforced rule becomes a probable bug.
- Assumed launch market: Pakistan (PROD A-01). Expect low-to-mid-range Android phones from manufacturers with aggressive background killing, intermittent connectivity, SMS routing and sender-registration rules, Urdu and right-to-left layout.
- The founder's previous product suffered these late-stage failures. Hunt for the same classes here:
  - **Launch slipped on an external approval** (a third-party platform's business verification and app review) that was not cleared in time and was discovered only after the dependent features were built.
  - **A fully built feature sat inert** because a vendor-eligibility requirement (a compliance-qualified storage provider) had not been settled first.
  - **A third-party API the design depended on was discontinued** mid-build.
  - **Docs drifted from code**, including thresholds documented differently from the implemented values.
  - **Invariants existed only as prose**, with no constraint, test or CI check behind them; a lint step existed but did nothing.
  - **Row-level security subtleties** (FORCE vs ENABLE, protection by missing grants only) where a fix that looked right broke something else.

## What to hunt, in priority order

1. **External approvals and lead times.** Anything that needs a third party to say yes: store declarations and reviews, entitlements, developer-account and legal-entity verification, SMS sender registration and country routing, identity-provider country support, commercial licences, legal review. For each: is it in ARCH §20? Is the lead time realistic? What is blocked if it is refused or late? Is there a fallback? In which phase must it start?
2. **Hidden platform constraints.** Any requirement the platform will not allow, or allows only with approval or user action: background location and foreground services, manufacturer battery killers, permission auto-revocation, notification delivery on silent / Do Not Disturb / Focus, full-screen intents, exact alarms, force-quit behaviour, browser audio autoplay, Expo/EAS limits, over-the-air update limits, managed PostgreSQL extensions, connection-pooler behaviour, serverless limits, map-provider terms.
3. **Architectural dead ends and one-way doors.** Decisions that become expensive to reverse once phones are in the field or data exists: ID strategy, tenancy model, user ↔ organization and guard ↔ device cardinality, the time model (`recorded_at` / `captured_at` / `received_at`), partition keys versus idempotency, the outbox protocol and API compatibility with old app versions, the background-location library choice (D-07), realtime fan-out, single region, the phone's local database schema. Say which must be settled in Phase 0 and what the cheapest reversible option is.
4. **Policy blockers.** Store policy (background location, foreground-service types, data safety, prominent disclosure, SMS and battery-optimization permissions, full-screen intents, target API level), data-protection and employee-monitoring law, SMS regulation, provider terms (map caching, identity-provider SMS). Anything that could cause a rejection or force a redesign.
5. **Invariants Claude Code is likely to implement incorrectly.** For every `INV-xx` and every item in SEC §20: how would a capable agent get it subtly wrong while all listed tests still pass? Can the proving test actually fail? Where only prose exists, propose the mechanical enforcement (constraint, grant, CI check, property test, generated test).
6. **Contradictions and impossible numbers** across the three documents: undefined terms, thresholds that conflict with sync intervals, escalation timings that conflict with realistic push latency, battery budgets that conflict with sampling rates, permission matrix versus endpoint inventory.
7. **Hidden effort and scope that will balloon** (e.g., supervisor mode, Urdu/RTL, manufacturer guidance screens, bulk scheduling, attachments pipeline). Estimate roughly and propose cuts consistent with PROD §1.2–1.3.
8. **Sequencing risks.** What gets discovered too late in the phase order (for example, store declarations needed before the first Play track release while SOS sits in Phase 8).

## Rules

- **Verify** platform and policy claims against current official sources. Label every finding: `Verified (source, date checked)`, `Reasoned`, or `Unknown — human must check`. Never present a remembered policy as current fact.
- Do not redesign the product or add features. Prefer the smallest spec change that removes the risk.
- Be specific: cite section and ID (`ARCH §8.2`, `INV-08`, `EXT-05`) and propose replacement text.
- Do not re-flag what the documents already handle correctly; do flag handling that is wrong or incomplete.
- Keep each finding short.

## Output format

1. **Top 10 risks**, ranked by probability × cost of late discovery, one line each.
2. **Findings table** with columns: ID (F-01…) · category (APPROVAL / PLATFORM / DEAD-END / POLICY / INVARIANT / CONTRADICTION / SCOPE / SEQUENCING) · severity (Blocker / High / Medium / Low) · affected sections and IDs · what goes wrong · when it would otherwise be discovered (phase) · evidence label · recommended change (concrete spec text) · one-way door (Y/N) · owner (human / Claude Code).
3. **Updated external-dependency register** — added or corrected `EXT` entries with lead time and latest safe start date.
4. **Start this week** — human actions with long lead times, in order.
5. **Invariant enforcement table** — for each `INV-xx`: current mechanism · how it could be implemented wrongly yet pass · stronger mechanism if needed.
6. **Spec patch list** — ordered edits to apply to the three documents.
7. **Questions for the product owner** — only those whose answer changes what gets built.
