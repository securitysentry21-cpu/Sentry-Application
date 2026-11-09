# Runbook 04: Mass device offline

> Setup: `docs/RUNBOOKS/README.md` › Before you start. Note: the `test` environment is kept **paused** (`paused = true` in `infra/terraform/env/test.tfvars`): no service runs and the database is stopped. Phones cannot connect to it. That is expected, not an incident.

## When to use

- Alarms `sentryops-<env>-api-unhealthy` (no healthy API task for 2 minutes) or `api-error-rate` (more than 2% of requests ended in a server error for 15 minutes).
- Many guards turn OFFLINE on the live map at once, or many `DEVICE_OFFLINE` alerts open together (a guard with no contact for 10 minutes).
- A company calls: "all our guards show offline."

Source: `operations.tf`, `docs/PRODUCT_SPEC.md §8.3, §12`.

## First five minutes

1. From your laptop, is the front door up? Three checks, as in `smoke.sh`. Use the dashboard address from Terraform.

```bash
infra/scripts/tf.sh <env> output -raw dashboard_url
```

```bash
curl -s -o /dev/null -w '%{http_code}' <dashboard_url>/api/v1/health
```

```bash
curl -s -o /dev/null -w '%{http_code}' <dashboard_url>/api/v1/ready
```

`health` 200 means the API process is alive. `ready` 200 means the database answers and the schema is current; 503 means database trouble.

2. Are the services and the database up?

```bash
aws ecs describe-services --region <region> --cluster sentryops-<env> --services api worker web --query 'services[].[serviceName,runningCount,desiredCount]' --output text
```

```bash
aws rds describe-db-instances --region <region> --db-instance-identifier sentryops-<env> --query 'DBInstances[0].DBInstanceStatus' --output text
```

3. What does the API say? Look for errors, `429` and `5xx`.

```bash
aws logs tail /sentryops-<env>/api --region <region> --since 30m --format short
```

Source: `infra/scripts/smoke.sh`, `apps/api/src/routes/health.ts`, `edge.tf` (load-balancer health check on `/api/v1/health`).

## Decide

| You see                                                             | It means                                                                                                                        | Do                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `runningCount` 0 for `api`, or `health` not 200                     | API down                                                                                                                        | Fix 1                                                                           |
| `health` 200, `ready` 503                                           | Database trouble                                                                                                                | Runbook 03                                                                      |
| Both 200, many 5xx in the API log, started after a release          | Bad release                                                                                                                     | Fix 2                                                                           |
| Both 200, many `429` in the API log                                 | Reconnection storm or one misbehaving phone (limit: 120 sync requests per device per minute)                                    | Wait; phones back off by themselves. One device hammering = app bug, runbook 09 |
| Both 200, guards offline only in one area or on one mobile operator | Mobile network or internet outage outside our system                                                                            | Nothing to fix. Tell customers                                                  |
| Production only: both 200 but one operator's guards blocked         | The web firewall (WAF) may be blocking a shared address range (rules `aws-ip-reputation`, `aws-common`, `aws-known-bad-inputs`) | Look at the WAF's sampled requests in the AWS console; ask an engineer          |
| Environment paused                                                  | By design                                                                                                                       | Switching on costs money: ask the owner                                         |

## What phones and the dashboard do meanwhile

| Part                     | Behaviour                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone, tracking          | Keeps recording locations and status on the phone while a shift runs, with no server needed.                                                                                                                                                      |
| Phone, upload            | Retries with growing delays (5 s up to 5 minutes, random jitter) and obeys `Retry-After` from a 429. Success only counts when the server answers.                                                                                                 |
| Phone, queue             | Keeps data up to 168 hours (`sync.max_offline_age_hours`; older items are rejected `TIMESTAMP_TOO_OLD`). Above 20,000 queued locations the oldest are thinned to one per minute. SOS, shift start and end, scans and incidents are never dropped. |
| Phone, failsafe          | Tracking stops by itself at the scheduled end plus 60 minutes (`shift.auto_end_after_minutes`), even with no contact. The server auto-ends the shift at the same moment.                                                                          |
| Phone, SOS               | An unsent SOS shows "Call supervisor" after 15 s.                                                                                                                                                                                                 |
| Dashboard                | Tracking health goes LIVE, then DELAYED (over 90 s), then OFFLINE (over 5 minutes). A `DEVICE_OFFLINE` alert (MEDIUM) opens after 10 minutes per guard. The last known location is never shown as live.                                           |
| After the server returns | Each phone sends batches of up to 500 items, one batch at a time. Late points that reveal a past excursion are recorded as "detected after sync", not as live alerts. Offline alerts resolve when contact resumes.                                |

