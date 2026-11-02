// The dashboard's view of SOS and drills (PROD §11, §14.2). The SOS position and trail are a guard's
// location: the route records SOS_VIEWED before this returns them (INV-14).
import type { SosDetail, SosDrill } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import { drillOpenAt } from '@sentryops/domain';

import type { OrgContext } from '../context.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, notFound } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { receiptCounts } from '../repositories/alerts.ts';
import { getGuard } from '../repositories/guards.ts';
import { getMember } from '../repositories/memberships.ts';
import { deliveriesForAlert } from '../repositories/notifications.ts';
import {
  currentDrillId,
  endDrill,
  getDrill,
  getSos,
  insertDrill,
  sosTrail,
  type DrillRow,
} from '../repositories/sos.ts';
import { maskPhone } from '../mask.ts';
import { alertForSos } from './sos.ts';

const TRAIL_POINTS = 200;

export async function sosDetail(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  sosEventId: string,
  beforeLocation: () => Promise<void>,
): Promise<SosDetail> {
  const sos = await getSos(trx, organizationId, sosEventId);
  if (!sos) throw notFound();
  await beforeLocation();
  const alert = await alertForSos(trx, organizationId, sos.id);
  const receipts = alert
    ? await receiptCounts(trx, organizationId, alert.id)
    : { shownOnDashboards: 0, reachedPhones: 0 };
  const deliveries = alert ? await deliveriesForAlert(trx, organizationId, alert.id) : [];
  const trail = (await sosTrail(trx, organizationId, sos.id, TRAIL_POINTS)).reverse();
  return {
    id: sos.id,
    alertId: alert?.id ?? null,
    status: sos.status,
    isDrill: sos.isDrill,
    guard: {
      id: sos.guardId,
      displayName: sos.guardName,
      employeeNumber: sos.employeeNumber,
      phone: sos.guardPhone,
    },
    site: sos.siteId
      ? { id: sos.siteId, name: sos.siteName ?? '', timezone: sos.siteTimezone ?? 'UTC' }
      : null,
    shiftId: sos.shiftId,
    activatedAt: sos.activatedAt.toISOString(),
    receivedAt: sos.receivedAt.toISOString(),
    triggerCount: sos.triggerCount,
    lastTriggeredAt: sos.lastTriggeredAt.toISOString(),
    guardCancelRequestedAt: sos.guardCancelRequestedAt?.toISOString() ?? null,
    alertSentAt: sos.alertSentAt?.toISOString() ?? null,
    notifiedAt: sos.notifiedAt?.toISOString() ?? null,
    acknowledgedAt: sos.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: sos.acknowledgedBy
      ? { id: sos.acknowledgedBy, name: sos.acknowledgedByName ?? '' }
      : null,
    resolvedAt: sos.resolvedAt?.toISOString() ?? null,
    resolvedBy: sos.resolvedBy ? { id: sos.resolvedBy, name: sos.resolvedByName ?? '' } : null,
    resolution: sos.resolution as SosDetail['resolution'],
    resolutionNote: sos.resolutionNote,
    location:
      sos.latitude !== null && sos.longitude !== null && sos.locationCapturedAt
        ? {
            lat: sos.latitude,
            lng: sos.longitude,
            accuracyM: sos.accuracyM,
            capturedAt: sos.locationCapturedAt.toISOString(),
          }
        : null,
    trail: trail.map((p) => ({
      lat: p.latitude,
      lng: p.longitude,
      accuracyM: p.accuracy_m,
      capturedAt: p.captured_at.toISOString(),
    })),
    receipts,
    deliveries: deliveries.map((d) => ({
      channel: d.channel as SosDetail['deliveries'][number]['channel'],
      recipient: d.member_name ?? `Emergency contact ${maskPhone(d.recipient_phone) ?? ''}`.trim(),
      status: d.status as SosDetail['deliveries'][number]['status'],
      escalationLevel: d.escalation_level,
      sentAt: d.sent_at?.toISOString() ?? null,
      errorCode: d.error_code,
    })),
    version: sos.version,
  };
}

function drillDto(d: DrillRow, now: Date): SosDrill {
  return {
    id: d.id,
    startedAt: d.startedAt.toISOString(),
    endsAt: d.endsAt.toISOString(),
    endedAt: d.endedAt?.toISOString() ?? null,
    active: drillOpenAt({ ...d, guardIds: [] }, now),
    startedBy: d.startedBy,
    guards: d.guards,
    members: d.members,
    note: d.note,
  };
}

/** A drill, open or past: a drill alert names it, and only its members are alarmed (ADV-S10). */
export async function drillById(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  id: string,
): Promise<SosDrill> {
  const drill = await getDrill(trx, organizationId, id);
  if (!drill) throw notFound();
  return drillDto(drill, deps.clock.now());
}

export async function currentDrill(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
): Promise<SosDrill | null> {
  const now = deps.clock.now();
  const id = await currentDrillId(trx, organizationId, now);
  const drill = id ? await getDrill(trx, organizationId, id) : null;
  return drill ? drillDto(drill, now) : null;
}

/** Opens a drill (PROD §11.10): named guards, the members it may reach, at most 4 hours. */
export async function startSosDrill(
  trx: Database,
  deps: AppDeps,
  org: OrgContext,
  userId: string,
  input: { guardIds: string[]; memberIds: string[]; durationMinutes: number; note?: string | undefined },
): Promise<SosDrill> {
  const now = deps.clock.now();
  if (await currentDrillId(trx, org.id, now)) {
    throw new AppError('DRILL_ALREADY_RUNNING', 'A drill is already open. End it before starting another.');
  }
  const guardIds = [...new Set(input.guardIds)];
  for (const id of guardIds) {
    const guard = await getGuard(trx, org.id, id);
    if (!guard || guard.status !== 'ACTIVE') throw notFound();
  }
  // The person starting it always takes part; the others must be this organization's staff.
  const memberIds = [...new Set([org.memberId, ...input.memberIds])];
  for (const id of memberIds) {
    const member = await getMember(trx, org.id, id);
    if (!member || member.status !== 'ACTIVE' || member.role === 'GUARD') throw notFound();
  }
  const id = uuidv7(deps.clock);
  await insertDrill(trx, {
    id,
    organizationId: org.id,
    startedBy: userId,
    startedAt: now,
    endsAt: new Date(now.getTime() + input.durationMinutes * 60_000),
    note: input.note ?? null,
    guards: guardIds.map((guardId) => ({ id: uuidv7(deps.clock), guardId })),
    members: memberIds.map((memberId) => ({ id: uuidv7(deps.clock), memberId })),
  });
  const drill = await getDrill(trx, org.id, id);
  if (!drill) throw new Error('drill vanished');
  return drillDto(drill, now);
}

export async function endSosDrill(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  userId: string,
  drillId: string,
): Promise<SosDrill> {
  const now = deps.clock.now();
  const drill = await getDrill(trx, organizationId, drillId, true);
  if (!drill) throw notFound();
  await endDrill(trx, organizationId, drillId, userId, now);
  const ended = await getDrill(trx, organizationId, drillId);
  if (!ended) throw notFound();
  return drillDto(ended, now);
}
