import { describe, expect, it } from 'vitest';

import {
  guardSosPhase,
  isValidLadder,
  plainLine,
  shortName,
  sosDrillFor,
  sosNotificationText,
  sosSmsText,
  stepActions,
  stepDueAt,
  stepDueAtS,
  type DrillWindow,
  type EscalationLadder,
} from '../src/sos.ts';

/** PROD §11.4's default ladder (PROD App. B `sos.escalation`). */
const LADDER: EscalationLadder = {
  steps: [
    {
      atSeconds: 0,
      dashboardAlarm: true,
      webPushTo: ['SUPERVISOR', 'DISPATCHER', 'ADMIN'],
      smsTo: ['SUPERVISOR'],
      smsEmergencyContacts: false,
    },
    {
      atSeconds: 60,
      dashboardAlarm: true,
      webPushTo: ['SUPERVISOR', 'DISPATCHER', 'ADMIN'],
      smsTo: ['ADMIN'],
      smsEmergencyContacts: false,
    },
    {
      atSeconds: 180,
      dashboardAlarm: true,
      webPushTo: ['OWNER'],
      smsTo: ['OWNER'],
      smsEmergencyContacts: true,
    },
  ],
  repeatEverySeconds: 120,
};

describe('escalation ladder (PROD §11.4)', () => {
  it('ADV-S06 steps are due at 0, 60 and 180 s, then every 120 s', () => {
    expect([0, 1, 2, 3, 4, 5].map((level) => stepDueAtS(LADDER, level))).toEqual([0, 60, 180, 300, 420, 540]);
    const start = new Date('2026-11-02T10:00:00.000Z');
    expect(stepDueAt(LADDER, start, 3).toISOString()).toBe('2026-11-02T10:05:00.000Z');
  });

  it('each step sends its own actions; a repeat sends to everyone reached so far', () => {
    expect(stepActions(LADDER, 0)).toMatchObject({
      smsTo: ['SUPERVISOR'],
      smsEmergencyContacts: false,
      repeat: false,
    });
    expect(stepActions(LADDER, 1)).toMatchObject({ smsTo: ['ADMIN'], repeat: false });
    const repeat = stepActions(LADDER, 3);
    expect(repeat.repeat).toBe(true);
    expect([...repeat.smsTo].sort()).toEqual(['ADMIN', 'OWNER', 'SUPERVISOR']);
    expect([...repeat.webPushTo].sort()).toEqual(['ADMIN', 'DISPATCHER', 'OWNER', 'SUPERVISOR']);
    expect(repeat.smsEmergencyContacts).toBe(true);
  });

  it('a ladder must start at 0 s and increase', () => {
    expect(isValidLadder(LADDER)).toBe(true);
    const first = LADDER.steps[0];
    const second = LADDER.steps[1];
    if (!first || !second) throw new Error('ladder');
    expect(isValidLadder({ ...LADDER, steps: [{ ...first, atSeconds: 10 }] })).toBe(false);
    expect(isValidLadder({ ...LADDER, steps: [first, { ...second, atSeconds: 0 }] })).toBe(false);
    expect(isValidLadder({ ...LADDER, steps: [] })).toBe(false);
  });
});

describe("the guard's SOS phase (PROD §11.3, INV-10)", () => {
  const base = { status: 'ACTIVE' as const, alertSentTo: 0, shownOnDashboards: 0, reachedPhones: 0 };

  it('ADV-S01 a provider accepting a message is ALERT_SENT, never NOTIFIED', () => {
    expect(guardSosPhase(base)).toBe('RECEIVED');
    expect(guardSosPhase({ ...base, alertSentTo: 4 })).toBe('ALERT_SENT');
  });

  it('ADV-S01 NOTIFIED needs a display receipt or a delivery receipt', () => {
    expect(guardSosPhase({ ...base, alertSentTo: 4, shownOnDashboards: 1 })).toBe('NOTIFIED');
    expect(guardSosPhase({ ...base, reachedPhones: 2 })).toBe('NOTIFIED');
  });

  it('acknowledged and resolved come from a person', () => {
    expect(guardSosPhase({ ...base, status: 'ACKNOWLEDGED' })).toBe('ACKNOWLEDGED');
    expect(guardSosPhase({ ...base, status: 'RESOLVED', shownOnDashboards: 3 })).toBe('RESOLVED');
  });
});

describe('drills (PROD §11.10, ADV-S10)', () => {
  const at = new Date('2026-11-02T10:30:00.000Z');
  const drill: DrillWindow = {
    id: 'drill-1',
    startedAt: new Date('2026-11-02T10:00:00.000Z'),
    endsAt: new Date('2026-11-02T11:00:00.000Z'),
    endedAt: null,
    guardIds: ['guard-in-drill'],
  };

  it('ADV-S10 only the guards a drill names are in it; anyone else is real', () => {
    expect(sosDrillFor('CUSTOMER', [drill], 'guard-in-drill', at)).toEqual({
      isDrill: true,
      drillId: 'drill-1',
    });
    expect(sosDrillFor('CUSTOMER', [drill], 'other-guard', at)).toEqual({ isDrill: false, drillId: null });
  });

  it('a drill counts only inside its window', () => {
    expect(
      sosDrillFor('CUSTOMER', [drill], 'guard-in-drill', new Date('2026-11-02T11:00:00.000Z')).isDrill,
    ).toBe(false);
    const ended = { ...drill, endedAt: new Date('2026-11-02T10:10:00.000Z') };
    expect(sosDrillFor('CUSTOMER', [ended], 'guard-in-drill', at).isDrill).toBe(false);
  });

  it('ADV-S10 every SOS in a demo or canary organization is a drill', () => {
    expect(sosDrillFor('DEMO', [], 'anyone', at)).toEqual({ isDrill: true, drillId: null });
    expect(sosDrillFor('CANARY', [], 'anyone', at)).toEqual({ isDrill: true, drillId: null });
  });
});

describe('notification text (PROD §13)', () => {
  it('is lock-screen safe: a short name and the site, marked for drills', () => {
    expect(shortName('Ahmed Khan')).toBe('Ahmed K.');
    expect(shortName('Bilal')).toBe('Bilal');
    expect(
      sosNotificationText({ guardName: 'Ahmed Khan', siteName: 'ABC Warehouse', drill: false }).title,
    ).toBe('SOS — Ahmed K. — ABC Warehouse');
    expect(sosNotificationText({ guardName: 'Ahmed Khan', siteName: null, drill: true }).title).toBe(
      '[DRILL] SOS — Ahmed K. — off shift',
    );
  });

  it('a name can never break a message into lines', () => {
    expect(plainLine('Ahmed\r\nKhan\u0007', 40)).toBe('Ahmed Khan');
  });

  it('a text carries coordinates only when the organization turned them on', () => {
    const text = sosNotificationText({ guardName: 'Ahmed Khan', siteName: 'ABC Warehouse', drill: false });
    const link = 'https://dashboard.example/alerts?id=1';
    expect(sosSmsText({ text, link, position: null })).toBe(`SOS — Ahmed K. — ABC Warehouse. ${link}`);
    expect(sosSmsText({ text, link, position: { lat: 31.520123, lng: 74.351234 } })).toContain(
      'Location 31.52012,74.35123.',
    );
  });
});
