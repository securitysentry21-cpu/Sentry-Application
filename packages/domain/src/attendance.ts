// Attendance definitions (PROD §6.8), as pure functions over a shift record.

export type AttendanceInput = {
  readonly status: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly actualStartedAt: Date | null;
  readonly actualEndedAt: Date | null;
  readonly startSource: string | null;
  readonly startGeofenceClass: string | null;
  readonly startFlags: readonly string[];
  readonly endReason: string | null;
};

export const ATTENDANCE_FLAGS = [
  'OFFLINE_START',
  'MANUAL_START',
  'AUTO_ENDED',
  'FORCE_ENDED',
  'OFF_SITE_START',
  'LOW_ACCURACY_START',
] as const;
export type AttendanceFlag = (typeof ATTENDANCE_FLAGS)[number];

export type AttendanceFigures = {
  /** max(0, actual start − scheduled start); null until started. */
  readonly lateMinutes: number | null;
  /** max(0, scheduled end − actual end); null until ended. */
  readonly earlyLeaveMinutes: number | null;
  /** actual end − actual start; null until ended. */
  readonly workedMinutes: number | null;
  readonly flags: AttendanceFlag[];
};

const minutes = (ms: number) => Math.round(ms / 60_000);

export function attendance(s: AttendanceInput): AttendanceFigures {
  const flags: AttendanceFlag[] = [];
  if (s.startSource === 'APP_OFFLINE_SYNCED') flags.push('OFFLINE_START');
  if (s.startSource === 'SUPERVISOR_MANUAL') flags.push('MANUAL_START');
  if (s.endReason === 'AUTO_TIMEOUT') flags.push('AUTO_ENDED');
  if (s.endReason === 'SUPERVISOR_FORCE_END' || s.endReason === 'GUARD_DISABLED') flags.push('FORCE_ENDED');
  if (s.startGeofenceClass === 'OUTSIDE' || s.startFlags.includes('OFF_SITE_START'))
    flags.push('OFF_SITE_START');
  if (s.startFlags.includes('LOW_ACCURACY_START')) flags.push('LOW_ACCURACY_START');
  const started = s.actualStartedAt;
  const ended = s.actualEndedAt;
  return {
    lateMinutes: started ? Math.max(0, minutes(started.getTime() - s.startsAt.getTime())) : null,
    earlyLeaveMinutes: ended ? Math.max(0, minutes(s.endsAt.getTime() - ended.getTime())) : null,
    workedMinutes: started && ended ? Math.max(0, minutes(ended.getTime() - started.getTime())) : null,
    flags,
  };
}

/**
 * One CSV cell (SEC §8): quoted, quotes doubled, and a leading = + - @ tab or carriage return
 * neutralised so a spreadsheet never runs it as a formula.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r']/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text;
}
