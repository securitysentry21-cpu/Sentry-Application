// GET /audit-logs (SEC §17): the organization's own audit log, newest first, owners only.
import {
  AUDIT_ACTIONS,
  auditLogListResponseSchema,
  auditLogQuerySchema,
  type AuditAction,
} from '@sentryops/contracts';
import { withTenantTransaction } from '@sentryops/db';

import { orgOf } from '../context.ts';
import { AppError } from '../errors.ts';
import { listAudit } from '../repositories/audit.ts';
import { defineRoute } from './registry.ts';

const ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof value.t !== 'string' || typeof value.i !== 'string') throw new Error('shape');
    const createdAt = new Date(value.t);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/.test(value.i)) throw new Error('value');
    return { createdAt, id: value.i };
  } catch {
    throw new AppError('VALIDATION_FAILED', 'The cursor is invalid.', [{ path: 'cursor', issue: 'invalid' }]);
  }
}

const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(JSON.stringify({ t: createdAt.toISOString(), i: id })).toString('base64url');

export const auditLogRoutes = [
  defineRoute({
    method: 'GET',
    url: '/api/v1/audit-logs',
    summary: "The organization's audit log, newest first.",
    policy: {
      access: { kind: 'permission', permission: 'audit.read' },
      ownership: 'organization',
      rateLimit: 'default',
      audit: null,
    },
    query: auditLogQuerySchema,
    responses: { 200: auditLogListResponseSchema },
    handler: async ({ deps, ctx, query }) => {
      const org = orgOf(ctx);
      const before = query.cursor ? decodeCursor(query.cursor) : undefined;
      const rows = await withTenantTransaction(deps.db, org.id, (trx) =>
        listAudit(trx, org.id, { limit: query.limit + 1, ...(before ? { before } : {}) }),
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        entries: page
          .filter((r) => ACTIONS.has(r.action))
          .map((r) => ({
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            actorType: r.actorType as 'USER' | 'SYSTEM' | 'PLATFORM_OPERATOR',
            actorName: r.actorName,
            action: r.action as AuditAction,
            resourceType: r.resourceType,
            resourceId: r.resourceId,
            reason: r.reason,
            metadata: (r.metadata ?? {}) as Record<string, unknown>,
          })),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },
  }),
];
