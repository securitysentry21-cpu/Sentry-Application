// Patrols (PROD §9, ARCH §11): runs inside shifts, checkpoint scans from the sync pipeline, and the
// run closer. The rules are pure (packages/domain/patrols.ts); this applies them inside the caller's
// tenant transaction. Runs are per shift (D-16); a QR code alone never completes a checkpoint (INV-11).
import type { ErrorCode, ScanResult, SyncItem } from '@sentryops/contracts';
import { withTenantTransaction, type Database } from '@sentryops/db';
import {
  alertKey,
  distanceBand,
  haversineM,
  inShiftWindow,
  isOutOfOrder,
  runProgress,
  runSchedule,
  runStatus,
  verifyScan,
  type CaptureEstimate,
  type RunStatus,
  type ScanOutcome,
  type ScanSettings,
  type ShiftEventType,
} from '@sentryops/domain';

import type { AppDeps } from '../deps.ts';
import { uuidv7 } from '../ids.ts';
import { numberSetting, organizationSettings } from '../repositories/organizations.ts';
import {
  activeShiftIdsAtSite,
  anyRouteOfCheckpoint,
  countedSince,
  deleteRunsNotYetDue,
  insertRuns,
  insertVisit,
  lockRun,
  openRunsEndedBefore,
  previousCountingVisit,
  runAt,
  runCounters,
  runsForShift,
  scansReceivedSince,
  scheduledRouteOfCheckpoint,
  scheduledRoutesForSite,
  stopsForRoutes,
  updateRunProgress,
  visitByClientEvent,
  visitsForRuns,
  type PatrolRunRow,
  type RunInsert,
  type VisitRow,
} from '../repositories/patrols.ts';
import { getShift, type ShiftRow } from '../repositories/shifts.ts';
import { advanceLiveContact, hasQuarantinedStart } from '../repositories/tracking.ts';
import { resolveCheckpoint } from '../qr.ts';
import { raiseAlert, reopenSuppressionMs } from './alerts.ts';

/** A run closes this long after its window ends, so a scan made at the last moment can arrive. */
export const RUN_CLOSE_GRACE_MS = 2 * 60_000;
/** SEC §9: checkpoint scans, 60 per guard per minute. Beyond it a scan waits (RETRY), never lost. */
export const SCANS_PER_MINUTE = 60;
const CLOSER_BATCH = 500;
/** Outcomes of a checkpoint at the guard's own site: the only ones that name it or attach to a run. */
const SAME_SITE: ReadonlySet<ScanOutcome> = new Set([
  'VERIFIED',
  'LOCATION_UNCONFIRMED',
  'OUTSIDE_RADIUS',
  'DUPLICATE',
]);

export type PatrolScanSettings = ScanSettings & { readonly duplicateWindowS: number };

