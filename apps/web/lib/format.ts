import type { Alert } from '@sentryops/contracts';

// Times are shown in the organization's time zone (sites carry their own from Phase 2).
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

export const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Administrator',
  SUPERVISOR: 'Supervisor',
  DISPATCHER: 'Dispatcher',
  GUARD: 'Guard',
};

/** Short names for alert types (PROD §12.1), for badges and lists. */
export const ALERT_TYPE_LABEL: Record<Alert['type'], string> = {
  SOS_ACTIVATED: 'SOS',
  INCIDENT_CRITICAL: 'Critical incident',
  INCIDENT_HIGH: 'High incident',
  GUARD_LEFT_SITE: 'Left site',
  TRACKING_DISABLED: 'Tracking disabled',
  DEVICE_OFFLINE: 'Device offline',
  LOCATION_STALE: 'Location stale',
  SHIFT_NOT_STARTED: 'Shift not started',
  SHIFT_MISSED: 'Shift missed',
  CHECKPOINT_MISSED: 'Checkpoint missed',
  SUSPICIOUS_LOCATION: 'Suspicious location',
  STARTED_OFF_SITE: 'Started off site',
  SHIFT_OVERRUN: 'Shift not ended',
  LOW_BATTERY: 'Low battery',
  DEVICE_CHANGED: 'Device changed',
};

/** A short age for map labels: "8 s", "4 min", "2 h" (PROD §8.3: every marker carries its age). */
export function shortAge(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

/** A site-bound time in the site's own time zone, with its abbreviation (PROD §14.7). */
export function siteTime(iso: string, timeZone: string, withZone = true): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    ...(withZone ? { timeZoneName: 'short' as const } : {}),
  }).format(new Date(iso));
}

/** Tracking service states as words. */
export const SERVICE_LABEL: Record<string, string> = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  PERMISSION_PROBLEM: 'permission problem',
  UNKNOWN: 'not reported',
};
