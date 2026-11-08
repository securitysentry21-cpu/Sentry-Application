# Runbook 06: Replaying quarantined sync items

> Setup: `docs/RUNBOOKS/README.md` › Before you start. Every command below looks into one organization. It needs a **reason** and writes a `PLATFORM_ACCESS` row to that organization's Audit Log, shown as "Platform operator". The organization's owner can read your reason. Write it as a fact (for example "replay after sync bug, ticket 12"), 200 characters at most, no personal data.

## What quarantine is

When a guard phone uploads a batch and one item hits an unexpected error on the server, the server keeps that one item in the `quarantined_items` table and carries on with the rest of the batch. The item's result is `QUARANTINED`. The phone treats that as accepted and **deletes its own copy**. So the quarantine row is the **only copy** of that item (a shift start, a location, an incident, a scan).

- Later items of a shift whose start is quarantined are answered `RETRY` (kept on the phone) until the start is replayed.
- Quarantined items are deleted 30 days after they were created (`QUARANTINE_DAYS`), or sooner if `retention.location_days` is smaller. Do not wait.
- The error code stored is always `INTERNAL_ERROR`. The real error is **not** recorded anywhere. [GAP: the cause of a quarantine is lost; log the error's class name (no content) at the moment of quarantine (G18).]

Source: `docs/ARCHITECTURE.md §9.3`, `apps/api/src/services/sync.ts`, `packages/domain/src/retention.ts`.

## When to use

- A guard says they started or ended a shift, scanned a checkpoint or filed an incident, but the dashboard does not show it.
- A shift stays SCHEDULED or ACTIVE after the guard ended it.
- Routine check: list quarantined items for each organization weekly.
- **No alarm points here.** `docs/ARCHITECTURE.md §9.3` and `§16.2` promise one ("the operator is paged"); it does not exist. [GAP: no quarantine monitor or alarm (G17).]

## First five minutes

1. Get the organization's ID `<org>` (G02): from your register, or the company's owner opens `<dashboard>/api/v1/me` while signed in and reads `organizationId`.
2. List open items. This prints IDs, types, ages and device IDs only; never content, coordinates or phone numbers.

```bash
infra/scripts/operator.sh <env> quarantine-list --org <org> --reason "<why>" | tr '\t' '\n'
```

Each line: item ID, item type, error code, age in minutes, device ID. `No quarantined items.` means none open. Add `--all` to include items already replayed. `--limit` defaults to 50 (maximum 500).

Source: `apps/api/src/cli/operator.ts`, `operator-args.ts`, `services/operator.ts`.

## Decide

| You see                                                                            | Do                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A few items, different types, ages under a few days                                | Replay all (Fix 2).                                                                   |
| Many items of one type, all recent                                                 | Probably a bug. Tell an engineer. Replaying before a fix only quarantines them again. |
| Items older than 20 days                                                           | Replay now, before they are deleted at 30 days.                                       |
| Items from a phone the company revoked as lost, compromised or by an administrator | They will be `SKIPPED` on purpose (below).                                            |

## Fix

1. Try the oldest item alone (usually a `SHIFT_START`):

```bash
infra/scripts/operator.sh <env> quarantine-replay --org <org> --reason "<why>" --id <item id> | tr '\t' '\n'
```

2. Replay everything open, oldest first, so a start goes in before its end:

```bash
infra/scripts/operator.sh <env> quarantine-replay --org <org> --reason "<why>" | tr '\t' '\n'
```

Each line is: item ID, type, result, detail. Replay is safe to repeat: the pipeline is idempotent per phone and event ID (INV-06), so an item the phone already got through comes back `DUPLICATE`.

| Result                                                         | Meaning                                                                                                                                        | Do                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `REPLAYED` + detail `ACCEPTED`                                 | Run through the normal pipeline as that phone; stored.                                                                                         | Nothing.                                       |
| `REPLAYED` + detail `DUPLICATE`                                | Already stored.                                                                                                                                | Nothing.                                       |
| `REPLAYED` + detail `REJECTED <code>`                          | The normal rules judged it and refused it for good (for example `OUTSIDE_SHIFT_WINDOW`, `TIMESTAMP_TOO_OLD`). It is closed and **not stored**. | Nothing to do. Tell the company if it matters. |
| `WAITING`                                                      | Its shift's start is still in quarantine. Not marked replayed.                                                                                 | Run the replay again.                          |
| `STILL_FAILING` (detail `QUARANTINED`)                         | Failed again with an unexpected error. The old row is closed and a **new** open row was made.                                                  | A bug. See below.                              |
| `SKIPPED` "the phone no longer exists"                         | Nothing to attribute it to.                                                                                                                    | Leave it.                                      |
| `SKIPPED` "the phone was revoked (LOST / COMPROMISED / ADMIN)" | Data from a lost, compromised or administrator-revoked phone is not trusted after revocation. Deliberate (ADV-A08).                            | Never force it. Tell the company.              |

A phone that was REPLACED by a new one is replayed, but only for data captured before the replacement.

The command exits with code 1 if any item is `STILL_FAILING`, but `operator.sh` does not pass that on and prints the lines tab-separated. Read the result words. [GAP: exit code and line breaks (G19).]

3. Run the list again (without `--all`). Items still open are `WAITING` or the new rows of `STILL_FAILING`. Repeat step 2 until only `STILL_FAILING` remains.
4. **`STILL_FAILING` is a bug.** Collect only: the item **type**, the count, the code `INTERNAL_ERROR`, the app version (Guards page › the guard's devices), the time. Never the content. Open a repository issue with those and no organization or guard names (the repository is public). Do not delete anything. The new rows stay available for the engineer to replay after the fix, within the 30 days.

## Confirm it is fixed

- `quarantine-list` prints `No quarantined items.` (or only the known `STILL_FAILING` rows).
- The dashboard now shows the guard's shift started or ended, the scan or the incident. Ask the company's administrator to look.
- The organization's Audit Log shows your `PLATFORM_ACCESS` rows with your reason.

## Tell

| Who                            | What                                                                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner (`<owner>`)          | How many items, which types, outcomes.                                                                                                                                                                                                 |
| Company owner or administrator | "We found some of your guards' records that had not been saved because of a fault on our side, and replayed them. Records the system refused (for example from a phone you removed) were not added." Their Audit Log shows our access. |
| Guards                         | Nothing, unless their shift record changed: the company tells them.                                                                                                                                                                    |
| Legal                          | The company is told by the audit entry. No separate notice is planned in the specs. [LAWYER: confirm that operator access of this kind needs no further notice under the customer agreement.]                                          |

## Afterwards

Write down: organization ID, item count by type, results, the issue number. After the fix is released, replay the leftover rows and confirm. Add the missing alarm (G17) and the cause logging (G18) to the plan.

## Status

Tried on the test environment: not yet. The commands are covered by automated tests on a local database only (`apps/api/test/operator.test.ts`: replay as the item's own phone, repeat safety, ordering, revoked and replaced phones, tenant isolation, audit rows).

Known gaps: G02, G17, G18, G19.
