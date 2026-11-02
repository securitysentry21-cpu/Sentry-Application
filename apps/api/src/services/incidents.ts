// Incidents (PROD §10). A guard files them from the app, through the sync queue, only during an
// active shift or an open SOS (INV-08): the shift, site and SOS are found by the server from the
// capture time, never taken from the phone. The submission is never edited (INV-05): supervisors
// change status, severity and type, each change an event with old and new values.
import {
  incidentReference,
  INCIDENT_TYPE_TITLES,
  type IncidentDetail,
  type IncidentSummary,
  type IncidentType,
  type SyncItem,
} from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import {
  incidentOccurredAt,
  incidentTransition,
  inShiftWindow,
  type CaptureEstimate,
} from '@sentryops/domain';

import type { AppDeps } from '../deps.ts';
import { AppError, notFound } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { openAlertByKey } from '../repositories/alerts.ts';
import {
  attachmentsFor,
  getIncident,
  guardIncidentByClientEvent,
  incidentByClientEvent,
  incidentEvents,
  incidentsReceivedSince,
  insertIncident,
  insertIncidentEvent,
  nextIncidentNumber,
  updateIncident,
  type AttachmentRow,
  type IncidentRow,
} from '../repositories/incidents.ts';
import { organizationKind, organizationSettings } from '../repositories/organizations.ts';
import { getShift, startedShiftsAround, type ShiftRow } from '../repositories/shifts.ts';
import { getCheckpoint, getSite } from '../repositories/sites.ts';
import { sosOpenAt } from '../repositories/sos.ts';
import { hasQuarantinedStart } from '../repositories/tracking.ts';
import { acknowledge, raiseAlert, reopenSuppressionMs, resolveManually } from './alerts.ts';
import { publish } from './realtime.ts';

const MAX_ACCURACY_M = 50_000;
const INCIDENTS_PER_HOUR = 20;

const incidentAlertKey = (incidentId: string, severity: 'CRITICAL' | 'HIGH') =>
  `incident:${incidentId}:${severity}`;

export type IncidentGuard = {
  readonly organizationId: string;
  readonly guardId: string;
  readonly deviceId: string;
};

export type IncidentItemResult =
  | { status: 'ACCEPTED' | 'DUPLICATE'; incident: { id: string; referenceNumber: string } }
  | { status: 'REJECTED'; code: 'SHIFT_NOT_ACTIVE' | 'VALIDATION_FAILED' | 'NOT_FOUND' }
  | { status: 'RETRY' };

/** PROD §10.4: CRITICAL raises INCIDENT_CRITICAL (escalates like SOS); HIGH raises INCIDENT_HIGH (setting). */
async function incidentAlerts(trx: Database, deps: AppDeps, organizationId: string, incident: IncidentRow) {
  const settings = await organizationSettings(trx, organizationId);
  const severity = incident.severity;
  if (severity !== 'CRITICAL' && !(severity === 'HIGH' && settings['alerts.incident_high_enabled'] !== false))
    return;
  const type = severity === 'CRITICAL' ? 'INCIDENT_CRITICAL' : 'INCIDENT_HIGH';
  const typeTitle = INCIDENT_TYPE_TITLES[incident.type as IncidentType] ?? 'Incident';
  await raiseAlert(
    trx,
    deps,
    organizationId,
    {
      type,
      dedupeKey: incidentAlertKey(incident.id, severity),
      // Plain server text: the type's name and the reference, never the report's own words (PROD §13).
      summary: `${incident.isDrill ? '[DRILL] ' : ''}${severity === 'CRITICAL' ? 'Critical' : 'High'} incident ${incidentReference(incident.referenceNumber)}: ${typeTitle}${incident.siteName ? ` (${incident.siteName})` : ''}`,
      guardId: incident.guardId,
      siteId: incident.siteId,
      shiftId: incident.shiftId,
      incidentId: incident.id,
      sosEventId: incident.sosEventId,
      isDrill: incident.isDrill,
      details: { referenceNumber: incidentReference(incident.referenceNumber), incidentType: incident.type },
    },
    reopenSuppressionMs(settings),
  );
}

