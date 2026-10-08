// Shifts (PROD §6, ARCH §15.3). Supervisor actions need a reason and are audited; the guard's own
// start and end go through the shared shift service with server time and idempotency.
import {
  errorEnvelopeSchema,
  guardShiftSchema,
  meShiftsResponseSchema,
  shiftBulkRequestSchema,
  shiftBulkResponseSchema,
  shiftCreateRequestSchema,
  shiftEndRequestSchema,
  shiftExtendRequestSchema,
  shiftListQuerySchema,
  shiftListResponseSchema,
  shiftPatchRequestSchema,
  shiftReasonRequestSchema,
  shiftSchema,
  shiftStartRequestSchema,
  type AuditAction,
} from '@sentryops/contracts';
import { withTenantTransaction, type Database } from '@sentryops/db';
import { addDays, localToUtc, transition, weekday, type ShiftCommand } from '@sentryops/domain';
import { z } from 'zod';

import { auditActor, guardOf, orgOf, userOf, type RequestContext } from '../context.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, notFound } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { recordAudit } from '../repositories/audit.ts';
import { getGuard } from '../repositories/guards.ts';
import {
  getShift,
  guardShifts,
  insertShift,
  insertShiftEvent,
  listShifts,
  overlapping,
  updateShift,
  type ShiftRow,
  type ShiftUpdate,
} from '../repositories/shifts.ts';
import { getSite } from '../repositories/sites.ts';
import {
  guardEnd,
  guardShiftDto,
  guardStart,
  loadShiftSettings,
  shiftDto,
  type GuardOutcome,
} from '../services/shifts.ts';
import { defineRoute } from './registry.ts';

const READ = { kind: 'permission', permission: 'shifts.read' } as const;
const WRITE = { kind: 'permission', permission: 'shifts.write' } as const;
const SUPERVISE = { kind: 'permission', permission: 'shifts.supervise' } as const;
const GUARD_SELF = { kind: 'permission', permission: 'shifts.self' } as const;
const MAX_LIST_DAYS = 62;
const DAY = 24 * 60 * 60 * 1000;
const params = z.object({ id: z.uuid() });

/** A unique-exclusion violation on shifts means an overlap (PROD §6.1, ADV-SH03). */
function overlapError(error: unknown): AppError | null {
  return (error as { code?: string }).code === '23P01'
    ? new AppError('SHIFT_OVERLAP', 'The guard already has a shift in that period.')
    : null;
}

async function checkGuardAndSite(trx: Database, organizationId: string, guardId: string, siteId: string) {
  const guard = await getGuard(trx, organizationId, guardId);
  const site = await getSite(trx, organizationId, siteId);
  // Another organization's guard or site is simply not found (ADV-T04).
  if (!guard || guard.status === 'TERMINATED' || !site || site.status === 'ARCHIVED') throw notFound();
  if (guard.status !== 'ACTIVE') throw new AppError('VALIDATION_FAILED', 'The guard is not active.');
  return { guard, site };
}

function checkTimes(startsAt: Date, endsAt: Date) {
  if (!(endsAt > startsAt) || endsAt.getTime() - startsAt.getTime() > DAY) {
    throw new AppError('VALIDATION_FAILED', 'A shift ends after it starts and lasts at most 24 hours.', [
      { path: 'endsAt', issue: 'must be after startsAt, within 24 hours' },
    ]);
  }
}

