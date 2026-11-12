# Runbook 08: Tenant data incident response

> For any case where one company's data may have been seen, changed, copied or lost by someone who should not have had it. Guards' locations are sensitive, and exposure can put a person at physical risk: move fast, and **call the company before you write to it**.
> Setup: `docs/RUNBOOKS/README.md` › Before you start. Only the two commands under "Preserve evidence" (the log tail and the snapshot) have been tried on the test environment (Status, below).

## When to use

- A company or guard reports that another company's data is visible, or someone exported data they should not have.
- A dashboard account is stolen or misused; a guard phone is lost or stolen.
- A secret or key leaked (then also runbook 05).
- A GuardDuty e-mail (production only: GuardDuty is blocked on the test account), or an unexplained entry in a company's Audit Log.

## First five minutes

1. Open a private incident log **outside the repository** (it is public). Write the time, who told you, what they said. Do not guess; mark guesses as guesses.
2. **Do not delete anything.** Logs live 30 days, backups 35 (production) or 1 day (`test`), and retention deletes aged data every night. If evidence will age out soon, preserve it first (below).
3. Scope: which company or companies, which kind of data (location, incidents, photos, personal data, exports), which period.
4. Ask the affected company's **owner** to read their Audit Log (Audit Log page, or `GET /api/v1/audit-logs`, newest first, 100 at a time with a cursor). Only Owners can; the platform cannot read it for them. [GAP: no operator tool to read a company's audit log (G24).] Useful actions: `LOCATION_HISTORY_VIEWED`, `LOCATION_HISTORY_EXPORTED`, `EXPORT_REQUESTED`, `EXPORT_DOWNLOADED`, `ATTACHMENT_ORIGINAL_DOWNLOADED`, `MEMBER_*`, `DEVICE_*`, `SOS_VIEWED`, `PLATFORM_ACCESS`.
5. Look at our own side: AWS CloudTrail (every AWS action in the account; kept 365 days in a private bucket with file validation on), and the API log (30 days, which very likely holds client IP addresses).

Source: `apps/api/src/routes/audit-logs.ts`, `monitoring.tf`, `services.tf`, `docs/SECURITY_AND_INVARIANTS.md §17`, `docs/legal/README.md` finding 8.

## Decide

| Case                                                      | Do                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Another company's data is visible** (isolation failure) | Highest severity. Phone the owner (`<owner>`) and an engineer now. Preserve evidence. Contain (below, last resort). Do not try to reproduce it on production. |
| Dashboard account stolen or misused                       | The company's Owner or Administrator disables the member (Members page). Read their Audit Log for what that account did.                                      |
| Guard phone lost or stolen                                | Owner or Administrator revokes the device (Guards page › Revoke). Its sessions end at once; later uploads are refused.                                        |
| Secret or key leaked                                      | Runbook 05 for that secret, then read the logs for misuse.                                                                                                    |
| Our own operator access questioned                        | Every look is a `PLATFORM_ACCESS` row with a reason (break-glass, SEC §4.6): the company can show it.                                                         |
| GuardDuty finding                                         | Read it, open CloudTrail for the same time, ask an engineer.                                                                                                  |

## Containment tools that exist

| Tool                                                            | Who                                                                              | Effect                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revoke a device                                                 | Owner, Administrator (`devices.revoke`)                                          | Phone's sessions end at once (`POST /devices/:id/revoke`)                                                                                                                                                                                                                                                                                                                                |
| Terminate or suspend a guard                                    | Owner, Administrator                                                             | Terminate ends sessions, retires the phone, ends shifts. Suspend: refused on the next request, except an SOS from the guard's phone, which is accepted and marked "guard account disabled" (owner decision Q1); to stop that too, revoke the phone (if the phone is in the wrong hands, revoke it as LOST or COMPROMISED)                                                                |
| Disable a member                                                | Owner, Administrator (Owners and Administrators can be changed only by an Owner) | Refused on the next request; live stream closed within about a minute                                                                                                                                                                                                                                                                                                                    |
| Cancel a staff invitation                                       | Owner, Administrator (`members.manage`)                                          | The link stops working                                                                                                                                                                                                                                                                                                                                                                   |
| Cancel a guard's enrollment code                                | Supervisor and above (`devices.enroll`)                                          | Issuing a new code cancels earlier unused ones                                                                                                                                                                                                                                                                                                                                           |
| Revoke an app version                                           | Operator (runbook 09)                                                            | Stops that build everywhere, **including its SOS**                                                                                                                                                                                                                                                                                                                                       |
| Rotate secrets                                                  | Operator (runbook 05)                                                            | See that runbook                                                                                                                                                                                                                                                                                                                                                                         |
| Stop the whole service                                          | Operator: `api_desired_count = 0` in the tfvars, apply                           | Ends dashboard and sync **and SOS**. Last resort; the owner decides                                                                                                                                                                                                                                                                                                                      |
| Suspend the organization (`organizations.status = 'SUSPENDED'`) | **No command or screen.** [GAP: SQL only; no operator command exists (G23).]     | If set: every dashboard route and every guard route except the SOS routes answers 403 `ORG_SUSPENDED`; SOS is still accepted and stored (INV-15); phones keep their queue. Does **not** stop the worker's alerts and notifications for it (the sweeps do not read the status; not tested), and must not be set on a company with active shifts without explicit confirmation (PROD §4.1) |

