# Runbook 01: SOS notifications failing

> **Today:** SOS is OFF for pilot guards (`FEATURE_SOS` is fixed to `false` in `infra/terraform/cell/services.tf`; the app hides the button). No SMS provider exists yet (EXT-10) and the guard app does not register for pushes yet. Use this runbook for the canary, for test alerts, and for the day SOS goes live.
> Setup (sign-in, `<env>`, `<region>`): `docs/RUNBOOKS/README.md` › Before you start.

## When to use

- Alarm e-mails whose name starts `sentryops-<env>-`: `sos-pipeline-error`, `sos-unacknowledged`, `worker-silent`, `job-lag`, `canary-failed`, `canary-silent`. Also `notification-provider-failure` (then read runbook 02 too).
- A customer says an SOS or a test alert did not ring or arrive.
- The SOS page says "Alert sent" but never "Notified". "Sent" means a provider accepted it. "Notified" needs a screen or a phone to confirm (INV-10).

Source: `notifications.tf`, `operations.tf`, `apps/web/app/(app)/sos/[id]/page.tsx`.

## First five minutes

1. **If a real SOS is open now, phone the organization's control room first.** Say: "An SOS is open and our alerts may not be reaching you. Open the SENTRY SOS page and call the guard." Diagnose after. [GAP: there is no contact list for control rooms. Keep a private sheet outside the repo with each company's control-room number (G04).]
2. Is the worker running? It sends every alert. `runningCount` must equal `desiredCount`.

```bash
aws ecs describe-services --region <region> --cluster sentryops-<env> --services api worker web --query 'services[].[serviceName,runningCount,desiredCount]' --output text
```

3. Read the worker's last 30 minutes. Look for the lines in the table below.

```bash
aws logs tail /sentryops-<env>/worker --region <region> --since 30m --format short
```

4. Ask for the organization's delivery health. `<org>` is its ID (G02). The reason is shown to the customer in their Audit Log.

```bash
infra/scripts/operator.sh <env> delivery-health --org <org> --reason "SOS alarm check" --hours 2 | tr '\t' '\n'
```

It takes about two minutes (it starts a one-off task). It prints deliveries by channel, status and error code, the oldest queued delivery, open real SOS with "alert sent / shown to a person", and `CONCERN:` lines. Without `| tr '\t' '\n'` all lines arrive as one (G19). Tried on `test` (2026-11-08): it printed "No deliveries in this period", "Nothing is waiting in the queue", "Open SOS (not drills): 0" and "No concerns found."

**Finding `<org>` today (G02):** every nightly `retention run` line in the worker log carries an `organizationId`, one line per organization: `aws logs tail /sentryops-<env>/worker --region <region> --since 24h --format short | grep "retention run"`. IDs are safe to write down.

Source: `infra/scripts/operator.sh`, `apps/api/src/services/operator.ts`.

## The pipeline, in order

| Step | What happens                                                                                                     | Where it logs (worker unless stated)                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | Phone sends `POST /api/v1/sos`; the API stores it and answers RECEIVED                                           | API log; alarms `api-unhealthy`, `api-error-rate` (runbook 04)                                                          |
| 2    | Same transaction: alert opened, first deliveries QUEUED, outbox rows written                                     | API log                                                                                                                 |
| 3    | Outbox dispatcher (every 0.5 s) moves outbox rows to dashboards                                                  | `outbox dispatcher failed`                                                                                              |
| 4    | Escalation (every 15 s) queues the next ladder step                                                              | `alerts escalated`; `sos pipeline error: escalation failed`                                                             |
| 5    | Sender (every 1 s) calls the provider, one message at a time                                                     | `notification run` {sent, failed}; `notification provider failure` {channel, code}; `sos pipeline error: sender failed` |
| 6    | Provider accepts: delivery SENT, SOS becomes ALERT_SENT                                                          | no line                                                                                                                 |
| 7    | A dashboard shows the alarm (`/alerts/:id/seen`) or a browser shows the push (`/alerts/:id/delivered`): NOTIFIED | none                                                                                                                    |

Watchdog lines: `worker heartbeat` every 30 s ({maxJobLagSeconds, laggingJob}); `sos unacknowledged` every minute while a real SOS has waited 10 minutes ({organizations: count only}, G03); `canary ok` / `canary failed` {step: SEND, ALERT, REALTIME, PUSH or RESOLVE}.

Source: `apps/api/src/worker.ts`, `workers/notifications.ts`, `services/notifications.ts`, `workers/canary.ts`.

## Decide

