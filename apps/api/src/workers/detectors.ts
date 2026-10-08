// Shift detectors (ARCH §16.2, PROD §6.6–§6.7), every 60 seconds:
//   SCHEDULED past its start deadline → MISSED;  ACTIVE past end + auto_end_after → COMPLETED.
// The sweep only enumerates due work across organizations, as system_worker (read-only policy on a
// few columns). Each change then runs in that organization's own tenant transaction as app_runtime,
// through the shared state machine (ARCH §4.5, ADV-T07). Missed runs are harmless: the conditions
// compare with now, so the next run catches up.
import { withTenantTransaction, type Database } from '@sentryops/db';

import type { AppDeps } from '../deps.ts';
import { dueShifts, type DueShift } from '../repositories/sweeps.ts';
import { systemTransition } from '../services/shifts.ts';

export type DetectorDeps = AppDeps & { readonly sweep: Database };

/** The minimum auto-end delay any organization may set (PROD App. B: 15–240 min). */
const MIN_AUTO_END_MS = 15 * 60_000;
const BATCH = 500;

/** Applies due transitions for one organization; a shift of another organization is never touched. */
export async function applyForOrganization(
  deps: AppDeps,
  organizationId: string,
  due: readonly DueShift[],
): Promise<number> {
  return withTenantTransaction(deps.db, organizationId, async (trx) => {
    let changed = 0;
    for (const item of due) {
      if (await systemTransition(trx, deps, organizationId, item.id, { type: item.kind })) changed++;
    }
    return changed;
  });
}

export async function runShiftDetectors(deps: DetectorDeps): Promise<{ examined: number; changed: number }> {
  const now = deps.clock.now();
  const due = await dueShifts(deps.sweep, now, new Date(now.getTime() - MIN_AUTO_END_MS), BATCH);
  const byOrganization = new Map<string, DueShift[]>();
  for (const item of due) {
    byOrganization.set(item.organization_id, [...(byOrganization.get(item.organization_id) ?? []), item]);
  }
  let changed = 0;
  for (const [organizationId, items] of byOrganization) {
    changed += await applyForOrganization(deps, organizationId, items);
  }
  return { examined: due.length, changed };
}