async function shiftHolding(
  trx: Database,
  organizationId: string,
  guardId: string,
  at: Date,
  now: Date,
): Promise<ShiftRow | null> {
  for (const shift of await startedShiftsAround(trx, organizationId, guardId, at)) {
    if (inShiftWindow(at, shift.actualStartedAt, shift.actualEndedAt, now)) return shift;
  }
  return null;
}

/** An INCIDENT item from the guard app (ARCH §8.6 main lane). */
export async function processIncidentItem(
  trx: Database,
  deps: AppDeps,
  guard: IncidentGuard,
  item: Extract<SyncItem, { type: 'INCIDENT' }>,
  ctx: { readonly estimate: CaptureEstimate; readonly receivedAt: Date },
): Promise<IncidentItemResult> {
  const org = guard.organizationId;
  const existing = await incidentByClientEvent(trx, org, guard.deviceId, item.clientEventId);
  if (existing) {
    return {
      status: 'DUPLICATE',
      incident: { id: existing.id, referenceNumber: incidentReference(existing.referenceNumber) },
    };
  }
  // SEC §9: 20 incidents per guard per hour. Beyond it the phone sends again later; nothing is lost.
  if (
    (await incidentsReceivedSince(trx, org, guard.guardId, new Date(ctx.receivedAt.getTime() - 3_600_000))) >=
    INCIDENTS_PER_HOUR
  ) {
    return { status: 'RETRY' };
  }
  const reportedAt = ctx.estimate.capturedAt;
  // The shift is judged by capture time (like locations and scans); the phone's shift is a hint.
  let shift: ShiftRow | null = null;
  if (item.shiftId) {
    const hinted = await getShift(trx, org, item.shiftId);
    if (!hinted || hinted.guardId !== guard.guardId) return { status: 'REJECTED', code: 'NOT_FOUND' };
    if (inShiftWindow(reportedAt, hinted.actualStartedAt, hinted.actualEndedAt, ctx.receivedAt))
      shift = hinted;
    else if (
      hinted.status === 'SCHEDULED' &&
      (await hasQuarantinedStart(trx, org, guard.deviceId, hinted.id))
    ) {
      return { status: 'RETRY' };
    }
  }
  shift ??= await shiftHolding(trx, org, guard.guardId, reportedAt, ctx.receivedAt);
  const sos = await sosOpenAt(trx, org, guard.guardId, reportedAt);
  // INV-08: a guard files incidents only during a shift or an open SOS. Nothing is stored otherwise.
  if (!shift && !sos) return { status: 'REJECTED', code: 'SHIFT_NOT_ACTIVE' };
  const occurred = incidentOccurredAt({
    occurredAtPhone: new Date(item.incident.occurredAt),
    recordedAtPhone: new Date(item.recordedAt),
    reportedAt,
  });
  if (!occurred.ok) return { status: 'REJECTED', code: 'VALIDATION_FAILED' };

  const siteId = shift?.siteId ?? sos?.site_id ?? null;
  // "Checkpoint problem" (PROD §7.7): the checkpoint must be one of the shift's site's.
  let checkpointId: string | null = null;
  if (item.incident.checkpointId && siteId) {
    const checkpoint = await getCheckpoint(trx, org, item.incident.checkpointId);
    if (checkpoint && checkpoint.siteId === siteId) checkpointId = checkpoint.id;
  }
  const fix =
    item.fix && (item.fix.accuracyM === null || item.fix.accuracyM <= MAX_ACCURACY_M) ? item.fix : null;
  const kind = await organizationKind(trx, org);
  const id = uuidv7(deps.clock);
  const number = await nextIncidentNumber(trx, org, uuidv7(deps.clock));
  const title = item.incident.title ?? INCIDENT_TYPE_TITLES[item.incident.type];
  const inserted = await insertIncident(trx, {
    id,
    organizationId: org,
    referenceNumber: number,
    guardId: guard.guardId,
    reportedByUserId: null,
    shiftId: shift?.id ?? null,
    sosEventId: sos?.id ?? null,
    siteId,
    checkpointId,
    type: item.incident.type,
    severity: item.incident.severity,
    title,
    description: item.incident.description,
    location: fix
      ? {
          lat: fix.lat,
          lng: fix.lon,
          accuracyM: fix.accuracyM,
          fixAgeS: fix.fixAgeS ?? null,
          isMock: fix.isMock ?? null,
        }
      : null,
    occurredAt: occurred.occurredAt,
    reportedAt,
    reportedAtRecorded: new Date(item.recordedAt),
    receivedAt: ctx.receivedAt,
    isDrill: Boolean(sos?.is_drill) || kind !== 'CUSTOMER',
    deviceId: guard.deviceId,
    clientEventId: item.clientEventId,
  });
  if (!inserted) {
    const raced = await incidentByClientEvent(trx, org, guard.deviceId, item.clientEventId);
    if (!raced) throw new Error('incident insert conflicted without a duplicate');
    return {
      status: 'DUPLICATE',
      incident: { id: raced.id, referenceNumber: incidentReference(raced.referenceNumber) },
    };
  }
  await insertIncidentEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId: org,
    incidentId: id,
    type: 'CREATED',
    actor: { type: 'GUARD', guardId: guard.guardId },
    payload: { type: item.incident.type, severity: item.incident.severity },
    at: ctx.receivedAt,
  });
  const incident = await getIncident(trx, org, id);
  if (!incident) throw new Error('incident vanished');
  await incidentAlerts(trx, deps, org, incident);
  await publish(trx, deps, org, 'incident.created', { incidentId: id });
  deps.metrics.increment('incidents_filed');
  return { status: 'ACCEPTED', incident: { id, referenceNumber: incidentReference(number) } };
}