There is no "sign out everyone" (G15) and no tool to disable a dashboard user in every company.

Source: `apps/api/src/context.ts`, `routes/members.ts`, `routes/enrollment.ts`, `routes/guards.ts`, `packages/contracts/src/permissions.ts`, `repositories/sweeps.ts`.

## Preserve evidence

| Evidence                                 | Where                                                    | Kept                                                          | How to keep it longer                                                                                                                                                                                                            |
| ---------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service logs (api, worker, web, dbadmin) | CloudWatch `/sentryops-<env>/<service>`                  | 30 days                                                       | Save to a file now; store it access-controlled, outside the repo                                                                                                                                                                 |
| Database                                 | RDS backups                                              | 35 days production, 1 day `test`                              | A manual snapshot (standard AWS command, no repo script)                                                                                                                                                                         |
| AWS actions                              | CloudTrail bucket `sentryops-<env>-cloudtrail-<account>` | 365 days                                                      | Already there; do not delete versions                                                                                                                                                                                            |
| Audit trail                              | `audit_logs` table                                       | 24 months                                                     | The company's Owner can export or screenshot                                                                                                                                                                                     |
| Photos and exports                       | Private bucket, versioned                                | By retention; older versions 35 days production, 1 day `test` | A deleted or overwritten photo can be restored while its older version lasts: `aws s3api list-object-versions --bucket <bucket> --prefix org/<organization id>/`, then copy the version back. Nothing alarms on a deletion (G10) |

```bash
aws logs tail /sentryops-<env>/api --region <region> --since 168h --format short > <a private folder outside the repository>/incident-api-log.txt
```

The file holds organization IDs, device IDs, request paths and the connecting address of every request: never save it inside the repository (it is public). Tried on `test` 2026-11-08: 7 days (about 1,500 lines) took 12 seconds.

```bash
aws rds create-db-snapshot --region <region> --db-instance-identifier sentryops-<env> --db-snapshot-identifier incident-<date>
```

Tried on `test` 2026-11-08: the Free plan accepted it, it was `available` in under 15 minutes (the database was small), and `aws rds delete-db-snapshot --region <region> --db-snapshot-identifier incident-<date>` removed it. A snapshot costs storage money and holds all companies' data: ask the owner, restrict who can see it, delete it when the case closes. [GAP: no evidence-freeze script and no legal hold; the nightly retention run keeps deleting aged data during an investigation (G25). By hand: copy or snapshot before data ages out.]

## Fix

1. Contain with the narrowest tool that works (table above). Write down each action and its time.
2. Preserve (above) before you change anything that would overwrite evidence.
3. Establish facts: what data, which companies, how many guards, which period, who or what accessed it. Use the Audit Logs, CloudTrail and the API log.
4. Fix the cause (key rotation, a code fix, a removed account). A code fix goes through the normal release path with a test that fails first.
5. Tell people (below).

## Confirm it is fixed

- The access path is closed (a re-test by an engineer, or the account disabled, the phone revoked, the key replaced).
- No new suspicious Audit Log or CloudTrail entries for 24 hours.
- Affected companies confirm what they see.

## Tell

| Who                                           | What                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The owner (`<owner>`)                         | At once, by phone, then in writing.                                                                                                                                                                                                                                                              |
| The affected company's owner or administrator | By phone first, then in writing. Say what happened, which data and roughly how many people, likely effects, what we are doing (`docs/legal/DATA_PROCESSING_AGREEMENT.md §9.2`). The company, as controller, decides whether to tell regulators and guards (§9.3). Do not say more than you know. |
| Guards                                        | Only through their company.                                                                                                                                                                                                                                                                      |
| Regulators, other customers, the public       | Do not contact. Wait for the lawyer.                                                                                                                                                                                                                                                             |
| Deadlines                                     | **[LAWYER: the notice period to customers (§9.1 is blank: `[NUMBER OF HOURS]`); our own duty to notify a regulator or dashboard users as controller of sign-in data; notice duties by country.]** Do not state any deadline as fact.                                                             |

Source: `docs/legal/DATA_PROCESSING_AGREEMENT.md §9`, `docs/legal/PRIVACY_POLICY.md §2, §10`, `docs/legal/README.md §5` question 7.

## Afterwards

Write the timeline, the cause, the data affected, the fix and the follow-ups in the private log. Add a regression test for any code cause. Review this runbook and the gaps below. Consider an extra audit pass (the Fable audit, `docs/FABLE_LAUNCH_AUDIT.md`).

## Status

Tried on the test environment, 2026-11-08: only the log copy and the manual snapshot (with its deletion), as noted where they appear. **Not tried:** every containment step (suspending an organization, signing people out, disabling a device or member), reading an Audit Log, and the CloudTrail and GuardDuty steps (GuardDuty is production only). Containment by command does not exist yet (G15, G23).

Known gaps: G04, G10, G15, G23 (no way to suspend an organization), G24 (no operator audit-log reader), G25 (no evidence freeze or legal hold). Fact: `SEC §4.6` says break-glass access is "a procedure, not tooling" (D-19); the three Phase 10 commands (`delivery-health`, `quarantine-list`, `quarantine-replay`) are the only tooling.
