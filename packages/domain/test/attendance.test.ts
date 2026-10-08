import { describe, expect, it } from 'vitest';

import { attendance, csvCell } from '../src/attendance.ts';

const base = {
  status: 'COMPLETED',
  startsAt: new Date('2026-10-05T15:00:00Z'),
  endsAt: new Date('2026-10-05T23:00:00Z'),
  actualStartedAt: new Date('2026-10-05T14:50:00Z'),
  actualEndedAt: new Date('2026-10-05T23:20:00Z'),
  startSource: 'APP_ONLINE',
  startGeofenceClass: 'INSIDE',
  startFlags: [] as string[],
  endReason: 'GUARD',
};

describe('attendance (PROD §6.8)', () => {
  it('early arrival and staying late are never negative lateness or early leave', () => {
    expect(attendance(base)).toEqual({ lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: 510, flags: [] });
  });

  it('not started or not ended leaves the figures empty, never zero', () => {
    expect(
      attendance({ ...base, status: 'MISSED', actualStartedAt: null, actualEndedAt: null }),
    ).toMatchObject({
      lateMinutes: null,
      earlyLeaveMinutes: null,
      workedMinutes: null,
    });
  });

  it('flags every record kind PROD §6.8 lists', () => {
    expect(
      attendance({
        ...base,
        startSource: 'SUPERVISOR_MANUAL',
        startGeofenceClass: 'OUTSIDE',
        startFlags: ['LOW_ACCURACY_START'],
        endReason: 'AUTO_TIMEOUT',
      }).flags,
    ).toEqual(['MANUAL_START', 'AUTO_ENDED', 'OFF_SITE_START', 'LOW_ACCURACY_START']);
    expect(
      attendance({ ...base, startSource: 'APP_OFFLINE_SYNCED', endReason: 'SUPERVISOR_FORCE_END' }).flags,
    ).toEqual(['OFFLINE_START', 'FORCE_ENDED']);
  });
});

describe('CSV cells (SEC §8)', () => {
  it('neutralises formulas and quotes what needs quoting', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('+92300')).toBe(`"'+92300"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('@cmd')).toBe(`"'@cmd"`);
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell('احمد خان')).toBe('احمد خان');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
});