/** An INCIDENT_NOTE item: the guard's note on their own report (PROD §10.2). Idempotent. */
export async function processNoteItem(
  trx: Database,
  deps: AppDeps,
  guard: IncidentGuard,
  item: Extract<SyncItem, { type: 'INCIDENT_NOTE' }>,
  receivedAt: Date,
): Promise<{ status: 'ACCEPTED' | 'DUPLICATE' } | { status: 'REJECTED'; code: 'NOT_FOUND' }> {
  const org = guard.organizationId;
  const incident = item.incidentId
    ? await getIncident(trx, org, item.incidentId)
    : await guardIncidentByClientEvent(trx, org, guard.guardId, item.incidentClientEventId ?? '');
  // Another guard's report doesn't exist for this guard (INV-02).
  if (!incident || incident.guardId !== guard.guardId) return { status: 'REJECTED', code: 'NOT_FOUND' };
  const inserted = await insertIncidentEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId: org,
    incidentId: incident.id,
    type: 'NOTE_ADDED',
    actor: { type: 'GUARD', guardId: guard.guardId },
    body: item.body,
    deviceId: guard.deviceId,
    clientEventId: item.clientEventId,
    at: receivedAt,
  });
  if (inserted) await publish(trx, deps, org, 'incident.updated', { incidentId: incident.id });
  return { status: inserted ? 'ACCEPTED' : 'DUPLICATE' };
}

// ── The dashboard's side ──────────────────────────────────────────────────────────────────────

export type DashboardUser = { readonly userId: string };