| You see                                                          | It means                                                 | Do                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| `runningCount` 0, or no `worker heartbeat` for 5 min             | Worker down or stuck                                     | Fix 1                              |
| Heartbeat present, `maxJobLagSeconds` rising, `laggingJob` named | One loop is stuck                                        | Fix 1, then read that loop's error |
| `notification provider failure` lines                            | Provider or credentials                                  | Runbook 02                         |
| Oldest queued delivery older than 2 min, worker healthy          | Provider answering slowly (10 s per call, one at a time) | Runbook 02                         |
| Deliveries SENT, SOS never NOTIFIED                              | Providers accept, nobody's screen or phone showed it     | Fix 2                              |
| SOS open, no deliveries at all                                   | Ladder or recipients missing                             | Fix 3                              |
| `canary failed` step SEND / ALERT / REALTIME / PUSH              | API or public address / database / dispatcher / provider | Runbook 04 / 03 / Fix 1 / 02       |

## Fix

**Fix 1: restart the worker.** No script does it (G01); this is the standard AWS command.

```bash
aws ecs update-service --region <region> --cluster sentryops-<env> --service worker --force-new-deployment
```

```bash
aws ecs wait services-stable --region <region> --cluster sentryops-<env> --services worker
```

If the heartbeat stops again, do not restart in a loop. Read the last error lines. A release that passes health checks but misbehaves: `infra/scripts/release.sh <env> <last good commit>` (check no migration was added in between; not rehearsed). A release that fails health checks rolls back by itself (`services.tf`).

**Fix 2: nobody sees it.** Ask the control room: is anyone signed in (the dashboard home shows monitoring coverage)? Is the alarm sound enabled? Ask each duty officer to press "Send me a test SOS alert" (Settings › Notifications) and to enable notifications again if it does not arrive. SMS fails with `SMS_NOT_CONFIGURED` until EXT-10 is done.

**Fix 3: no deliveries.** The ladder sends to members with a web-push subscription or an SOS phone number (Members page). An organization with neither gets only the dashboard alarm. Tell the owner to fix that; it is a setup problem, not an outage.

**When everything is down**, the control room is told by phone (step 1). The guard's own phone shows "Call supervisor" after 15 s unsent and dials the organization's `sos.emergency_call_number` (Settings). Check on every onboarding that it is set and that a person always answers it.

Source: `PROD §11.5, §11.7`, `apps/api/src/routes/mobile.ts`, `routes/notifications.ts`.

## Confirm it is fixed

- Worker log shows `worker heartbeat` with `maxJobLagSeconds` 0 (or small) and `notification run` lines with `failed` 0.
- `delivery-health` says "Nothing is waiting in the queue." and "No concerns found."
- A duty officer's test alert arrives and is shown.
- The alarm e-mails return to OK. Production only: `canary ok` every 5 minutes.

## Tell

| Who                                  | What                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The owner (`<owner>`)                | Now, plain facts: when it started, whether a real SOS was affected, what you did.                                                                                                                                                                      |
| The company's owner or administrator | By phone. "SOS alerts may have been delayed from `<time>` to `<time>`. Keep a person on the SOS page and keep phones reachable." Then confirm when fixed.                                                                                              |
| Guards                               | Through the company's control room, not directly. Guards who see "waiting" should use Call supervisor.                                                                                                                                                 |
| Legal / customer notice              | If a real SOS was missed or late, write it down and tell that customer. The terms say SOS is not an emergency service (`docs/legal/TERMS_OF_SERVICE.md`). [LAWYER: whether a missed or late SOS creates a duty to notify the customer or anyone else.] |

## Afterwards

- In a private log outside the repo: first alarm time, first human action, fixed time, organization IDs, SOS IDs, which step failed, which fix worked.
- A code bug: open a repository issue with log message names and error codes only. The repository is public: no customer or guard names.

## Status

Tried on the test environment, 2026-11-08, on release bb6a9ad: steps 2 to 4 of "First five minutes" (service counts, the worker log with its `worker heartbeat` lines, `delivery-health`) and Fix 1. Restarting the worker (`update-service --force-new-deployment`, then `wait services-stable`) took about 4 minutes 20 seconds, and the heartbeat lines resumed with `maxJobLagSeconds` 0. **Not tried:** a failing worker, a stuck loop, a real or test SOS going through the pipeline on AWS, Fix 2 and Fix 3 (they need a signed-in dashboard), and any alarm e-mail (the SNS subscription is unconfirmed, so the alarms e-mail nobody yet). Alert and sender behaviour is covered by automated tests, `apps/api/test/sos.test.ts` ADV-S08 and `operator.test.ts`, on a local database.

Known gaps: G01 (no restart script), G02 (no list of organization IDs), G03 (alarm names a count, not organizations), G04 (no contact register), G06 (one-at-a-time sender). The canary runs only where `canary_enabled` is set; production does not exist yet, so the canary has never run for real. `docs/RUNBOOKS/README.md` lists all gaps.
