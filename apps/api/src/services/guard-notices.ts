// Push notices to guards about their shifts (PROD §13: assigned, changed, cancelled, reminder; D-26).
// Lock-screen safe: the site and the times, in the guard's language; nothing else. Queued in the
// transaction that made the change; the sender delivers them once the phone has a Firebase token.
import type { Database } from '@sentryops/db';

import type { AppDeps } from '../deps.ts';
import { getGuard } from '../repositories/guards.ts';
import { numberSetting, organizationSettings } from '../repositories/organizations.ts';
import { getShift, scheduledShiftsStartingBetween, type ShiftRow } from '../repositories/shifts.ts';
import { queueGuardPush } from './notifications.ts';

export type ShiftNotice = 'ASSIGNED' | 'CHANGED' | 'CANCELLED' | 'REMINDER';

const TITLES: Readonly<Record<ShiftNotice, { en: string; ur: string }>> = {
  ASSIGNED: { en: 'New shift', ur: 'نئی شفٹ' },
  CHANGED: { en: 'Shift changed', ur: 'شفٹ میں تبدیلی' },
  CANCELLED: { en: 'Shift cancelled', ur: 'شفٹ منسوخ' },
  REMINDER: { en: 'Your shift starts soon', ur: 'آپ کی شفٹ جلد شروع ہو رہی ہے' },
};

function when(shift: ShiftRow): string {
  const format = (d: Date, withDay: boolean) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: shift.siteTimezone,
      ...(withDay ? { day: 'numeric', month: 'short' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d);
  return `${format(shift.startsAt, true)}–${format(shift.endsAt, false)}`;
}

export async function noticeShift(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
  shift: ShiftRow,
  notice: ShiftNotice,
  guardId: string = shift.guardId,
): Promise<void> {
  const guard = await getGuard(trx, organizationId, guardId);
  if (!guard || guard.status !== 'ACTIVE') return;
  const title = TITLES[notice][guard.preferredLocale];
  await queueGuardPush(trx, deps, organizationId, guardId, {
    topic: 'SHIFT',
    title,
    body: `${shift.siteName} · ${when(shift)}`.slice(0, 200),
    // A reminder once per shift; any other notice once per change.
    dedupeKey:
      notice === 'REMINDER'
        ? `shift:${shift.id}:reminder`
        : `shift:${shift.id}:${notice}:${guardId}:${shift.version}`,
  });
}

/** PROD App. B `shift.reminder_minutes_before`: one reminder per scheduled shift (0 = off). */
export async function queueShiftReminders(
  trx: Database,
  deps: AppDeps,
  organizationId: string,
): Promise<number> {
  const settings = await organizationSettings(trx, organizationId);
  const minutes = numberSetting(settings, 'shift.reminder_minutes_before', 30);
  if (minutes <= 0) return 0;
  const now = deps.clock.now();
  const due = await scheduledShiftsStartingBetween(
    trx,
    organizationId,
    now,
    new Date(now.getTime() + minutes * 60_000),
  );
  for (const id of due) {
    const shift = await getShift(trx, organizationId, id);
    if (shift) await noticeShift(trx, deps, organizationId, shift, 'REMINDER');
  }
  return due.length;
}
