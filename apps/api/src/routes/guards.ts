// Guards (PROD §4). Creating, editing, importing, disabling and terminating are audited. Disabling
// or terminating a guard ends their phone sessions at once (SEC §5); terminating also retires the
// phone. Shift force-ends on revocation arrive with shifts (Phase 3).
import {
  errorEnvelopeSchema,
  guardCreateRequestSchema,
  guardImportRequestSchema,
  guardImportResponseSchema,
  guardListResponseSchema,
  guardPatchRequestSchema,
  guardSchema,
} from '@sentryops/contracts';
import { withTenantTransaction, type Database } from '@sentryops/db';
import { z } from 'zod';

import { auditActor, orgOf, userOf } from '../context.ts';
import { AppError, notFound } from '../errors.ts';
import { uuidv7 } from '../ids.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  activeDevice,
  getGuard,
  guardKeys,
  insertGuard,
  listGuards,
  revokeDevice,
  revokeGuardSessions,
  updateGuard,
  type GuardInput,
  type GuardRow,
} from '../repositories/guards.ts';
import { defineRoute } from './registry.ts';

const READ = { kind: 'permission', permission: 'guards.read' } as const;
const WRITE = { kind: 'permission', permission: 'guards.write' } as const;
const MAX_IMPORT_ROWS = 5000;
const BOM = String.fromCharCode(0xfeff);

