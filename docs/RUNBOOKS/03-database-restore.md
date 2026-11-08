# Runbook 03: Database restore

> **Read this first.** The drill (`restore-drill.sh`) is scripted and has passed once on `test`. A **real** restore, where the services start using the restored copy, is **not scripted and has never been tried**. Steps are marked `[scripted]` or `[manual, never tried]`. Rehearse the manual part on `test` before production exists.
> Targets: data loss at most 15 minutes (RPO), back in service within 4 hours (RTO). Source: `docs/ARCHITECTURE.md §19.6`.
> Setup: `docs/RUNBOOKS/README.md` › Before you start.

## When to use

- The database is gone, corrupt or unreachable and `/api/v1/ready` answers 503.
- Someone deleted or damaged data (a bad migration, a mistake) and the database itself is healthy.
- Alarms `sentryops-<env>-db-cpu` (only if it does not settle), `db-storage` (usually a disk resize, see Decide), `api-unhealthy`.
- The Frankfurt region is lost (see Case C).

## What the drill proves, and what it does not

| `restore-drill.sh <env>` does [scripted]                                                                                                                 | Proof                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Restores the database at its latest restorable time into a new private instance, same network, security group, parameters, certificate authority and key | Backups restore into an encrypted private copy |
| Runs `packages/db/scripts/restore-check.ts`: every migration, the schema linter, the four runtime roles, rows in every table                             | The copy has every security mechanism in place |
| Deletes the copy and prints the restore point and times against RPO and RTO                                                                              | Timing: see below                              |

Passed once: 2026-11-02 on `test` (Sydney). Restore point 6 minutes before the drill began. The copy accepted connections after about 9 minutes, RDS reported "available" after 26 minutes, and the check finished after 28 minutes 29 seconds (`docs/testing/restore-drills.md`).

It does **not** prove: restore time with real data (test holds almost nothing); switching the services to a restored copy; the Ireland backup copy (test has none); anything on production (does not exist yet).

Source: `infra/scripts/restore-drill.sh`, `packages/db/scripts/restore-check.ts`.

## First five minutes

1. Is it really down, or only paused? The `test` environment is kept paused on purpose, and RDS restarts a stopped database by itself after 7 days.

```bash
aws rds describe-db-instances --region <region> --db-instance-identifier sentryops-<env> --query 'DBInstances[0].DBInstanceStatus' --output text
```

2. What can be restored? The latest restorable time must be within about 15 minutes of now.

```bash
aws rds describe-db-instances --region <region> --db-instance-identifier sentryops-<env> --query 'DBInstances[0].LatestRestorableTime' --output text
```

3. Does the API see the database?

```bash
curl -s -o /dev/null -w '%{http_code}' "$(infra/scripts/tf.sh <env> output -raw dashboard_url)/api/v1/ready"
```

## Decide

| You see                                                                    | Do                                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status `stopped` and `paused = true` in `infra/terraform/env/<env>.tfvars` | Not an incident. Switching on costs money: ask the owner first.                                                                                              |
| Status `available`, `/ready` 503                                           | Not a restore. Read the API log (runbook 04).                                                                                                                |
| `db-storage` alarm                                                         | Raise `db_allocated_storage_gb` in the tfvars and apply (`variables.tf`). Storage can also grow by itself up to 5 times when `db_storage_autoscaling` is on. |
| Data damaged, database healthy                                             | Case B                                                                                                                                                       |
| Database lost or corrupt                                                   | Case A                                                                                                                                                       |
| Frankfurt unavailable                                                      | Case C                                                                                                                                                       |

## Case A: restore and switch over (database lost or corrupt)

1. Tell people first (Tell section). Pick the restore time `<T>` (UTC): the latest restorable time, or just before the damage.
2. **Rehearse the backup** [scripted]. This proves the backup is good and gives a time. It does not switch anything.

```bash
infra/scripts/restore-drill.sh <env>
```

3. **Restore for real** [manual, never tried]. Use the `restore-db-instance-to-point-in-time` call in `restore-drill.sh` as the template, with these changes: target name `sentryops-<env>-restored`, `--restore-time <T>` instead of `--use-latest-restorable-time`, and replace `--no-multi-az --no-deletion-protection` with `--multi-az --deletion-protection` (production). The script reads the other values (instance class, subnet group, security groups, parameter group, certificate authority) from the live instance. Wait until it is available:

