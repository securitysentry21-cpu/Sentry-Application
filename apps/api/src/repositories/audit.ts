// Audit service (SEC §17, INV-14): one row per security-sensitive action, written in the same
// transaction as the action, so the action cannot happen without its record. Tokens, codes and
// phone numbers never go into metadata (SEC §15).
import type { AuditAction } from '@sentryops/contracts';
import type { Database } from '@sentryops/db';
import type { Clock } from '@sentryops/domain';

import { uuidv7 } from '../ids.ts';

export type AuditActor = {
  readonly type: 'USER' | 'SYSTEM' | 'PLATFORM_OPERATOR';
  readonly userId: string | null;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
};

export type AuditEntry = {
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly reason?: string | null;
  readonly metadata?: Record<string, unknown>;
};

export async function recordAudit(
  trx: Database,
  clock: Clock,
  organizationId: string,
  actor: AuditActor,
  entry: AuditEntry,
): Promise<void> {
  await trx
    .insertInto('audit_logs')
    .values({
      id: uuidv7(clock),
      organization_id: organizationId,
      actor_type: actor.type,
      actor_user_id: actor.userId,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId,
      reason: entry.reason ?? null,
      request_id: actor.requestId,
      ip_address: actor.ip,
      user_agent: actor.userAgent?.slice(0, 500) ?? null,
      metadata: JSON.stringify(entry.metadata ?? {}),
      created_at: clock.now(),
    })
    .execute();
}

export type AuditListEntry = {
  readonly id: string;
  readonly createdAt: Date;
  readonly actorType: string;
  readonly actorName: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly reason: string | null;
  readonly metadata: unknown;
};

/** Newest first; keyset pagination on (created_at, id). */
export async function listAudit(
  trx: Database,
  organizationId: string,
  options: { limit: number; before?: { createdAt: Date; id: string } },
): Promise<AuditListEntry[]> {
  let query = trx
    .selectFrom('audit_logs as a')
    .leftJoin('users as u', 'u.id', 'a.actor_user_id')
    .select([
      'a.id',
      'a.created_at',
      'a.actor_type',
      'u.name as actor_name',
      'a.action',
      'a.resource_type',
      'a.resource_id',
      'a.reason',
      'a.metadata',
    ])
    .where('a.organization_id', '=', organizationId)
    .orderBy('a.created_at', 'desc')
    .orderBy('a.id', 'desc')
    .limit(options.limit);
  const before = options.before;
  if (before) {
    query = query.where((eb) =>
      eb.or([
        eb('a.created_at', '<', before.createdAt),
        eb.and([eb('a.created_at', '=', before.createdAt), eb('a.id', '<', before.id)]),
      ]),
    );
  }
  const rows = await query.execute();
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    actorType: r.actor_type,
    actorName: r.actor_name,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    reason: r.reason,
    metadata: r.metadata,
  }));
}
