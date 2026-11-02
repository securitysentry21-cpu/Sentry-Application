// The Phase 8 jobs (ARCH §16.2): escalation every 15 s, the notification sender, the attachment
// processor, and the operator check for SOS left unacknowledged (ARCH §18.4). Like the detectors,
// the sweeps only enumerate organizations with due work, as system_worker; each organization's work
// runs in its own tenant transaction as app_runtime.
import { withTenantTransaction } from '@sentryops/db';

import { alertsDueEscalation, organizationsWithEscalationsDue } from '../repositories/alerts.ts';
import { attachmentsToProcess, organizationsWithAttachmentsToProcess } from '../repositories/incidents.ts';
import { organizationsWithDueDeliveries } from '../repositories/notifications.ts';
import { organizationsWithStaleSos } from '../repositories/sos.ts';
import { organizationsWithShiftsStartingBefore } from '../repositories/sweeps.ts';
import { processAttachment } from '../services/attachments.ts';
import { queueShiftReminders } from '../services/guard-notices.ts';
import {
  claimDue,
  escalateDue,
  recordSend,
  sendOne,
  sendTarget,
  type SendOutcome,
} from '../services/notifications.ts';
import type { DetectorDeps } from './detectors.ts';

/** ARCH §18.4: an SOS still unacknowledged after this is an operator alarm (check delivery health). */
export const SOS_UNACKNOWLEDGED_ALARM_MS = 10 * 60_000;

export async function runEscalation(deps: DetectorDeps): Promise<{ escalated: number }> {
  const now = deps.clock.now();
  let escalated = 0;
  for (const organizationId of await organizationsWithEscalationsDue(deps.sweep, now)) {
    escalated += await withTenantTransaction(deps.db, organizationId, async (trx) =>
      escalateDue(trx, deps, organizationId, await alertsDueEscalation(trx, organizationId, now)),
    );
  }
  return { escalated };
}

/**
 * Sends what is due: claims a batch in one short transaction, calls the providers outside it, and
 * records each result in another, so a slow provider never holds a database transaction open.
 */
export async function runSender(deps: DetectorDeps): Promise<{ sent: number; failures: SendOutcome[] }> {
  let sent = 0;
  const failures: SendOutcome[] = [];
  for (const organizationId of await organizationsWithDueDeliveries(deps.sweep, deps.clock.now())) {
    const claimed = await withTenantTransaction(deps.db, organizationId, async (trx) => {
      const rows = await claimDue(trx, deps, organizationId);
      return Promise.all(
        rows.map(async (d) => ({ d, target: await sendTarget(trx, deps, organizationId, d) })),
      );
    });
    for (const { d, target } of claimed) {
      const result = await sendOne(deps, organizationId, d, target);
      const outcome = await withTenantTransaction(deps.db, organizationId, (trx) =>
        recordSend(trx, deps, organizationId, d, result),
      );
      deps.metrics.increment(
        `notification_${outcome.ok ? 'sent' : 'failed'}_${outcome.channel.toLowerCase()}`,
      );
      if (outcome.ok) sent++;
      else failures.push(outcome);
    }
  }
  return { sent, failures };
}

export async function runAttachmentProcessor(deps: DetectorDeps): Promise<{ processed: number }> {
  let processed = 0;
  for (const organizationId of await organizationsWithAttachmentsToProcess(deps.sweep)) {
    // One photo per transaction, its row locked while it is checked.
    for (;;) {
      const done = await withTenantTransaction(deps.db, organizationId, async (trx) => {
        const [next] = await attachmentsToProcess(trx, organizationId, 1);
        if (!next) return false;
        await processAttachment(trx, deps, organizationId, next);
        return true;
      });
      if (!done) break;
      processed++;
    }
  }
  return { processed };
}

/** Organizations with a real SOS unacknowledged for 10 minutes; the worker logs them for the alarm. */
export async function staleSosOrganizations(deps: DetectorDeps): Promise<string[]> {
  return organizationsWithStaleSos(
    deps.sweep,
    new Date(deps.clock.now().getTime() - SOS_UNACKNOWLEDGED_ALARM_MS),
  );
}

/** The longest reminder an organization may set (PROD App. B `shift.reminder_minutes_before`). */
const MAX_REMINDER_MS = 240 * 60_000;

/** Shift reminders (PROD §13), once per shift; runs with the detectors every minute. */
export async function runShiftReminders(deps: DetectorDeps): Promise<{ queued: number }> {
  const now = deps.clock.now();
  let queued = 0;
  for (const organizationId of await organizationsWithShiftsStartingBefore(
    deps.sweep,
    now,
    new Date(now.getTime() + MAX_REMINDER_MS),
    500,
  )) {
    queued += await withTenantTransaction(deps.db, organizationId, (trx) =>
      queueShiftReminders(trx, deps, organizationId),
    );
  }
  return { queued };
}
