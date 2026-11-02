import { describe, expect, it } from 'vitest';

import { monthsBefore, retentionCutoffs, retentionDue } from '../src/retention.ts';

const SETTINGS = {
  locationDays: 90,
  deviceStatusDays: 30,
  operationalMonths: 12,
  auditMonths: 24,
  evidenceWindowMinutes: 30,
};

describe('retention cut-offs (SEC §16.5)', () => {
  it('location and device status by days, records and audit by calendar months, quarantine 30 days', () => {
    const now = new Date('2026-11-02T22:00:00.000Z');
    const c = retentionCutoffs(now, SETTINGS);
    expect(c.location.toISOString()).toBe('2026-08-04T22:00:00.000Z');
    expect(c.deviceStatus.toISOString()).toBe('2026-10-03T22:00:00.000Z');
    expect(c.operational.toISOString()).toBe('2025-11-02T22:00:00.000Z');
    expect(c.audit.toISOString()).toBe('2024-11-02T22:00:00.000Z');
    expect(c.quarantine.toISOString()).toBe('2026-10-03T22:00:00.000Z');
    // Quarantined items never outlive location.
    expect(retentionCutoffs(now, { ...SETTINGS, locationDays: 7 }).quarantine).toEqual(
      retentionCutoffs(now, { ...SETTINGS, locationDays: 7 }).location,
    );
  });

  it('a month back from the 31st lands on the last day of the shorter month', () => {
    expect(monthsBefore(new Date('2026-03-31T10:00:00.000Z'), 1).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(monthsBefore(new Date('2026-01-15T00:00:00.000Z'), 12).toISOString()).toBe(
      '2025-01-15T00:00:00.000Z',
    );
  });
});

describe('when the daily run is due (ARCH §16: 03:00 organization time)', () => {
  it('due once a day from 03:00 local; not before; not twice; again after a run that did not finish', () => {
    // 03:00 in Karachi (UTC+5) is 22:00 UTC the day before.
    const before = new Date('2026-11-01T21:59:00.000Z');
    const after = new Date('2026-11-01T22:01:00.000Z');
    expect(retentionDue(before, 'Asia/Karachi', null)).toBe(false);
    expect(retentionDue(after, 'Asia/Karachi', null)).toBe(true);
    expect(retentionDue(after, 'Asia/Karachi', new Date('2026-11-01T22:00:30.000Z'))).toBe(false);
    // Yesterday's run doesn't count for today.
    expect(retentionDue(after, 'Asia/Karachi', new Date('2026-10-31T22:05:00.000Z'))).toBe(true);
  });
});
