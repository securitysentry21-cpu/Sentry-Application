// Retention (SEC §16.5, PROD Appendix B), pure: when the daily run is due and what it may delete.
// Owner decisions 2026-11-02: operational records go 12 months after they closed, never while open;
// positions on records follow the location period, except evidence on incidents and SOS.
import { localDate, localToUtc } from './time.ts';

export type RetentionSettings = {
  readonly locationDays: number; // retention.location_days (90)
  readonly deviceStatusDays: number; // retention.device_status_days (30)
  readonly operationalMonths: number; // retention.operational_months (12)
  readonly auditMonths: number; // retention.audit_months (24)
  readonly evidenceWindowMinutes: number; // retention.incident_evidence_window_minutes (30)
};

/** Raw sync items that failed (ARCH §9.3): short retention, never longer than location. */
export const QUARANTINE_DAYS = 30;

/** ARCH §16: the run is due daily from this local time. */
export const RETENTION_LOCAL_TIME = '03:00';

const DAY_MS = 86_400_000;

/** The same day and time `months` calendar months earlier (the 31st falls back to the month's end). */
export function monthsBefore(at: Date, months: number): Date {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(at.getUTCDate(), lastDay),
      at.getUTCHours(),
      at.getUTCMinutes(),
      at.getUTCSeconds(),
      at.getUTCMilliseconds(),
    ),
  );
}

export type RetentionCutoffs = {
  /** Track points captured before this go, unless they are evidence. */
  readonly location: Date;
  readonly deviceStatus: Date;
  /** Records that closed before this go (a shift's end, a resolution, a closed round). */
  readonly operational: Date;
  readonly audit: Date;
  readonly quarantine: Date;
};

export function retentionCutoffs(now: Date, s: RetentionSettings): RetentionCutoffs {
  return {
    location: new Date(now.getTime() - s.locationDays * DAY_MS),
    deviceStatus: new Date(now.getTime() - s.deviceStatusDays * DAY_MS),
    operational: monthsBefore(now, s.operationalMonths),
    audit: monthsBefore(now, s.auditMonths),
    quarantine: new Date(now.getTime() - Math.min(QUARANTINE_DAYS, s.locationDays) * DAY_MS),
  };
}

/**
 * Due once a day from 03:00 in the organization's time zone (ARCH §16): due when it is past 03:00
 * locally and the last run (if any) was before today's 03:00. A run that failed half-way is due
 * again; every step is safe to repeat.
 */
export function retentionDue(now: Date, timeZone: string, lastRunAt: Date | null): boolean {
  const todayAt = localToUtc(localDate(now, timeZone), RETENTION_LOCAL_TIME, timeZone);
  if (now.getTime() < todayAt.getTime()) return false;
  return lastRunAt === null || lastRunAt.getTime() < todayAt.getTime();
}

/** SEC §16.5: the evidence window around an incident or an SOS, in milliseconds either side. */
export function evidenceWindowMs(s: Pick<RetentionSettings, 'evidenceWindowMinutes'>): number {
  return s.evidenceWindowMinutes * 60_000;
}