```bash
aws rds wait db-instance-available --region <region> --db-instance-identifier sentryops-<env>-restored
```

4. **Check the copy** [scripted, but only inside `restore-drill.sh`]. [GAP: the check cannot be run on its own against your restored copy, only through the drill script (G09). By hand: run the drill, which checks a fresh copy from the same backups.]
5. **Switch over** [manual, never tried]. The services reach the database by its address, which contains the instance name. Renaming keeps the address, so no secret changes. Rename the broken instance, then the copy:

```bash
aws rds modify-db-instance --region <region> --db-instance-identifier sentryops-<env> --new-db-instance-identifier sentryops-<env>-old --apply-immediately
```

```bash
aws rds modify-db-instance --region <region> --db-instance-identifier sentryops-<env>-restored --new-db-instance-identifier sentryops-<env> --apply-immediately
```

6. Make the services reconnect (runbook 01, Fix 1, for `api` and `worker`; G01), then run the post-release checks [scripted]:

```bash
infra/scripts/smoke.sh <env>
```

7. **Terraform no longer matches reality.** Run `infra/scripts/tf.sh <env> plan` and read it. Do not apply a plan that replaces or destroys the database. Two things must be re-established by hand: the standby and deletion protection if step 3 did not set them, and the Ireland backup copy (`aws_db_instance_automated_backups_replication` follows the old instance). [GAP: the Terraform side of a switch-over is not worked out (G08).]
8. Keep the old instance until the owner agrees. Do not delete it in a hurry.

## Case B: damaged data, database healthy [manual]

Restore a copy at a time just before the damage as in Case A steps 2 to 3, but do **not** rename it. Then the damaged rows must be read from the copy and written back by an engineer. [GAP: there is no tool to query a restored copy; the only door into the private network is a one-off task (G09).] Delete the copy afterwards; it costs what the database costs.

## Case C: the region is lost [not scripted, never tried]

Production will copy RDS automated backups to eu-west-1 (`database.tf`, `backup_copy_enabled`, with its own key). A new cell would be built from the same Terraform in that region (`region` variable). Expect more than 4 hours. Not covered anywhere: incident photos and exports are **not** replicated or versioned (`attachments.tf`), the Cognito user pool is regional, and a person signing in through a new pool is not re-linked to their existing account (`apps/api/src/routes/auth.ts`). [GAP: no second-region plan beyond the backup copy (G10, G11).]

## Confirm it is fixed

- `/api/v1/ready` answers 200 and `smoke.sh <env>` prints "smoke test passed".
- The dashboard loads, a guard's live state appears, the newest audit entry is as recent as the restore time.
- Compare against the targets: data lost (now minus restore time) at most 15 minutes; total time at most 4 hours.
- Ask each company to look for anything missing from their last minutes (data after `<T>` is gone).

## Tell

| Who                            | What                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner (`<owner>`)          | Immediately. Restore time chosen, expected data loss, expected time.                                                                                           |
| Company owner or administrator | By phone: "We are restoring the database. Changes made after `<T>` UTC will be lost. Phones keep recording and will upload again."                             |
| Guards                         | Through the company. Phones keep their queue (up to 7 days).                                                                                                   |
| Legal                          | Lost customer data is a notice question: `docs/legal/DATA_PROCESSING_AGREEMENT.md §9`. [LAWYER: whether and when data loss without exposure must be notified.] |

## Afterwards

Record: damage time, restore time, data loss, RTO reached, what had to be done by hand. Add the drill result to `docs/testing/restore-drills.md`. Fix the Terraform mismatch before the next release. Repeat the drill every quarter and on production before the first real guard.

## Status

Tried on the test environment: the **drill** passed 2026-11-02 (`docs/testing/restore-drills.md`). The switch-over, Case B and Case C: not yet.

Known gaps: G01, G08 (switch-over not scripted), G09 (no way to query a copy), G10 (photos not replicated), G11 (second-region rebuild untried), G12 (no restore timing with real data; no production drill yet). `test` keeps only 1 day of backups (`test.tfvars`), so a test restore can go back only a day.
