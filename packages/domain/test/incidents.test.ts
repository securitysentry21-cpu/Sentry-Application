import { describe, expect, it } from 'vitest';

import { incidentOccurredAt, incidentTransition } from '../src/incidents.ts';

const reportedAt = new Date('2026-11-02T10:00:00.000Z');

describe('when an incident happened (PROD §10.1)', () => {
  it('moves the chosen time by the same correction as the report', () => {
    // The phone's clock runs 5 minutes fast: its "09:30" was the server's 09:25.
    const result = incidentOccurredAt({
      occurredAtPhone: new Date('2026-11-02T09:30:00.000Z'),
      recordedAtPhone: new Date('2026-11-02T10:05:00.000Z'),
      reportedAt,
    });
    expect(result).toEqual({ ok: true, occurredAt: new Date('2026-11-02T09:25:00.000Z') });
  });

  it('may be set back up to 24 hours, never more', () => {
    const ok = incidentOccurredAt({
      occurredAtPhone: new Date('2026-11-01T10:00:00.000Z'),
      recordedAtPhone: reportedAt,
      reportedAt,
    });
    expect(ok.ok).toBe(true);
    const tooOld = incidentOccurredAt({
      occurredAtPhone: new Date('2026-11-01T09:59:00.000Z'),
      recordedAtPhone: reportedAt,
      reportedAt,
    });
    expect(tooOld.ok).toBe(false);
  });

  it('is never in the future: jitter becomes the report time, more is refused', () => {
    const jitter = incidentOccurredAt({
      occurredAtPhone: new Date('2026-11-02T10:01:00.000Z'),
      recordedAtPhone: reportedAt,
      reportedAt,
    });
    expect(jitter).toEqual({ ok: true, occurredAt: reportedAt });
    const future = incidentOccurredAt({
      occurredAtPhone: new Date('2026-11-02T10:10:00.000Z'),
      recordedAtPhone: reportedAt,
      reportedAt,
    });
    expect(future.ok).toBe(false);
  });
});

describe('incident status (PROD §10.1)', () => {
  it('goes OPEN → ACKNOWLEDGED → RESOLVED, and reopens only from RESOLVED', () => {
    expect(incidentTransition('OPEN', 'ACKNOWLEDGE')).toEqual({
      ok: true,
      to: 'ACKNOWLEDGED',
      changed: true,
    });
    expect(incidentTransition('ACKNOWLEDGED', 'ACKNOWLEDGE')).toEqual({
      ok: true,
      to: 'ACKNOWLEDGED',
      changed: false,
    });
    expect(incidentTransition('OPEN', 'RESOLVE')).toEqual({ ok: true, to: 'RESOLVED', changed: true });
    expect(incidentTransition('RESOLVED', 'RESOLVE')).toEqual({ ok: false });
    expect(incidentTransition('RESOLVED', 'ACKNOWLEDGE')).toEqual({ ok: false });
    expect(incidentTransition('OPEN', 'REOPEN')).toEqual({ ok: false });
    expect(incidentTransition('RESOLVED', 'REOPEN')).toEqual({ ok: true, to: 'OPEN', changed: true });
  });
});