export function guardDto(g: GuardRow) {
  return {
    id: g.id,
    employeeNumber: g.employeeNumber,
    displayName: g.displayName,
    phone: g.phone,
    status: g.status,
    preferredLocale: g.preferredLocale,
    enrolled: g.enrolled,
    version: g.version,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

/** A unique-violation on insert/update means the employee number or phone is taken. */
function conflictMessage(error: unknown): AppError | null {
  const e = error as { code?: string; constraint?: string };
  if (e.code !== '23505') return null;
  const field = e.constraint?.includes('phone') ? 'phone' : 'employeeNumber';
  return new AppError('VALIDATION_FAILED', 'Another guard already uses this value.', [
    { path: field, issue: 'already in use' },
  ]);
}

// ── CSV import (SEC §8: UTF-8, ≤ 5,000 rows, ≤ 1 MB; every row validated first) ───────────────

/** RFC 4180 fields: commas, quotes and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.startsWith(BOM) ? text.slice(1) : text;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const importRow = z.strictObject({
  employeeNumber: guardCreateRequestSchema.shape.employeeNumber,
  displayName: guardCreateRequestSchema.shape.displayName,
  phone: guardCreateRequestSchema.shape.phone,
  preferredLocale: z.enum(['en', 'ur']),
});

type ImportPlan = {
  rows: GuardInput[];
  errors: { row: number; field: string; issue: string }[];
  total: number;
};

async function planImport(trx: Database, organizationId: string, csv: string): Promise<ImportPlan> {
  const table = parseCsv(csv);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const errors: ImportPlan['errors'] = [];
  const column = (name: string) => header.indexOf(name);
  for (const required of ['employee_number', 'display_name', 'phone']) {
    if (column(required) < 0) errors.push({ row: 1, field: required, issue: 'missing column' });
  }
  const body = table.slice(1);
  if (body.length > MAX_IMPORT_ROWS)
    errors.push({ row: 0, field: '(file)', issue: `more than ${MAX_IMPORT_ROWS} rows` });
  if (errors.length > 0) return { rows: [], errors, total: body.length };

  const existing = await guardKeys(trx, organizationId);
  const seenNumbers = new Set<string>();
  const seenPhones = new Set<string>();
  const rows: GuardInput[] = [];
  body.forEach((cells, index) => {
    const rowNumber = index + 2; // 1-based, after the header
    const get = (name: string) => (cells[column(name)] ?? '').trim();
    const parsed = importRow.safeParse({
      employeeNumber: get('employee_number'),
      displayName: get('display_name').replace(/\p{Cc}/gu, ''),
      phone: get('phone').replace(/[\s-]/g, ''),
      preferredLocale: (column('preferred_locale') >= 0 ? get('preferred_locale') : '') || 'en',
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ row: rowNumber, field: String(issue.path[0] ?? ''), issue: issue.message });
      }
      return;
    }
    const g = parsed.data;
    if (existing.employeeNumbers.has(g.employeeNumber) || seenNumbers.has(g.employeeNumber)) {
      errors.push({ row: rowNumber, field: 'employee_number', issue: 'already in use' });
      return;
    }
    if (existing.phones.has(g.phone) || seenPhones.has(g.phone)) {
      errors.push({ row: rowNumber, field: 'phone', issue: 'already in use' });
      return;
    }
    seenNumbers.add(g.employeeNumber);
    seenPhones.add(g.phone);
    rows.push(g);
  });
  return { rows, errors, total: body.length };
}

export const guardRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/guards',
    summary: 'Guards of the current organization.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    responses: { 200: guardListResponseSchema },
    handler: async ({ deps, ctx }) => {
      const org = orgOf(ctx);
      const guards = await withTenantTransaction(deps.db, org.id, (trx) => listGuards(trx, org.id));
      return { guards: guards.map(guardDto) };
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/guards',
    summary: 'Creates a guard.',
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'GUARD_CREATED' },
    body: guardCreateRequestSchema,
    responses: { 201: guardSchema, 400: errorEnvelopeSchema },
    handler: async ({ reply, deps, ctx, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const id = uuidv7(deps.clock);
      try {
        const guard = await withTenantTransaction(deps.db, org.id, async (trx) => {
          await insertGuard(trx, {
            ...body,
            id,
            organizationId: org.id,
            userId: actor.userId,
            now: deps.clock.now(),
          });
          await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
            action: 'GUARD_CREATED',
            resourceType: 'guard',
            resourceId: id,
          });
          return getGuard(trx, org.id, id);
        });
        if (!guard) throw notFound();
        void reply.code(201);
        return guardDto(guard);
      } catch (error) {
        throw conflictMessage(error) ?? error;
      }
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/guards/import',
    summary: 'Imports guards from CSV. preview=true validates without creating anything.',
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'GUARDS_BULK_IMPORTED' },
    query: z.object({ preview: z.enum(['true', 'false']).default('true') }),
    body: guardImportRequestSchema,
    responses: { 200: guardImportResponseSchema },
    handler: async ({ deps, ctx, body, query }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const preview = query.preview === 'true';
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const plan = await planImport(trx, org.id, body.csv);
        // All or nothing: one invalid row and nothing is created.
        if (preview || plan.errors.length > 0) {
          return {
            preview,
            total: plan.total,
            valid: plan.rows.length,
            created: 0,
            errors: plan.errors.slice(0, 500),
          };
        }
        const now = deps.clock.now();
        for (const row of plan.rows) {
          await insertGuard(trx, {
            ...row,
            id: uuidv7(deps.clock),
            organizationId: org.id,
            userId: actor.userId,
            now,
          });
        }
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'GUARDS_BULK_IMPORTED',
          resourceType: 'guard',
          resourceId: null,
          metadata: { count: plan.rows.length },
        });
        return { preview, total: plan.total, valid: plan.rows.length, created: plan.rows.length, errors: [] };
      });
    },
  }),

  defineRoute({
    method: 'GET',
    url: '/api/v1/guards/:id',
    summary: 'One guard.',
    policy: { access: READ, ownership: 'organization', rateLimit: 'default', audit: null },
    params: z.object({ id: z.uuid() }),
    responses: { 200: guardSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      const guard = await withTenantTransaction(deps.db, org.id, (trx) => getGuard(trx, org.id, params.id));
      if (!guard) throw notFound();
      return guardDto(guard);
    },
  }),

  defineRoute({
    method: 'PATCH',
    url: '/api/v1/guards/:id',
    summary: "Edits a guard's details or status (ACTIVE, INACTIVE, SUSPENDED).",
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'GUARD_UPDATED' },
    params: z.object({ id: z.uuid() }),
    body: guardPatchRequestSchema,
    responses: { 200: guardSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params, body }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const now = deps.clock.now();
      try {
        return await withTenantTransaction(deps.db, org.id, async (trx) => {
          const guard = await getGuard(trx, org.id, params.id, { forUpdate: true });
          if (!guard || guard.status === 'TERMINATED') throw notFound();
          const { version, ...changes } = body;
          if (
            !(await updateGuard(trx, {
              organizationId: org.id,
              id: guard.id,
              version,
              userId: actor.userId,
              now,
              changes,
            }))
          ) {
            throw new AppError(
              'VERSION_CONFLICT',
              'This guard was changed by someone else.',
              undefined,
              undefined,
              guardDto(guard),
            );
          }
          if (changes.status && changes.status !== 'ACTIVE' && guard.status === 'ACTIVE') {
            await revokeGuardSessions(trx, org.id, guard.id, 'GUARD_DISABLED', now);
            await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
              action: 'GUARD_DISABLED',
              resourceType: 'guard',
              resourceId: guard.id,
              metadata: { status: changes.status },
            });
          }
          const fields = Object.keys(changes).filter((k) => k !== 'status');
          if (fields.length > 0) {
            // Field names only: the values may be phone numbers (SEC §17.2).
            await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
              action: 'GUARD_UPDATED',
              resourceType: 'guard',
              resourceId: guard.id,
              metadata: { fields },
            });
          }
          const updated = await getGuard(trx, org.id, guard.id);
          if (!updated) throw notFound();
          return guardDto(updated);
        });
      } catch (error) {
        throw conflictMessage(error) ?? error;
      }
    },
  }),

  defineRoute({
    method: 'POST',
    url: '/api/v1/guards/:id/terminate',
    summary: 'Terminates a guard: sessions end, the phone is retired, the record is kept.',
    policy: { access: WRITE, ownership: 'organization', rateLimit: 'default', audit: 'GUARD_TERMINATED' },
    params: z.object({ id: z.uuid() }),
    responses: { 200: guardSchema, 404: errorEnvelopeSchema },
    handler: async ({ deps, ctx, params }) => {
      const org = orgOf(ctx);
      const actor = userOf(ctx);
      const now = deps.clock.now();
      return withTenantTransaction(deps.db, org.id, async (trx) => {
        const guard = await getGuard(trx, org.id, params.id, { forUpdate: true });
        if (!guard || guard.status === 'TERMINATED') throw notFound();
        await updateGuard(trx, {
          organizationId: org.id,
          id: guard.id,
          version: guard.version,
          userId: actor.userId,
          now,
          changes: { status: 'TERMINATED' },
        });
        const device = await activeDevice(trx, org.id, guard.id);
        if (device) {
          await revokeDevice(trx, {
            organizationId: org.id,
            deviceId: device.id,
            reason: 'ADMIN',
            userId: actor.userId,
            now,
          });
        }
        await revokeGuardSessions(trx, org.id, guard.id, 'GUARD_DISABLED', now);
        await recordAudit(trx, deps.clock, org.id, auditActor(ctx), {
          action: 'GUARD_TERMINATED',
          resourceType: 'guard',
          resourceId: guard.id,
        });
        const updated = await getGuard(trx, org.id, guard.id);
        if (!updated) throw notFound();
        return guardDto(updated);
      });
    },
  }),
];