export function scanSettingsFrom(settings: Record<string, unknown>): PatrolScanSettings {
  return {
    maxFixAgeS: numberSetting(settings, 'checkpoint.max_fix_age_s', 30),
    maxUsableAccuracyM: numberSetting(settings, 'checkpoint.max_usable_accuracy_m', 50),
    maxPlausibleSpeedMps: numberSetting(settings, 'checkpoint.max_plausible_speed_mps', 15),
    duplicateWindowS: numberSetting(settings, 'checkpoint.duplicate_window_s', 300),
    countUnconfirmed: settings['patrol.count_unconfirmed_as_completed'] !== false,
    treatMockAsUnconfirmed: settings['patrol.treat_mock_as_unconfirmed'] !== false,
  };
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────

/**
 * After every shift change: a start generates the shift's runs, including ones already due when a
 * start synced late (they were owed); an extension or other change regenerates the runs not yet
 * due; the end closes what is open (PROD §9.2).
 */
export async function onShiftPatrols(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  shift: ShiftRow,
  event: ShiftEventType,
): Promise<void> {
  if (shift.status === 'ACTIVE') {
    await planRuns(trx, deps, organizationId, shift, event === 'STARTED' ? 'all' : 'future');
  } else if (shift.status === 'COMPLETED' || shift.status === 'CANCELLED') {
    await closeRunsAtEnd(trx, deps, organizationId, shift);
  }
}

/** After a route changed: the runs not yet due of every active shift at the site follow it. */
export async function onRouteChanged(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  siteId: string,
  routeId: string,
): Promise<void> {
  for (const id of await activeShiftIdsAtSite(trx, organizationId, siteId)) {
    const shift = await getShift(trx, organizationId, id);
    if (!shift) continue;
    await planRuns(trx, deps, organizationId, shift, 'future');
    // A run under way keeps going, against the route's current checkpoints.
    for (const run of await runsForShift(trx, organizationId, shift.id)) {
      if (run.routeId === routeId && (run.status === 'PENDING' || run.status === 'IN_PROGRESS')) {
        await recomputeRun(trx, deps, organizationId, run, false);
      }
    }
  }
}

async function planRuns(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  shift: ShiftRow,
  scope: 'all' | 'future',
): Promise<void> {
  if (!shift.actualStartedAt) return;
  const now = deps.clock.now();
  const routes = (await scheduledRoutesForSite(trx, organizationId, shift.siteId)).filter((r) =>
    r.stops.some((s) => s.required),
  );
  const existing = await runsForShift(trx, organizationId, shift.id);
  const notYetDue = (r: PatrolRunRow) => r.status === 'PENDING' && r.dueAt.getTime() > now.getTime();

  // A route that stopped being scheduled here (made on demand or inactive, or left without a
  // required checkpoint) is owed nothing more: its runs not yet due go, and the one under way is
  // cancelled, so an administrator's change never raises an alert against the guard.
  const live = new Set(routes.map((r) => r.id));
  for (const run of existing) {
    if (live.has(run.routeId) || notYetDue(run)) continue;
    if (run.status === 'PENDING' || run.status === 'IN_PROGRESS') {
      await cancelRun(trx, deps, organizationId, run);
    }
  }
  for (const routeId of new Set(
    existing.filter((r) => !live.has(r.routeId) && notYetDue(r)).map((r) => r.routeId),
  )) {
    await deleteRunsNotYetDue(trx, organizationId, shift.id, now, routeId);
  }

  const inserts: RunInsert[] = [];
  for (const route of routes) {
    const mine = existing.filter((r) => r.routeId === route.id);
    const kept = mine.filter((r) => !notYetDue(r));
    const required = route.stops.filter((s) => s.required).length;
    const planned = runSchedule(
      {
        intervalMinutes: route.intervalMinutes!,
        firstRunOffsetMinutes: route.firstRunOffsetMinutes,
        completionWindowMinutes: route.completionWindowMinutes!,
      },
      shift.actualStartedAt,
      shift.endsAt,
    ).filter((p) => (scope === 'all' && mine.length === 0) || p.dueAt.getTime() > now.getTime());
    const current = mine.filter(notYetDue);
    const same =
      current.length === planned.length &&
      current.every(
        (r, i) =>
          r.dueAt.getTime() === planned[i]!.dueAt.getTime() &&
          r.windowEndsAt.getTime() === planned[i]!.windowEndsAt.getTime() &&
          r.requiredCount === required,
      );
    if (same) continue;
    if (current.length > 0) await deleteRunsNotYetDue(trx, organizationId, shift.id, now, route.id);
    let sequenceNo = Math.max(0, ...kept.map((r) => r.sequenceNo));
    for (const p of planned) {
      inserts.push({
        id: uuidv7(deps.clock),
        organizationId,
        shiftId: shift.id,
        guardId: shift.guardId,
        siteId: shift.siteId,
        routeId: route.id,
        sequenceNo: ++sequenceNo,
        dueAt: p.dueAt,
        windowEndsAt: p.windowEndsAt,
        requiredCount: required,
        now,
      });
    }
  }
  await insertRuns(trx, inserts);
}

/** The shift ended: runs not yet due are cancelled, the others close with what was scanned. */
async function closeRunsAtEnd(trx: Database, deps: AppDeps, organizationId: string, shift: ShiftRow) {
  const endedAt = shift.actualEndedAt ?? deps.clock.now();
  for (const run of await runsForShift(trx, organizationId, shift.id)) {
    if (run.status !== 'PENDING' && run.status !== 'IN_PROGRESS') continue;
    if (run.dueAt.getTime() >= endedAt.getTime()) await cancelRun(trx, deps, organizationId, run);
    else await recomputeRun(trx, deps, organizationId, run, true);
  }
}

/** Nothing more is owed for this run; what was scanned in it stays as it was. */
async function cancelRun(trx: Database, deps: AppDeps, organizationId: string, run: PatrolRunRow) {
  await lockRun(trx, organizationId, run.id);
  await updateRunProgress(trx, organizationId, run.id, {
    status: 'CANCELLED',
    startedAt: run.startedAt,
    completedAt: null,
    closedAt: deps.clock.now(),
    requiredCount: run.requiredCount,
    countedCount: run.countedCount,
    unconfirmedCount: run.unconfirmedCount,
    now: deps.clock.now(),
  });
}

/** The run closer (ARCH §16.2): open runs whose window ended, in one organization. */
export async function closeDueRuns(deps: AppDeps, organizationId: string): Promise<number> {
  return withTenantTransaction(deps.db, organizationId, async (trx) => {
    const before = new Date(deps.clock.now().getTime() - RUN_CLOSE_GRACE_MS);
    const runs = await openRunsEndedBefore(trx, organizationId, before, CLOSER_BATCH);
    for (const run of runs) await recomputeRun(trx, deps, organizationId, run, true);
    return runs.length;
  });
}

/**
 * Recomputes a run from its visits against the route's current checkpoints. `close` ends an open
 * run (window over, or shift over); a run already closed stays closed but takes late scans, so an
 * offline round that arrives afterwards still shows as done. Closing an incomplete run raises one
 * CHECKPOINT_MISSED alert naming what is missing (PROD §9.2); it is never resolved by the system
 * (PROD §12.1), so a person sees it even if late scans complete the run.
 */
async function recomputeRun(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  run: PatrolRunRow,
  close: boolean,
): Promise<{ status: RunStatus; countedCount: number; requiredCount: number }> {
  await lockRun(trx, organizationId, run.id);
  const now = deps.clock.now();
  const stops = (await stopsForRoutes(trx, organizationId, [run.routeId])).get(run.routeId) ?? [];
  const visits = await visitsForRuns(trx, organizationId, [run.id]);
  const progress = runProgress(stops, visits.map(runVisit));
  const alreadyClosed = run.closedAt !== null;
  const status = runStatus(progress, close || alreadyClosed);
  await updateRunProgress(trx, organizationId, run.id, {
    status,
    startedAt: progress.startedAtMs === null ? null : new Date(progress.startedAtMs),
    completedAt: progress.completedAtMs === null ? null : new Date(progress.completedAtMs),
    ...(close && !alreadyClosed ? { closedAt: now } : {}),
    requiredCount: progress.requiredCount,
    countedCount: progress.countedCount,
    unconfirmedCount: progress.unconfirmedCount,
    now,
  });
  if (close && !alreadyClosed && (status === 'INCOMPLETE' || status === 'MISSED')) {
    const missing = stops.filter((s) => s.required && !progress.done.has(s.checkpointId)).map((s) => s.name);
    const settings = await organizationSettings(trx, organizationId);
    const word = status === 'MISSED' ? 'missed' : 'incomplete';
    await raiseAlert(
      trx,
      deps,
      organizationId,
      {
        type: 'CHECKPOINT_MISSED',
        dedupeKey: alertKey.patrolRun(run.id),
        summary: `Checkpoint run ${word}: ${run.guardName} (${run.siteName}), ${missing.length} of ${progress.requiredCount} missing`,
        guardId: run.guardId,
        siteId: run.siteId,
        shiftId: run.shiftId,
        details: {
          runId: run.id,
          route: run.routeName,
          dueAt: run.dueAt.toISOString(),
          missing: missing.slice(0, 50),
        },
      },
      reopenSuppressionMs(settings),
    );
  }
  return { status, countedCount: progress.countedCount, requiredCount: progress.requiredCount };
}

const runVisit = (v: VisitRow) => ({
  checkpointId: v.checkpointId ?? '',
  outcome: v.outcome,
  counted: v.counted,
  scannedAtMs: v.scannedAt.getTime(),
});

// ── Scans (ARCH §11.2) ───────────────────────────────────────────────────────────────────────

export type ScanGuard = {
  readonly organizationId: string;
  readonly guardId: string;
  readonly deviceId: string;
};

export type ScanItemResult =
  | { readonly status: 'ACCEPTED' | 'DUPLICATE'; readonly scan: ScanResult }
  | { readonly status: 'RETRY' }
  | { readonly status: 'REJECTED'; readonly code: ErrorCode };

/**
 * One CHECKPOINT_SCAN from the sync batch, judged by its capture time (ADV-Q09) with the same rules
 * online and offline. The scanned token is never stored or logged; coordinates are kept only inside
 * an active shift window (INV-08).
 */
export async function processScan(
  trx: Database,
  deps: AppDeps,
  guard: ScanGuard,
  item: Extract<SyncItem, { type: 'CHECKPOINT_SCAN' }>,
  ctx: {
    readonly estimate: CaptureEstimate;
    readonly receivedAt: Date;
    readonly settings: Record<string, unknown>;
  },
): Promise<ScanItemResult> {
  const org = guard.organizationId;
  // The same scan again: its first result stands (ADV-Q04, INV-06).
  const previousResult = await visitByClientEvent(trx, org, guard.deviceId, item.clientEventId);
  if (previousResult) return { status: 'DUPLICATE', scan: await resultOf(trx, org, previousResult) };
  if (
    (await scansReceivedSince(trx, org, guard.guardId, new Date(ctx.receivedAt.getTime() - 60_000))) >=
    SCANS_PER_MINUTE
  ) {
    return { status: 'RETRY' };
  }

  const scannedAt = ctx.estimate.capturedAt;
  const settings = scanSettingsFrom(ctx.settings);
  const resolution = await resolveCheckpoint(trx, org, item.token);
  const checkpoint = resolution.ok ? resolution.checkpoint : null;

  // The shift whose window holds the scan (judged by capture time, like locations).
  let shift: ShiftRow | null = null;
  if (item.shiftId) {
    const candidate = await getShift(trx, org, item.shiftId);
    if (!candidate || candidate.guardId !== guard.guardId) return { status: 'REJECTED', code: 'NOT_FOUND' };
    if (inShiftWindow(scannedAt, candidate.actualStartedAt, candidate.actualEndedAt, ctx.receivedAt)) {
      shift = candidate;
    } else if (
      candidate.status === 'SCHEDULED' &&
      (await hasQuarantinedStart(trx, org, guard.deviceId, candidate.id))
    ) {
      // Its start waits in quarantine: hold the scan rather than judge it against no shift.
      return { status: 'RETRY' };
    }
  }

  // The route and the run the scan belongs to: the checkpoint's scheduled route, the run whose
  // window holds the capture time; on-demand routes have no runs.
  const sameSite = checkpoint !== null && shift !== null && checkpoint.siteId === shift.siteId;
  let routeId: string | null = null;
  let run: PatrolRunRow | null = null;
  let enforceOrder = false;
  if (sameSite) {
    const scheduled = await scheduledRouteOfCheckpoint(trx, org, checkpoint.id);
    if (scheduled) {
      routeId = scheduled.id;
      enforceOrder = scheduled.enforce_order;
      run = await runAt(trx, org, shift!.id, scheduled.id, scannedAt);
    } else {
      routeId = await anyRouteOfCheckpoint(trx, org, checkpoint.id);
    }
  }

  const duplicate =
    sameSite &&
    (await countedSince(
      trx,
      org,
      run ? { runId: run.id } : { shiftId: shift!.id },
      checkpoint.id,
      new Date(scannedAt.getTime() - settings.duplicateWindowS * 1000),
      scannedAt,
    ));
  let outOfOrder = false;
  if (sameSite && run && enforceOrder) {
    const stops = (await stopsForRoutes(trx, org, [run.routeId])).get(run.routeId) ?? [];
    const counted = new Set(
      (await visitsForRuns(trx, org, [run.id])).filter((v) => v.counted).map((v) => v.checkpointId ?? ''),
    );
    outOfOrder = isOutOfOrder(stops, counted, checkpoint.id);
  }
  const previous = shift ? await previousCountingVisit(trx, org, shift.id, scannedAt) : null;

  const fix = item.fix
    ? {
        lat: item.fix.lat,
        lng: item.fix.lon,
        accuracyM: item.fix.accuracyM,
        fixAgeS: item.fix.fixAgeS ?? null,
        isMock: item.fix.isMock === true,
      }
    : null;
  const verdict = verifyScan(
    {
      checkpoint: checkpoint
        ? {
            siteId: checkpoint.siteId,
            location: checkpoint.location,
            radiusM: checkpoint.verificationRadiusM,
          }
        : null,
      shift: shift ? { siteId: shift.siteId } : null,
      duplicate,
      fix,
      scannedAtMs: scannedAt.getTime(),
      previous: previous ? { scannedAtMs: previous.scannedAt.getTime(), location: previous.location } : null,
      outOfOrder,
      flags: ctx.estimate.flags,
    },
    settings,
  );

  const attach = SAME_SITE.has(verdict.outcome);
  const inserted = await insertVisit(trx, {
    id: uuidv7(deps.clock),
    organizationId: org,
    guardId: guard.guardId,
    shiftId: shift?.id ?? null,
    checkpointId: checkpoint?.id ?? null,
    routeId: attach ? routeId : null,
    runId: attach ? (run?.id ?? null) : null,
    deviceId: guard.deviceId,
    clientEventId: item.clientEventId,
    scannedAtRecorded: new Date(item.recordedAt),
    scannedAt,
    receivedAt: ctx.receivedAt,
    clockStatus: ctx.estimate.clockStatus,
    // INV-08: no coordinates or distance outside a shift window, only a band.
    position: shift && fix ? { lat: fix.lat, lng: fix.lng } : null,
    accuracyM: fix?.accuracyM ?? null,
    fixAgeS: fix?.fixAgeS ?? null,
    distanceM: shift ? verdict.distanceM : null,
    distanceBand:
      !shift && fix && checkpoint?.location ? distanceBand(haversineM(checkpoint.location, fix)) : null,
    isMock: fix ? fix.isMock : null,
    outcome: verdict.outcome,
    reason: verdict.reason,
    flags: verdict.flags,
    counted: verdict.counted,
    qrTokenVersion: checkpoint?.qrVersion ?? null,
  });
  if (!inserted) {
    // A concurrent copy of this event won the insert; its result stands.
    const stored = await visitByClientEvent(trx, org, guard.deviceId, item.clientEventId);
    if (stored) return { status: 'DUPLICATE', scan: await resultOf(trx, org, stored) };
  }

  const progress = attach && run ? await recomputeRun(trx, deps, org, run, false) : null;
  if (shift) {
    if (verdict.suspicious) {
      await raiseAlert(
        trx,
        deps,
        org,
        {
          type: 'SUSPICIOUS_LOCATION',
          dedupeKey: alertKey.suspicious(shift.id),
          summary: `Suspicious location: ${shift.guardName} (${shift.siteName})`,
          guardId: guard.guardId,
          siteId: shift.siteId,
          shiftId: shift.id,
          details: {
            flags: verdict.flags.filter((f) => f === 'MOCK_LOCATION' || f === 'IMPLAUSIBLE_TRAVEL'),
            checkpoint: checkpoint?.name ?? null,
            capturedAt: scannedAt.toISOString(),
          },
        },
        reopenSuppressionMs(ctx.settings),
      );
    }
    if (shift.status === 'ACTIVE') {
      await advanceLiveContact(
        trx,
        { organizationId: org, shiftId: shift.id, guardId: guard.guardId, siteId: shift.siteId },
        ctx.receivedAt,
      );
    }
  }
  return {
    status: 'ACCEPTED',
    scan: scanResult(
      verdict.outcome,
      verdict.counted,
      attach ? (checkpoint?.name ?? null) : null,
      verdict.distanceM,
      progress,
    ),
  };
}

function scanResult(
  outcome: ScanOutcome,
  counted: boolean,
  checkpointName: string | null,
  distanceM: number | null,
  run: ScanResult['run'],
): ScanResult {
  return {
    outcome,
    counted,
    // ADV-T08: nothing about a label that isn't this site's checkpoint.
    checkpointName: SAME_SITE.has(outcome) ? checkpointName : null,
    distanceM: outcome === 'OUTSIDE_RADIUS' && distanceM !== null ? Math.round(distanceM / 5) * 5 : null,
    run,
  };
}

/** The phone's view of a stored scan, for a resubmitted event. */
async function resultOf(trx: Database, organizationId: string, v: VisitRow): Promise<ScanResult> {
  const run = v.runId ? await runCounters(trx, organizationId, v.runId) : null;
  return scanResult(v.outcome, v.counted, v.checkpointName, v.distanceM, run);
}
