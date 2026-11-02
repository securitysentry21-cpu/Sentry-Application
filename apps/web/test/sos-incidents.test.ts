// SOS and incidents in words, and the checks the dashboard makes before the server does: the SOS
// settings' ladder and phone numbers (PROD §11.4, Appendix B), an incident's occurred time (PROD
// §10.1), the honest progress of an SOS (PROD §11.3), and the trail's breaks (PROD §14.5).
import type { IncidentEvent, SosDetail } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import { readLadder, sosChange, sosProblems, stepWords } from '../components/sos-settings';
import { eventText, occurredAtProblem, rejectionText } from '../lib/incidents';
import {
  ladderProblems,
  MEMBER_PHONE,
  normalizePhone,
  SETTING_PHONE,
  sosProgress,
  telHref,
  trailSegments,
  type Ladder,
} from '../lib/sos';

/** Appendix B's default ladder. */
const DEFAULT_LADDER: Ladder = {
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

describe('the SOS settings form (PROD §11.4)', () => {
  it('accepts the default ladder and refuses what the server refuses', () => {
    expect(ladderProblems(DEFAULT_LADDER)).toEqual([]);
    const step = DEFAULT_LADDER.steps[1]!;
    expect(ladderProblems({ ...DEFAULT_LADDER, steps: [] })).toHaveLength(1);
    expect(ladderProblems({ ...DEFAULT_LADDER, steps: [{ ...step, atSeconds: 30 }] })).toEqual([
      'The first step happens at once (0 seconds).',
    ]);
    expect(
      ladderProblems({ ...DEFAULT_LADDER, steps: [DEFAULT_LADDER.steps[0]!, { ...step, atSeconds: 0 }] }),
    ).toEqual(['Step 2 must come later than step 1.']);
    expect(
      ladderProblems({ ...DEFAULT_LADDER, steps: [DEFAULT_LADDER.steps[0]!, { ...step, atSeconds: 3601 }] }),
    ).toHaveLength(1);
    expect(
      ladderProblems({
        ...DEFAULT_LADDER,
        steps: [DEFAULT_LADDER.steps[0]!, { ...step, atSeconds: Number.NaN }],
      }),
    ).toHaveLength(1);
    expect(ladderProblems({ ...DEFAULT_LADDER, repeatEverySeconds: 29 })).toHaveLength(1);
    expect(
      ladderProblems({
        ...DEFAULT_LADDER,
        steps: Array.from({ length: 11 }, (_, i) => ({ ...step, atSeconds: i * 10 })),
      }),
    ).toContain('The ladder needs 1 to 10 steps.');
  });

  it('reads the stored ladder, and says each step in words', () => {
    expect(readLadder(DEFAULT_LADDER)).toEqual(DEFAULT_LADDER);
    expect(ladderProblems(readLadder('nonsense'))).not.toEqual([]);
    expect(stepWords(DEFAULT_LADDER.steps[0]!)).toBe(
      'At once: dashboard push to Supervisor, Dispatcher, Administrator; text to Supervisor',
    );
    expect(stepWords(DEFAULT_LADDER.steps[2]!)).toBe(
      'After 3 min: dashboard push to Owner; text to Owner; text to the emergency contacts',
    );
  });

  it('cleans up phone numbers as typed, and checks them against the rules the server uses', () => {
    expect(normalizePhone(' +92 300 123-4567 ')).toBe('+923001234567');
    expect(SETTING_PHONE.test('+923001234567')).toBe(true);
    expect(SETTING_PHONE.test('03001234567')).toBe(false);
    expect(MEMBER_PHONE.test('+923001234567')).toBe(true);
    expect(MEMBER_PHONE.test('+0923001234567')).toBe(false);
    // One rule on both: seven digits is too short for either (the server agrees).
    expect(MEMBER_PHONE.test('+9230012')).toBe(false);
    expect(sosChange('sos.emergency_contacts', ['+92 300 1234567', ' ', '+44 20 7946 0958'])).toEqual([
      '+923001234567',
      '+442079460958',
    ]);
    expect(sosChange('sos.emergency_call_number', '  ')).toBeNull();
    expect(sosChange('sos.emergency_call_number', '+92 42 111 222 333')).toBe('+9242111222333');
    expect(sosProblems({ 'sos.emergency_contacts': ['+923001234567', '0300 1234567'] })).toEqual([
      'Emergency contact 2 is not a full international number (like +923001234567).',
    ]);
    expect(sosProblems({ 'sos.emergency_call_number': '12345' })).toHaveLength(1);
    expect(sosProblems({ 'sos.emergency_call_number': '', 'sos.escalation': DEFAULT_LADDER })).toEqual([]);
    expect(telHref('+92 300 1234567')).toBe('tel:+923001234567');
    expect(telHref('<script>')).toBeNull();
  });
});

describe('an SOS in words (PROD §11.3, §14.5)', () => {
  const at = (s: number) => new Date(Date.parse('2026-11-02T21:00:00Z') + s * 1000).toISOString();

  it('INV-10 the progress shows each step only with the server fact behind it: sent is not notified', () => {
    const sos = {
      receivedAt: at(0),
      alertSentAt: at(2),
      notifiedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      receipts: { shownOnDashboards: 0, reachedPhones: 0 },
    } as unknown as SosDetail;
    const steps = sosProgress(sos);
    expect(steps.map((s) => [s.label, s.at !== null])).toEqual([
      ['Received by the server', true],
      ['Alert sent', true],
      ['Notified', false],
      ['Acknowledged', false],
      ['Resolved', false],
    ]);
    const notified = sosProgress({
      ...sos,
      notifiedAt: at(3),
      receipts: { shownOnDashboards: 2, reachedPhones: 1 },
    });
    expect(notified[2]?.detail).toBe('shown on 2 dashboards, reached 1 phone');
  });

  it('breaks the SOS trail wherever no position came for more than 5 minutes', () => {
    const point = (s: number) => ({ lat: 31.47, lng: 74.4 + s / 1e5, capturedAt: at(s) });
    expect(trailSegments([point(0), point(10), point(320), point(330)]).map((s) => s.length)).toEqual([2, 2]);
    expect(trailSegments([point(0), point(300)]).map((s) => s.length)).toEqual([2]);
    expect(trailSegments([])).toEqual([]);
  });
});

describe('an incident in words (PROD §10)', () => {
  const event = (overrides: Partial<IncidentEvent>): IncidentEvent => ({
    id: '0190a0d2-7c5e-7000-8000-000000000001',
    type: 'NOTE_ADDED',
    actorType: 'USER',
    actorName: 'Sarah K.',
    body: null,
    fromValue: null,
    toValue: null,
    createdAt: '2026-11-02T21:00:00Z',
    ...overrides,
  });

  it('says each change with its old and new value, and keeps the person’s own words apart', () => {
    expect(eventText(event({ type: 'SEVERITY_CHANGED', fromValue: 'LOW', toValue: 'HIGH' })).what).toBe(
      'Severity: Low → High',
    );
    expect(eventText(event({ type: 'TYPE_CHANGED', fromValue: 'THEFT', toValue: 'INTRUSION' })).what).toBe(
      'Type: Theft → Intrusion',
    );
    expect(
      eventText(
        event({ type: 'STATUS_CHANGED', fromValue: 'RESOLVED', toValue: 'OPEN', body: 'Guard found more' }),
      ),
    ).toEqual({ what: 'Status: Resolved → Open', label: 'Reason', body: 'Guard found more' });
    expect(eventText(event({ body: 'Called the police' }))).toEqual({
      what: 'Note',
      label: null,
      body: 'Called the police',
    });
    expect(rejectionText('TOO_MANY_PIXELS')).toBe('it is larger than 40 megapixels');
    expect(rejectionText('SOMETHING_NEW')).toBe('something new');
  });

  it('allows an occurred time up to 24 hours back, never in the future (PROD §10.1)', () => {
    const now = Date.parse('2026-11-02T21:00:00Z');
    expect(occurredAtProblem(now - 3_600_000, now)).toBeNull();
    expect(occurredAtProblem(now - 25 * 3_600_000, now)).toContain('24 hours');
    expect(occurredAtProblem(now + 10 * 60_000, now)).toContain('future');
    expect(occurredAtProblem(Number.NaN, now)).not.toBeNull();
  });
});