/** PROD §3.2: Supervisors, Administrators and Owners record incidents too (no coordinates). */
export async function createIncidentByUser(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  user: DashboardUser,
  input: {
    type: IncidentType;
    severity: string;
    title: string;
    description: string;
    occurredAt?: string | undefined;
    siteId?: string | undefined;
  },
): Promise<IncidentRow> {
  const now = deps.clock.now();
  const occurred = input.occurredAt
    ? incidentOccurredAt({
        occurredAtPhone: new Date(input.occurredAt),
        recordedAtPhone: now,
        reportedAt: now,
      })
    : { ok: true as const, occurredAt: now };
  if (!occurred.ok) {
    throw new AppError('VALIDATION_FAILED', 'The request is invalid.', [
      { path: 'occurredAt', issue: 'at most 24 hours back, never in the future' },
    ]);
  }
  if (input.siteId && !(await getSite(trx, organizationId, input.siteId))) throw notFound();
  const kind = await organizationKind(trx, organizationId);
  const id = uuidv7(deps.clock);
  const number = await nextIncidentNumber(trx, organizationId, uuidv7(deps.clock));
  await insertIncident(trx, {
    id,
    organizationId,
    referenceNumber: number,
    guardId: null,
    reportedByUserId: user.userId,
    shiftId: null,
    sosEventId: null,
    siteId: input.siteId ?? null,
    checkpointId: null,
    type: input.type,
    severity: input.severity,
    title: input.title,
    description: input.description,
    location: null,
    occurredAt: occurred.occurredAt,
    reportedAt: now,
    reportedAtRecorded: null,
    receivedAt: now,
    isDrill: kind !== 'CUSTOMER',
    deviceId: null,
    clientEventId: null,
  });
  await insertIncidentEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId,
    incidentId: id,
    type: 'CREATED',
    actor: { type: 'USER', userId: user.userId },
    payload: { type: input.type, severity: input.severity },
    at: now,
  });
  const incident = await getIncident(trx, organizationId, id);
  if (!incident) throw new Error('incident vanished');
  await incidentAlerts(trx, deps, organizationId, incident);
  await publish(trx, deps, organizationId, 'incident.created', { incidentId: id });
  return incident;
}

/** Severity and type changes (PROD §10.2), each an event with the old and new value. */
export async function changeIncident(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  user: DashboardUser,
  id: string,
  change: { version: number; severity?: string | undefined; type?: string | undefined },
): Promise<{ incident: IncidentRow; changed: string[] }> {
  const incident = await getIncident(trx, organizationId, id, true);
  if (!incident) throw notFound();
  if (incident.version !== change.version) {
    throw new AppError(
      'VERSION_CONFLICT',
      'The incident changed. Reload it and try again.',
      undefined,
      undefined,
      {
        incident: await incidentDetail(trx, organizationId, incident),
      },
    );
  }
  const now = deps.clock.now();
  const changed: string[] = [];
  if (change.severity && change.severity !== incident.severity) {
    changed.push('severity');
    await insertIncidentEvent(trx, {
      id: uuidv7(deps.clock),
      organizationId,
      incidentId: id,
      type: 'SEVERITY_CHANGED',
      actor: { type: 'USER', userId: user.userId },
      fromValue: incident.severity,
      toValue: change.severity,
      at: now,
    });
  }
  if (change.type && change.type !== incident.type) {
    changed.push('type');
    await insertIncidentEvent(trx, {
      id: uuidv7(deps.clock),
      organizationId,
      incidentId: id,
      type: 'TYPE_CHANGED',
      actor: { type: 'USER', userId: user.userId },
      fromValue: incident.type,
      toValue: change.type,
      at: now,
    });
  }
  if (changed.length > 0) {
    await updateIncident(
      trx,
      organizationId,
      id,
      {
        ...(change.severity ? { severity: change.severity } : {}),
        ...(change.type ? { type: change.type } : {}),
      },
      now,
    );
    const updated = await getIncident(trx, organizationId, id);
    // Raised to HIGH or CRITICAL while open: the alert it now warrants opens (PROD §10.4).
    if (updated && updated.status !== 'RESOLVED' && changed.includes('severity')) {
      await incidentAlerts(trx, deps, organizationId, updated);
    }
    await publish(trx, deps, organizationId, 'incident.updated', { incidentId: id });
  }
  return { incident: (await getIncident(trx, organizationId, id)) ?? incident, changed };
}