Source: `docs/ARCHITECTURE.md §8.4–§8.8, §9.5`, `apps/mobile/src/core/sync/backoff.ts`, `apps/api/src/rate-limit.ts`.

## Fix

1. **API down.** Check the API log for the reason first. Then redeploy (no script, G01), and wait:

```bash
aws ecs update-service --region <region> --cluster sentryops-<env> --service api --force-new-deployment
```

```bash
aws ecs wait services-stable --region <region> --cluster sentryops-<env> --services api
```

2. **Bad release.** A deployment that fails its health checks rolls back by itself. If it passed them but the errors began with it, release the last good commit (check no migration was added in between; not rehearsed):

```bash
infra/scripts/release.sh <env> <last good commit>
```

3. **More capacity.** One API task runs by default (`api_desired_count = 1`, `variables.tf`). More tasks cost money: ask the owner, then set `api_desired_count` in the tfvars, run `infra/scripts/tf.sh <env> plan -out=capacity.tfplan`, read it (only the `api` service should change), and `infra/scripts/tf.sh <env> apply-plan capacity.tfplan`.
4. After recovery, watch the API log for `429` and `5xx` for 15 minutes. A reconnection storm drains by itself because of the jittered delays.

## Confirm it is fixed

- `health` and `ready` both 200; `infra/scripts/smoke.sh <env>` prints "smoke test passed".
- `api-unhealthy` and `api-error-rate` e-mails say OK.
- On the dashboard, guards return to LIVE and the `DEVICE_OFFLINE` alerts resolve. Data from the outage appears after upload.
- No growing `429` or `5xx` lines in the API log.

## Tell

| Who                            | What                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner (`<owner>`)          | Cause if known, start and end times, whether any real SOS was in the window.                                                                                   |
| Company owner or administrator | By phone: "Guard phones keep recording and will upload when the server is back. Offline does not mean a guard left. Phone guards on important posts directly." |
| Guards                         | Through the company: keep the app installed, do not sign out or force-close it, data is kept up to 7 days.                                                     |
| Legal                          | None for an outage alone. If a real SOS could not be sent, runbook 01 › Tell.                                                                                  |

## Afterwards

Write down: start, end, alarm times, cause, number of guards affected, any data rejected as too old. If the cause was capacity, ask the owner about `api_desired_count` and the database size (`variables.tf`).

## Status

Tried on the test environment, 2026-11-08: the health and ready checks (200), the service counts, the database status, the API log tail, and Fix 1 (`update-service --force-new-deployment` on `api`, then `wait services-stable`). The restart took about 3 minutes, and `/api/v1/health` answered 200 at every check (every 10 to 20 seconds) throughout, because the new task starts before the old one stops (minimum healthy 100%, maximum 200%). **Not tried:** a real outage, a bad release and rollback (Fix 2), and the alarms firing. The reconnection storm has been simulated only on one computer by the load harness (`pnpm load`, `docs/testing/load-baseline.md`), never against AWS, so the real behaviour of the cell under a storm is unmeasured.

Known gaps: G01; G05 (nothing can message customers or guards; "tell" is a phone call); G13 (no platform alarm for "many guards offline at once"; per-guard alerts only, which also floods the control room). `docs/ARCHITECTURE.md §9.5` and `SEC §9` say "60 per minute sustained, burst 120"; the code uses a fixed 120 per minute per device.