/** Supervisor transitions: the state machine decides; the reason and the change are audited. */
async function supervise(
  deps: AppDeps,
  ctx: RequestContext,
  shiftId: string,
  command: ShiftCommand,
  audit: AuditAction,
  build: (shift: ShiftRow, now: Date) => ShiftUpdate,
) {
  const org = orgOf(ctx);
  const actor = userOf(ctx);
  return withTenantTransaction(deps.db, org.id, async (trx) => {
    const shift = await getShift(trx, org.id, shiftId, true);
    if (!shift) throw notFound();
    const now = deps.clock.now();
    const result = transition(shift, command, 'SUPERVISOR', now, await loadShiftSettings(trx, org.id));
    if (!result.ok) {
      throw result.code === 'VALIDATION_FAILED'
        ? new AppError('VALIDATION_FAILED', 'That change is not allowed for this shift.')
        : new AppError('SHIFT_INVALID_TRANSITION', `A ${shift.status.toLowerCase()} shift can't do that.`);
    }
    await updateShift(trx, {
      organizationId: org.id,
      id: shift.id,
      version: shift.version,
      userId: actor.userId,
      now,
      changes: build(shift, now),
    });
    const reason = 'reason' in command ? command.reason : null;
    await insertShiftEvent(trx, {
      id: uuidv7(deps.clock),
      organizationId: org.id,
      shiftId: shift.id,
      type: result.event,
      actorType: 'USER',
      actorUserId: actor.userId,
      deviceId: null,
      clientEventId: null,
      occurredAt: now,
      clientRecordedAt: null,
      payload: {
        reason,
        ...(command.type === 'EXTEND'
          ? { from: shift.endsAt.toISOString(), to: command.endsAt.toISOString() }
          : {}),
      },
    });
    await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
      action: audit,
      resourceType: 'shift',
      resourceId: shift.id,
      reason,
      ...(command.type === 'EXTEND' ? { metadata: { endsAt: command.endsAt.toISOString() } } : {}),
    });
    const updated = await getShift(trx, org.id, shift.id);
    if (!updated) throw notFound();
    return shiftDto(updated);
  });
}

/** The guard app reads its outcome from the error code; ACCEPTED and DUPLICATE both return the shift. */
function guardReply(outcome: GuardOutcome) {
  if (outcome.status === 'REJECTED') {
    const messages: Partial<Record<string, string>> = {
      NOT_FOUND: 'Not found.',
      SHIFT_OUTSIDE_START_WINDOW: 'It is too early or too late to start this shift.',
      LOCATION_FIX_REQUIRED: 'A fresh location is needed to start the shift.',
      TRACKING_PERMISSION_REQUIRED: 'Location must be allowed "all the time", with precise location.',
      STARTED_OFF_SITE_BLOCKED: 'You are outside the site. Move inside to start.',
      SHIFT_NOT_ACTIVE: 'This shift is not active.',
      SHIFT_INVALID_TRANSITION: 'This shift cannot be started now.',
    };
    throw new AppError(outcome.code, messages[outcome.code] ?? 'Refused.');
  }
  return guardShiftDto(outcome.shift);
}

