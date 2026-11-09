# Runbook 02: Notification provider outage

> **Today:** no SMS provider exists (EXT-10), so every text fails by design with `SMS_NOT_CONFIGURED`, and the guard app does not register for pushes yet (EXT-09). With SOS on, each real SOS would raise the provider-failure alarms until an SMS provider is live.
> Setup: `docs/RUNBOOKS/README.md` › Before you start.

## When to use

- Alarms `sentryops-<env>-notification-provider-failure` (3 failures in 5 minutes) or `notification-failure-rate` (more than 5% of at least 10 sends failed in 15 minutes).
- `delivery-health` prints `CONCERN: <channel>: n of m sends failed`.
- A customer says alerts reach the dashboard but not phones.

Source: `notifications.tf`, `operations.tf`, `apps/api/src/services/operator.ts`.

## The three channels

| Channel (`notification_deliveries.channel`) | Reaches                                          | Provider                         | Credential                    | Where it lives                                                               |
| ------------------------------------------- | ------------------------------------------------ | -------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `WEB_PUSH`                                  | Dashboard browsers, duty officers' phones        | The browser maker's push service | VAPID key pair                | `tls_private_key.vapid`; private half only in the worker's secret            |
| `PUSH`                                      | Guard phones ("SOS acknowledged", shift notices) | Firebase Cloud Messaging         | Firebase service account JSON | `fcm_service_account` in git-ignored `local.auto.tfvars`; worker secret only |
| `SMS`                                       | Duty officers, emergency contacts                | None chosen yet                  | None                          | `SMS_PROVIDER` is `none` (or `memory`, tests only)                           |

The dashboard's live alarm does not use any of these. It goes over the live stream and still rings on an open dashboard (tested: ADV-S08).

Source: `notifications.tf`, `secrets.tf`, `apps/api/src/notify/providers.ts`, `config.ts`.

## First five minutes

1. Which channel and which code? Delivery counts by channel, status and error code:

```bash
infra/scripts/operator.sh <env> delivery-health --org <org> --reason "provider outage check" --hours 2 | tr '\t' '\n'
```

2. The worker's failure lines (one per failed attempt, with `channel` and `code`):

```bash
aws logs tail /sentryops-<env>/worker --region <region> --since 30m --format short
```

3. Look only at `notification provider failure` and `notification run` lines. Check the provider's own status page.

## Tell a provider outage from our bug

| Code in the log or `delivery-health`                                                 | Meaning                                                                                                | Whose problem                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `HTTP_500`..`HTTP_599`, `HTTP_429`, `NETWORK` for many recipients, starting suddenly | Provider down, slow or limiting us                                                                     | Provider (or our network if every channel fails) |
| `HTTP_401`, `HTTP_403` on WEB_PUSH; `FCM_AUTH` or `HTTP_401` on PUSH                 | Credential refused: wrong, rotated or revoked key                                                      | Ours (runbook 05)                                |
| `WEB_PUSH_NOT_CONFIGURED`, `FCM_NOT_CONFIGURED`, `SMS_NOT_CONFIGURED`                | Key or provider never set up                                                                           | Ours (setup)                                     |
| `NO_SUBSCRIPTION`, `NO_PUSH_TOKEN`                                                   | Recipient never registered                                                                             | Setup, not an outage                             |
| `HTTP_404`, `HTTP_410` on a few recipients                                           | Stale subscription or token; marked INVALID automatically                                              | Normal                                           |
| `SEND_ERROR`, `ENDPOINT_NOT_ALLOWED`, `BAD_SUBSCRIPTION_KEYS`                        | Exception or bad data in our sender                                                                    | Our bug: engineer                                |
| status SUPPRESSED, code `THROTTLED`, `MONTHLY_CAP`, `NOT_ALLOW_LISTED`               | Rule held it back (1 text per person per SOS per 60 s; non-SOS monthly cap; non-production allow-list) | Not a failure                                    |

Source: `notify/webpush.ts`, `notify/fcm.ts`, `services/notifications.ts`.

## What the sender does on failure

- Attempts: an SOS message 3 (retries after 15 s and 45 s); anything else 5 (after 60 s, 180 s, 480 s, 1,080 s). Only "retryable" failures (network, 429, 5xx, FCM 401) are retried; after the last attempt the delivery is FAILED.
- An SOS keeps climbing its ladder and repeats every 120 s until someone acknowledges. Each repeat creates new deliveries, so a provider that returns is used again with no action from you.
- Each provider call waits at most 10 s, and the sender sends one message at a time. A provider that hangs slows every message behind it, in every organization. [GAP: send in parallel or per-channel lanes (G06).]
- Invalid recipients are dropped: a web-push subscription becomes INVALID, a guard's push token is cleared.
- Every failed attempt, including ones that will be retried, logs `notification provider failure`. The alarm counts attempts, not final failures.

## Decide

| Situation                                             | Do                                                                                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Short blip, `delivery-health` recovers within minutes | Wait. Retries and the ladder repeat cover it.                                                                                                                                                             |
| Provider down for longer                              | Tell the control rooms (below). Rely on the dashboard alarm and phone calls. Do not change ladders or switch channels off in a hurry.                                                                     |
| Credential refused                                    | Runbook 05 (VAPID or Firebase key).                                                                                                                                                                       |
| SMS wanted but no provider                            | A provider needs code (a new `SmsSender` in `notify/providers.ts`) and a release; `SMS_PROVIDER` accepts only `none` and `memory`. [GAP: no SMS provider chosen; no second provider for fail-over (G07).] |
| Web Push or Firebase down                             | No alternative exists by design (D-26). Wait, and use phone calls.                                                                                                                                        |
| Our bug (`SEND_ERROR`)                                | Engineer. Collect codes and times only.                                                                                                                                                                   |

## Fix

1. Name the channel and the cause with the table above.
2. Provider outage: nothing to repair on our side. Tell people (below), then watch `delivery-health` every 15 minutes.
3. Credential: follow runbook 05 for that key, then restart the worker (runbook 01, Fix 1).
4. Bug: stop. Do not change the sender at 3 a.m. Phone the control rooms and escalate to an engineer.

## Confirm it is fixed

- `delivery-health`: no `CONCERN:` line, no growing FAILED count for the channel.
- Worker log: `notification run` lines with `failed` 0 for 15 minutes.
- Both alarms back to OK (the e-mail says OK).
- A duty officer's "Send me a test SOS alert" (Settings › Notifications) arrives.

## Tell

| Who                            | What                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner (`<owner>`)          | Which channel, since when, expected recovery.                                                                                                                  |
| Company owner or administrator | "Phone and text alerts may be late. The alarm on an open dashboard still works: keep a dashboard open with sound on, and phone your guards on critical posts." |
| Guards                         | Through the company. Guards are not affected unless guard push is live.                                                                                        |
| Legal                          | None by itself. If a real SOS was delayed, see runbook 01 › Tell.                                                                                              |

## Afterwards

Record channel, codes, start and end times, and whether any real SOS fell in the window. If the same provider fails twice, raise provider choice with the owner.

## Status

Tried on the test environment, 2026-11-08: the two look-in commands (`delivery-health` and the worker log tail) run and print what the runbook says on a healthy system. **Not tried:** an actual provider failure, which cannot be made on AWS today. Provider failure is covered by automated tests only, `apps/api/test/sos.test.ts` ADV-S08.

Known gaps: G04, G06, G07. Firebase and SMS cannot be exercised until the Firebase project (TODO item 5) and an SMS provider exist.
