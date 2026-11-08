# Runbook 09: Revoking an app version

> ## Read this before anything else
>
> **A revoked guard app cannot send an SOS, cannot track and cannot upload.** This is the one exception to "SOS is never refused" (INV-15, `docs/ARCHITECTURE.md §15.2`). The server answers 426 `APP_VERSION_UNSUPPORTED` to a revoked version on every route except `GET /mobile/config`, even an SOS signed with the phone's device key. The app itself, when it reads the revoked list, stops tracking, blocks uploads and shows "This version of SENTRY was withdrawn. Update the app now." with **no SOS button**.
> Revoke only for a flaw that is worse than that: for example, an app that leaks data or can be abused. For anything less, raise the **minimum** version instead (below): phones below the minimum still upload what they captured and can still send an SOS.
> Before you revoke, have a fixed build ready, tell the control rooms and tell guards on that build to update first, and give them the emergency phone number.

Source: `apps/api/src/app-version.ts`, `context.ts`, `apps/mobile/src/ui/screens/UpdateRequired.tsx`, `apps/mobile/src/core/app.ts`, `docs/DECISIONS.md` (Phase 10).

## When to use

- Alarm `sentryops-<env>-app-error-burst`: 20 or more crash reports from guard phones in 15 minutes. That alone may be a broken build, not a security flaw. Read before you revoke.
- A security flaw is found in a released build (a leak, a bypass, a way to abuse the app).
- Guards report that a build misbehaves, and you must stop it from reaching the server.

## First five minutes

1. Read the crash reports. The app sends them to our API, which writes one `app_error` line each to the API log: error class, a few code positions, app and OS version, platform, organization and device IDs. Never message text or personal data.

```bash
aws logs tail /sentryops-<env>/api --region <region> --since 30m --format short
```

Look only at `app_error` lines. Group by `appVersion` and `errorName`. One version with all the errors is the suspect.

2. How many guards run it? Each guard's page lists their phone and app version. [GAP: no organization-wide version list (G21).]
3. Is anyone on a shift with it right now? Revoking stops their tracking.
4. Is a fixed build ready and installable by those guards? Without one, revoking strands them.

## Decide

| Situation                                                       | Do                                                                                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Crashes only, nobody harmed                                     | Do not revoke. Raise `mobile_recommended_version`, ship a fix, then raise `mobile_min_version`.                                               |
| Old build must go, but SOS and queued data must keep working    | Raise `mobile_min_version` to the fixed version. Below-minimum phones get 426 on new work but can still upload captured data and send an SOS. |
| Security flaw, worse than losing tracking and SOS on that build | Revoke (below).                                                                                                                               |
| Flaw in the server, not the app                                 | Revoking does not help. Fix the server.                                                                                                       |

Revocation matches the **exact** version the app reports in its `X-App-Version` header (compared number by number). An app that sends **no** version, or something that is not a version, is not gated at all: revocation protects against honest old builds, not against a forged client (`app-version.ts`).

## Fix: revoke

1. Add the exact version to the environment's tfvars file (`infra/terraform/env/<env>.tfvars`):

```hcl
mobile_revoked_versions = ["0.1.3"]
```

Letters, digits, dots, plus and hyphen only, 40 characters at most (`variables.tf`). Several versions go in the same list. Empty list `[]` removes all revocations.

2. See what will change. Only the `api` and `worker` task definitions should change (`MOBILE_REVOKED_VERSIONS`).

```bash
infra/scripts/tf.sh <env> plan
```

3. Apply it. Never run an unreviewed plan.

```bash
infra/scripts/tf.sh <env> apply -auto-approve
```

4. Wait until the services have restarted (usually minutes). The apply can return before they finish.

```bash
aws ecs wait services-stable --region <region> --cluster sentryops-<env> --services api worker
```

5. Commit the tfvars change so the repository says what is revoked.

To raise the minimum instead, set `mobile_min_version` (and `mobile_recommended_version`) in the same file and apply the same way.

A revoked phone learns only when it next reaches the server. A phone that is offline keeps running the flawed build until then.

## Confirm it is fixed

- Services stable (step 4).
- On a test phone with the revoked build: it shows "This version of SENTRY was withdrawn. Update the app now." and stops tracking.
- The API log shows 426 responses for that version's requests:

```bash
aws logs tail /sentryops-<env>/api --region <region> --since 15m --format short
```

- Guards who updated are tracking and syncing again; the `app_error` burst alarm returns to OK.

## Tell

| Who                                               | What                                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner (`<owner>`)                             | Which version, why, how many guards on it, and that SOS is gone on that build until updated.                                                                                                                        |
| Control rooms (company owners and administrators) | **Before** you apply, by phone: "Guards on version `<x>` must update now. Until they do, their app will not track and has no SOS button. If one of them needs help, they must phone `<emergency number>`."          |
| Guards                                            | Through the company, plainly: update the app now; until then use the phone for emergencies. For the pilot the app is installed directly (D-34): say how to install the fixed build.                                 |
| Legal                                             | If the flaw exposed data, runbook 08. A forced update that cuts SOS is a customer matter: `docs/legal/TERMS_OF_SERVICE.md` limits SOS promises. [LAWYER: wording of any customer notice about a withdrawn version.] |

## Afterwards

Record: version, reason, time revoked, time the last guard updated. Keep the version in the list; it does no harm. When the fixed build is out, raise `mobile_min_version` past it. Add a test or release check for the cause.

## Status

Tried on the test environment: not yet. (The server side is covered by automated tests: `apps/api/test/app-version.test.ts`, including an SOS signed with the device key. The app side by `apps/mobile` tests, not on a real phone.) The Terraform apply has not been run for this variable.

Known gaps: G21 (no version census), no iOS build exists, and revocation depends on a Terraform apply from an operator's computer.