export async function addNoteByUser(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  user: DashboardUser,
  id: string,
  body: string,
): Promise<void> {
  const incident = await getIncident(trx, organizationId, id);
  if (!incident) throw notFound();
  await insertIncidentEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId,
    incidentId: id,
    type: 'NOTE_ADDED',
    actor: { type: 'USER', userId: user.userId },
    body,
    at: deps.clock.now(),
  });
  await publish(trx, deps, organizationId, 'incident.updated', { incidentId: id });
}

/** OPEN → ACKNOWLEDGED → RESOLVED (note required); reopen with a reason (PROD §10.1). */
export async function changeIncidentStatus(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  user: DashboardUser,
  id: string,
  action: { kind: 'ACKNOWLEDGE' } | { kind: 'RESOLVE'; note: string } | { kind: 'REOPEN'; reason: string },
): Promise<{ incident: IncidentRow; changed: boolean }> {
  const incident = await getIncident(trx, organizationId, id, true);
  if (!incident) throw notFound();
  const step = incidentTransition(incident.status, action.kind);
  if (!step.ok) {
    throw new AppError('INCIDENT_INVALID_TRANSITION', `The incident is ${incident.status.toLowerCase()}.`);
  }
  if (!step.changed) return { incident, changed: false };
  const now = deps.clock.now();
  if (action.kind === 'ACKNOWLEDGE') {
    await updateIncident(
      trx,
      organizationId,
      id,
      { status: 'ACKNOWLEDGED', acknowledgedBy: user.userId, acknowledgedAt: now },
      now,
    );
  } else if (action.kind === 'RESOLVE') {
    await updateIncident(
      trx,
      organizationId,
      id,
      {
        status: 'RESOLVED',
        resolvedBy: user.userId,
        resolvedAt: now,
        resolutionNote: action.note,
        ...(incident.acknowledgedAt ? {} : { acknowledgedBy: user.userId, acknowledgedAt: now }),
      },
      now,
    );
  } else {
    await updateIncident(
      trx,
      organizationId,
      id,
      {
        status: 'OPEN',
        acknowledgedBy: null,
        acknowledgedAt: null,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
      },
      now,
    );
  }
  await insertIncidentEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId,
    incidentId: id,
    type: 'STATUS_CHANGED',
    actor: { type: 'USER', userId: user.userId },
    fromValue: incident.status,
    toValue: step.to,
    body: action.kind === 'RESOLVE' ? action.note : action.kind === 'REOPEN' ? action.reason : null,
    at: now,
  });
  // The incident's alerts follow it: acknowledging stops their escalation, resolving closes them.
  for (const severity of ['CRITICAL', 'HIGH'] as const) {
    const alert = await openAlertByKey(trx, organizationId, incidentAlertKey(id, severity));
    if (!alert) continue;
    if (action.kind === 'ACKNOWLEDGE') await acknowledge(trx, deps, organizationId, alert, user.userId);
    if (action.kind === 'RESOLVE') {
      await resolveManually(trx, deps, organizationId, alert, user.userId, 'Incident resolved.');
    }
  }
  await publish(trx, deps, organizationId, 'incident.updated', { incidentId: id });
  return { incident: (await getIncident(trx, organizationId, id)) ?? incident, changed: true };
}