export const shiftRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/shifts',
    summary: 'Shifts overlapping a period (at most 62 days).',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    query: shiftListQuerySchema,
    responses: { 200: shiftListResponseSchema },
    handler: async ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      const from = new Date(query.from);
      const to = new Date(query.to);
      if (!(to > from) || to.getTime() - from.getTime() > MAX_LIST_DAYS * DAY) {
        throw new AppError(
          'VALIDATION_FAILED',
          `The period must be positive and at most ${MAX_LIST_DAYS} days.`,
        );
      }
      const rows = await withTenantTransaction(deps.db, org.id, (trx) =>
        listShifts(trx, org.id, {
          from,
          to,
          ...(query.siteId ? { siteId: query.siteId } : {}),
          ...(query.guardId ? { guardId: query.guardId } : {}),
        }),
      );
      return { shifts: rows.map(shiftDto) };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/shifts',
    summary: 'Creates a shift.',
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'SHIFT_CREATED' },
    body: shiftCreateRequestSchema,
    responses: { 201: shiftSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const startsAt = new Date(body.startsAt);
      const endsAt = new Date(body.endsAt);
      checkTimes(startsAt, endsAt);
      try {
        const shift = await withTenantTransaction(deps.db, org.id, async (trx) => {
          await checkGuardAndSite(trx, org.id, body.guardId, body.siteId);
          const settings = await loadShiftSettings(trx, org.id);
          const id = uuidv7(deps.clock);
          const now = deps.clock.now();
          await insertShift(trx, {
            id,
            organizationId: org.id,
            guardId: body.guardId,
            siteId: body.siteId,
            startsAt,
            endsAt,
            startDeadlineAt: new Date(
              Math.min(startsAt.getTime() + settings.missedAfterMinutes * 60_000, endsAt.getTime()),
            ),
            notes: body.notes ?? null,
            userId: actor.userId,
            now,
          });
          await insertShiftEvent(trx, {
            id: uuidv7(deps.clock),
            organizationId: org.id,
            shiftId: id,
            type: 'CREATED',
            actorType: 'USER',
            actorUserId: actor.userId,
            deviceId: null,
            clientEventId: null,
            occurredAt: now,
            clientRecordedAt: null,
            payload: {},
          });
          await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
            action: 'SHIFT_CREATED',
            resourceType: 'shift',
            resourceId: id,
          });
          return getShift(trx, org.id, id);
        });
        if (!shift) throw notFound();
        void reply.code(201);
        return shiftDto(shift);
      } catch (error) {
        throw overlapError(error) ?? error;
      }
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/shifts/bulk',
    summary: 'Creates shifts from a weekly pattern in the site time zone; preview=true shows conflicts only.',
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'SHIFTS_BULK_CREATED' },
    query: z.object({ preview: z.enum(['true', 'false']).default('true') }),
    body: shiftBulkRequestSchema,
    responses: { 200: shiftBulkResponseSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, body, query }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const preview = query.preview === 'true';
      if (body.toDate < body.fromDate)
        throw new AppError('VALIDATION_FAILED', 'The end date is before the start date.');
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const { site } = await checkGuardAndSite(trx, org.id, body.guardId, body.siteId);
        const overnight = body.endTime <= body.startTime;
        const planned: { startsAt: Date; endsAt: Date; conflict: string | null }[] = [];
        for (let date = body.fromDate, n = 0; date <= body.toDate; date = addDays(date, 1), n++) {
          if (n > MAX_LIST_DAYS)
            throw new AppError('VALIDATION_FAILED', `At most ${MAX_LIST_DAYS} days at a time.`);
          if (!body.weekdays.includes(weekday(date))) continue;
          const startsAt = localToUtc(date, body.startTime, site.timezone);
          const endsAt = localToUtc(overnight ? addDays(date, 1) : date, body.endTime, site.timezone);
          planned.push({ startsAt, endsAt, conflict: null });
        }
        if (planned.length === 0) throw new AppError('VALIDATION_FAILED', 'The pattern produces no shifts.');
        const first = planned[0];
        const last = planned.at(-1);
        const existing =
          first && last ? await overlapping(trx, org.id, body.guardId, first.startsAt, last.endsAt) : [];
        for (const p of planned) {
          if (p.endsAt.getTime() - p.startsAt.getTime() > DAY) p.conflict = 'longer than 24 hours';
          else if (existing.some((e) => e.starts_at < p.endsAt && e.ends_at > p.startsAt))
            p.conflict = 'overlaps an existing shift';
        }
        const report = planned.map((p) => ({
          startsAt: p.startsAt.toISOString(),
          endsAt: p.endsAt.toISOString(),
          conflict: p.conflict,
        }));
        if (preview || planned.some((p) => p.conflict)) return { preview, shifts: report, created: 0 };
        const settings = await loadShiftSettings(trx, org.id);
        const now = deps.clock.now();
        for (const p of planned) {
          await insertShift(trx, {
            id: uuidv7(deps.clock),
            organizationId: org.id,
            guardId: body.guardId,
            siteId: body.siteId,
            startsAt: p.startsAt,
            endsAt: p.endsAt,
            startDeadlineAt: new Date(
              Math.min(p.startsAt.getTime() + settings.missedAfterMinutes * 60_000, p.endsAt.getTime()),
            ),
            notes: null,
            userId: actor.userId,
            now,
          });
        }
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'SHIFTS_BULK_CREATED',
          resourceType: 'shift',
          resourceId: null,
          metadata: { count: planned.length, guardId: body.guardId, siteId: body.siteId },
        });
        return { preview, shifts: report, created: planned.length };
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/shifts/:id',
    summary: 'One shift.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    params,
    responses: { 200: shiftSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p }) => {
      const org = orgOf(ctx);
      const shift = await withTenantTransaction(deps.db, org.id, (trx) => getShift(trx, org.id, p.id));
      if (!shift) throw notFound();
      return shiftDto(shift);
    },
  }),

  defineRoute({
    method: 'PATCH',
    url: '/api/v1/shifts/:id',
    summary: 'Edits a scheduled shift (time, guard, site) or the notes of any shift.',
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'SHIFT_UPDATED' },
    params,
    body: shiftPatchRequestSchema,
    responses: { 200: shiftSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      try {
        return await withTenantTransaction(deps.db, org.id, async (trx) => {
          const shift = await getShift(trx, org.id, p.id, true);
          if (!shift) throw notFound();
          if (shift.version !== body.version) {
            throw new AppError(
              'VERSION_CONFLICT',
              'This shift was changed by someone else.',
              undefined,
              undefined,
              shiftDto(shift),
            );
          }
          const structural =
            body.guardId !== undefined ||
            body.siteId !== undefined ||
            body.startsAt !== undefined ||
            body.endsAt !== undefined;
          if (structural && shift.status !== 'SCHEDULED') {
            throw new AppError(
              'SHIFT_INVALID_TRANSITION',
              'Only a scheduled shift can be moved or reassigned.',
            );
          }
          const startsAt = body.startsAt ? new Date(body.startsAt) : shift.startsAt;
          const endsAt = body.endsAt ? new Date(body.endsAt) : shift.endsAt;
          checkTimes(startsAt, endsAt);
          if (body.guardId || body.siteId)
            await checkGuardAndSite(trx, org.id, body.guardId ?? shift.guardId, body.siteId ?? shift.siteId);
          const settings = await loadShiftSettings(trx, org.id);
          const now = deps.clock.now();
          await updateShift(trx, {
            organizationId: org.id,
            id: shift.id,
            version: shift.version,
            userId: actor.userId,
            now,
            changes: {
              ...(body.guardId ? { guardId: body.guardId } : {}),
              ...(body.siteId ? { siteId: body.siteId } : {}),
              ...(structural
                ? {
                    startsAt,
                    endsAt,
                    startDeadlineAt: new Date(
                      Math.min(startsAt.getTime() + settings.missedAfterMinutes * 60_000, endsAt.getTime()),
                    ),
                  }
                : {}),
              ...(body.notes !== undefined ? { notes: body.notes } : {}),
            },
          });
          const reassigned = body.guardId !== undefined && body.guardId !== shift.guardId;
          await insertShiftEvent(trx, {
            id: uuidv7(deps.clock),
            organizationId: org.id,
            shiftId: shift.id,
            type: reassigned ? 'REASSIGNED' : 'UPDATED',
            actorType: 'USER',
            actorUserId: actor.userId,
            deviceId: null,
            clientEventId: null,
            occurredAt: now,
            clientRecordedAt: null,
            payload: { fields: Object.keys(body).filter((k) => k !== 'version') },
          });
          await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
            action: reassigned ? 'SHIFT_REASSIGNED' : 'SHIFT_UPDATED',
            resourceType: 'shift',
            resourceId: shift.id,
            metadata: { fields: Object.keys(body).filter((k) => k !== 'version') },
          });
          const updated = await getShift(trx, org.id, shift.id);
          if (!updated) throw notFound();
          return shiftDto(updated);
        });
      } catch (error) {
        throw overlapError(error) ?? error;
      }
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/shifts/:id/cancel',
    summary: 'Cancels a scheduled shift (reason required).',
    policy: { access: SUPERVISE, ownership: 'organization', rateLimit: 'default', audit: 'SHIFT_CANCELLED' },
    params,
    body: shiftReasonRequestSchema,
    responses: { 200: shiftSchema, 409: errorEnvelopeSchema },
    handler: ({ deps, ctx, params: p, body }) =>
      supervise(deps, ctx, p.id, { type: 'CANCEL', reason: body.reason }, 'SHIFT_CANCELLED', () => ({
        status: 'CANCELLED',
        cancelledReason: body.reason,
      })),
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/shifts/:id/manual-start',
    summary: 'Starts a shift for a guard whose phone is unavailable (reason required; no tracking).',
    policy: {
      access: SUPERVISE,
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'SHIFT_MANUAL_START',
    },
    params,
    body: shiftReasonRequestSchema,
    responses: { 200: shiftSchema, 409: errorEnvelopeSchema },
    handler: ({ deps, ctx, params: p, body }) =>
      supervise(
        deps,
        ctx,
        p.id,
        { type: 'MANUAL_START', reason: body.reason },
        'SHIFT_MANUAL_START',
        (_shift, now) => ({
          status: 'ACTIVE',
          actualStartedAt: now,
          startSource: 'SUPERVISOR_MANUAL',
          startGeofenceClass: 'NO_FIX',
          startFlags: ['MANUAL_START'],
        }),
      ),
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/shifts/:id/force-end',
    summary: 'Ends an active shift (reason required).',
    policy: {
      access: SUPERVISE,
      ownership: 'organization',
      rateLimit: 'default',
      audit: 'SHIFT_FORCE_ENDED',
    },
    params,
    body: shiftReasonRequestSchema,
    responses: { 200: shiftSchema, 409: errorEnvelopeSchema },
    handler: ({ deps, ctx, params: p, body }) =>
      supervise(
        deps,
        ctx,
        p.id,
        { type: 'FORCE_END', reason: body.reason },
        'SHIFT_FORCE_ENDED',
        (_shift, now) => ({
          status: 'COMPLETED',
          actualEndedAt: now,
          endReason: 'SUPERVISOR_FORCE_END',
        }),
      ),
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/shifts/:id/extend',
    summary: 'Moves the end of an active shift later (at most 24 hours in total).',
    policy: { access: SUPERVISE, ownership: 'organization', rateLimit: 'default', audit: 'SHIFT_EXTENDED' },
    params,
    body: shiftExtendRequestSchema,
    responses: { 200: shiftSchema, 409: errorEnvelopeSchema },
    handler: ({ deps, ctx, params: p, body }) => {
      const endsAt = new Date(body.endsAt);
      return supervise(deps, ctx, p.id, { type: 'EXTEND', endsAt }, 'SHIFT_EXTENDED', () => ({ endsAt }));
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/shifts/:id/reopen',
    summary: 'Reopens a missed shift before its scheduled end (reason required).',
    policy: { access: SUPERVISE, ownership: 'organization', rateLimit: 'default', audit: 'SHIFT_REOPENED' },
    params,
    body: shiftReasonRequestSchema,
    responses: { 200: shiftSchema, 409: errorEnvelopeSchema },
    handler: ({ deps, ctx, params: p, body }) =>
      supervise(deps, ctx, p.id, { type: 'REOPEN', reason: body.reason }, 'SHIFT_REOPENED', (shift) => ({
        status: 'SCHEDULED',
        startDeadlineAt: shift.endsAt,
      })),
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/shifts/:id/start',
    summary:
      'The guard starts their own shift (online). Server time decides; repeats return the original result.',
    policy: { access: GUARD_SELF, ownership: 'guard-self', rateLimit: 'default', audit: null },
    params,
    body: shiftStartRequestSchema,
    responses: {
      200: guardShiftSchema,
      404: errorEnvelopeSchema,
      409: errorEnvelopeSchema,
      422: errorEnvelopeSchema,
    },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      const outcome = await withTenantTransaction(deps.db, org.id, (trx) =>
        guardStart(
          trx,
          deps,
          { organizationId: org.id, guardId: guard.guardId, deviceId: guard.deviceId, userId: guard.userId },
          {
            shiftId: p.id,
            clientEventId: body.clientEventId,
            recordedAt: new Date(body.recordedAt),
            // Online: server receipt time, never the phone's clock (INV-07, ADV-TM03).
            capturedAt: deps.clock.now(),
            offline: false,
            fix: body.fix,
            permission: body.permission,
          },
        ),
      );
      return guardReply(outcome);
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/shifts/:id/end',
    summary: 'The guard ends their own active shift (online).',
    policy: { access: GUARD_SELF, ownership: 'guard-self', rateLimit: 'default', audit: null },
    params,
    body: shiftEndRequestSchema,
    responses: { 200: guardShiftSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params: p, body }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      const outcome = await withTenantTransaction(deps.db, org.id, (trx) =>
        guardEnd(
          trx,
          deps,
          { organizationId: org.id, guardId: guard.guardId, deviceId: guard.deviceId, userId: guard.userId },
          {
            shiftId: p.id,
            clientEventId: body.clientEventId,
            recordedAt: new Date(body.recordedAt),
            capturedAt: deps.clock.now(),
            offline: false,
            fix: body.fix,
          },
        ),
      );
      return guardReply(outcome);
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/me/shifts',
    summary: "The guard's own shifts from the last 24 hours to the next 7 days.",
    policy: {
      access: { kind: 'permission', permission: 'shifts.read.own' },
      ownership: 'guard-self',
      rateLimit: 'default',
      audit: null,
    },
    responses: { 200: meShiftsResponseSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const guard = guardOf(ctx);
      const now = deps.clock.now();
      const rows = await withTenantTransaction(deps.db, org.id, (trx) =>
        guardShifts(
          trx,
          org.id,
          guard.guardId,
          new Date(now.getTime() - DAY),
          new Date(now.getTime() + 7 * DAY),
        ),
      );
      return { serverTime: now.toISOString(), shifts: rows.map(guardShiftDto) };
    },
  }),
];
