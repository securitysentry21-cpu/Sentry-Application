# Runbook 07: Onboarding a large organization

> The pilot customer has about 1,000 guards and starts with about 50 at a few sites, then extends (`docs/DECISIONS.md` D-34). Setup: `docs/RUNBOOKS/README.md` › Before you start. SMS does not exist yet (EXT-10): invitation links and enrollment codes are handed over in person or by phone. Real guards may only join **production**, which does not exist yet; `test` is for test data only.

## When to use

Signing a new company, or growing one from a first group to the rest of its guards.

## First five minutes (before day one)

| Check                                                                                                          | Why                                                | Source                                          |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Production exists, on the company domain, and the guard app is built against it                                | The app has the server address built in            | `infra/README.md` › Before the first real guard |
| Legal review signed off; customer agreement signed; guard notice reviewed                                      | Required before any real guard                     | `TODO.md` section 4; `docs/legal/README.md`     |
| Customer sent the **device census** (brand, model, Android version, mobile operator) and printed its QR labels | Pick test phones; labels must exist before patrols | `docs/EXTERNAL_DEPENDENCIES.md` EXT-19          |
| The owner agrees any extra cost (bigger database, more API tasks)                                              | No purchases without the owner                     | `variables.tf`                                  |
| Staffed control room with a person on the dashboard in every shift                                             | SOS depends on it (PROD §11.5)                     | `docs/PRODUCT_SPEC.md`                          |

## Decide: size

The sizes in `variables.tf` are for Pilot 0 (about 50 guards): `db.t4g.micro`, one API task of 0.25 CPU and 512 MB. "Raise before the 1,000-guard rollout."

| Guards live    | Do                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Up to about 50 | Current sizes.                                                                                                                                                                                 |
| More           | Ask the owner. Raise `db_instance_class` and `api_desired_count` in the environment's tfvars and apply. No load test has proven any size (G22), so grow in steps and watch runbook 04's signs. |

## Fix: the steps

1. **Create the organization.** Name, owner's e-mail, time zone (default `Asia/Karachi`). No e-mail is sent.

```bash
infra/scripts/operator.sh <env> create-organization --name "<company>" --owner-email <owner's email> --timezone Asia/Karachi | tr '\t' '\n'
```

It prints `Organization <id> created in <region>.`, then "Send this invitation link to the owner (valid 7 days, single use):" and the link. (For a rehearsal add `--demo`: a demo organization has no real people and every SOS in it is a drill. Tried on `test` 2026-11-08 with `--demo`; the command takes about two minutes. There is no command to delete an organization, so a rehearsal organization stays: name it so it is recognisable. [GAP: no way to delete an organization (G26).]) **Write the ID in your private register** (G02) and give the link to the owner in person or by phone. The owner signs in with an e-mail code, then sets up an authenticator app (MFA is required).

2. **Owner sets up** (Settings): the emergency call number and emergency contacts, the SOS escalation steps, the alert phone number of each duty officer (Members page), and notifications on each duty officer's device with the test "Send me a test SOS alert".
3. **Sites.** Create sites with geofences, then checkpoints. Print each site's QR sheet (Sites › print) and stick the labels before any patrol.
4. **Staff.** Invite supervisors, dispatchers and administrators one at a time (Members page). Each invitation shows its link once; at most 1,000 invitations per organization per day. [GAP: no bulk staff invitation, and the link is not e-mailed (G20).]
5. **Guards, in bulk.** Guards page › import a UTF-8 CSV with the header `employee_number,display_name,phone` and optionally `preferred_locale` (`en` or `ur`). Limits: 5,000 rows, 1,000,000 characters, numbers in international format. Run **Preview** first. One bad row blocks the whole import, so fix and preview again until there are no errors, then import (the audit log gets `GUARDS_BULK_IMPORTED`). Only the first 500 errors are listed.
6. **Shifts.** Shifts page › weekly pattern: one guard, one site, one pattern per submission, at most 62 days at a time. Preview shows conflicts; any conflict blocks the creation. [GAP: no CSV shift import; hundreds of guards means hundreds of submissions (G20).]
7. **Enroll phones, in person.** Guards page › "Enroll phone" for one guard shows a code and QR **once**. The guard scans or types it and enters their own phone number. Limits:

| Limit                            | Value                                                                      |
| -------------------------------- | -------------------------------------------------------------------------- |
| Code lifetime                    | 7 days; a new code cancels the previous one                                |
| Codes per guard                  | 3 per day                                                                  |
| Wrong tries per code             | 5, then the code is spent                                                  |
| Redemptions per phone number     | 10 per hour                                                                |
| Redemptions per internet address | 120 per hour                                                               |
| Codes work for                   | numbers starting +92 only (`ALLOW_FOREIGN_GUARD_PHONES` is not set in AWS) |

The 120-per-hour address limit is shared by everyone on the same Wi-Fi or the same mobile operator address. Enroll in groups of at most about 100 per hour per place, or the rest get a "try later" answer (429). [GAP: no bulk code issue and no printed code sheet; 1,000 guards means 1,000 clicks and handovers (G20).]

8. **First shifts.** Each guard accepts the tracking notice, grants permissions, and starts a shift. Guards starting at the same minute (a shift change) are the busiest moment: each phone may send at most 120 sync requests per minute.
9. **Device census after enrolment.** Each guard's page lists their phone, OS and app version. [GAP: no organization-wide device or version list (G21).]

Source: `apps/api/src/cli/operator.ts`, `routes/guards.ts` (`planImport`), `routes/shifts.ts`, `routes/enrollment.ts`, `routes/invitations.ts`, `rate-limit.ts`, `repositories/invitations.ts`.

## Confirm it is fixed

- Guards page: every imported guard shows enrolled. The live map shows guards LIVE during a first shift.
- Look for stuck items:

```bash
infra/scripts/operator.sh <env> quarantine-list --org <org> --reason "onboarding check" | tr '\t' '\n'
```

- The API log shows no run of `429` or `5xx` during enrolment and shift change (runbook 04).
- Each duty officer's test alert arrived.

## Tell

| Who                              | What                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner (`<owner>`)            | Organization created, ID recorded, what the company must still do.                                                                                                                              |
| Company owner and administrators | A written handover: what each role can do, the emergency number setting, the enrolment rules above, that SOS is off for pilot guards, and that they must keep a person on the dashboard.        |
| Guards                           | The company explains the tracking notice. The notice must be reviewed first (`docs/legal/GUARD_DISCLOSURE_CHECK.md`).                                                                           |
| Legal                            | Customer agreement and data-processing agreement signed before real data (`docs/legal/DATA_PROCESSING_AGREEMENT.md`). [LAWYER: anything the contract needs before the first guard is enrolled.] |

## Afterwards

Record the organization ID (private), date, counts imported and enrolled, and anything that blocked. Plan the next group. Book the first weekly `quarantine-list` check (runbook 06).

## Status

Tried on the test environment: step 1 (`create-organization`) was used to set up `test` and was run again on 2026-11-08 with `--demo` (it worked, exit 0). The steps after it need a signed-in owner and a dashboard, so they were not tried; the bulk steps have automated tests only, and nothing has run at 1,000-guard scale.

Known gaps: G02, G20 (no bulk invitations, code issue or shift import), G21, G22 (sizes unproven). `docs/PRODUCT_SPEC.md §4.2` describes sending guard invitations in batches within the daily limit; the code imports guard records only and issues codes one guard at a time.