/** Acknowledging an incident's alert acknowledges the incident too, so the two never disagree. */
export async function acknowledgeIncidentOfAlert(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  user: DashboardUser,
  incidentId: string,
): Promise<void> {
  const incident = await getIncident(trx, organizationId, incidentId, true);
  if (!incident || incident.status !== 'OPEN') return;
  const now = deps.clock.now();
  await updateIncident(
    trx,
    organizationId,
    incidentId,
    { status: 'ACKNOWLEDGED', acknowledgedBy: user.userId, acknowledgedAt: now },
    now,
  );
  await insertIncidentEvent(trx, {
    id: uuidv7(deps.clock),
    organizationId,
    incidentId,
    type: 'STATUS_CHANGED',
    actor: { type: 'USER', userId: user.userId },
    fromValue: 'OPEN',
    toValue: 'ACKNOWLEDGED',
    at: now,
  });
  await publish(trx, deps, organizationId, 'incident.updated', { incidentId });
}

// ── DTOs ──────────────────────────────────────────────────────────────────────────────────────

export function incidentSummary(i: IncidentRow): IncidentSummary {
  return {
    id: i.id,
    referenceNumber: incidentReference(i.referenceNumber),
    type: i.type as IncidentSummary['type'],
    severity: i.severity as IncidentSummary['severity'],
    status: i.status,
    title: i.title,
    guard: i.guardId ? { id: i.guardId, displayName: i.guardName ?? '' } : null,
    reportedBy: i.reportedByUserId ? { id: i.reportedByUserId, name: i.reportedByName ?? '' } : null,
    site: i.siteId ? { id: i.siteId, name: i.siteName ?? '', timezone: i.siteTimezone ?? 'UTC' } : null,
    checkpoint: i.checkpointId ? { id: i.checkpointId, name: i.checkpointName ?? '' } : null,
    shiftId: i.shiftId,
    sosEventId: i.sosEventId,
    occurredAt: i.occurredAt.toISOString(),
    reportedAt: i.reportedAt.toISOString(),
    receivedAt: i.receivedAt.toISOString(),
    acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
    photoCount: i.photoCount,
    isDrill: i.isDrill,
    version: i.version,
  };
}

export function attachmentDto(a: AttachmentRow) {
  return {
    id: a.id,
    status: a.status,
    captureSource: a.captureSource,
    width: a.width,
    height: a.height,
    sizeBytes: a.sizeBytes,
    exifCapturedAt: a.exifCapturedAt?.toISOString() ?? null,
    rejectionReason: a.rejectionReason,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function incidentDetail(
  trx: Database,
  organizationId: string,
  i: IncidentRow,
): Promise<IncidentDetail> {
  const events = await incidentEvents(trx, organizationId, [i.id]);
  const attachments = await attachmentsFor(trx, organizationId, [i.id]);
  const created = events.find((e) => e.type === 'CREATED');
  const original = (created?.payload ?? {}) as { type?: string; severity?: string };
  return {
    ...incidentSummary(i),
    description: i.description,
    location:
      i.latitude !== null && i.longitude !== null
        ? { lat: i.latitude, lng: i.longitude, accuracyM: i.accuracyM }
        : null,
    locationFlags: i.isMock ? ['MOCK_LOCATION'] : [],
    acknowledgedBy: i.acknowledgedBy ? { id: i.acknowledgedBy, name: i.acknowledgedByName ?? '' } : null,
    resolvedBy: i.resolvedBy ? { id: i.resolvedBy, name: i.resolvedByName ?? '' } : null,
    resolutionNote: i.resolutionNote,
    original: {
      type: (original.type ?? i.type) as IncidentDetail['original']['type'],
      severity: (original.severity ?? i.severity) as IncidentDetail['original']['severity'],
    },
    events: events.map((e) => ({
      id: e.id,
      type: e.type as IncidentDetail['events'][number]['type'],
      actorType: e.actor_type as 'GUARD' | 'USER' | 'SYSTEM',
      actorName: e.actor_type === 'GUARD' ? e.guard_name : e.actor_type === 'USER' ? e.user_name : null,
      body: e.body,
      fromValue: e.from_value,
      toValue: e.to_value,
      createdAt: e.created_at.toISOString(),
    })),
    attachments: attachments.map(attachmentDto),
  };
}
