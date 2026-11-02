// Incident rules as pure functions (PROD §10).

/** PROD §10.1: an incident may be set back up to 24 hours, never into the future. */
export const INCIDENT_MAX_BACKDATE_MS = 24 * 3_600_000;
/** Phones disagree with the server by a little; a time this close after the report counts as "now". */
const FUTURE_TOLERANCE_MS = 120_000;

/**
 * When the incident happened, on the server's clock. The phone's chosen time moves by the same
 * correction as the report's capture estimate (INV-07). A time a little after the report (clock
 * jitter) becomes the report time; one more than 24 hours before it, or clearly in the future, is
 * refused: the app never offers either.
 */
export function incidentOccurredAt(input: {
  readonly occurredAtPhone: Date;
  readonly recordedAtPhone: Date;
  readonly reportedAt: Date;
}): { ok: true; occurredAt: Date } | { ok: false } {
  const correctionMs = input.reportedAt.getTime() - input.recordedAtPhone.getTime();
  const occurred = input.occurredAtPhone.getTime() + correctionMs;
  const reported = input.reportedAt.getTime();
  if (occurred > reported + FUTURE_TOLERANCE_MS) return { ok: false };
  if (occurred < reported - INCIDENT_MAX_BACKDATE_MS) return { ok: false };
  return { ok: true, occurredAt: new Date(Math.min(occurred, reported)) };
}

export type IncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
export type IncidentAction = 'ACKNOWLEDGE' | 'RESOLVE' | 'REOPEN';

/**
 * PROD §10.1: OPEN → ACKNOWLEDGED → RESOLVED, resolving straight from OPEN too (it records the
 * acknowledgement); a Supervisor or above may reopen a resolved incident with a reason. Acknowledging
 * twice is idempotent (the first person stays).
 */
export function incidentTransition(
  from: IncidentStatus,
  action: IncidentAction,
): { ok: true; to: IncidentStatus; changed: boolean } | { ok: false } {
  switch (action) {
    case 'ACKNOWLEDGE':
      if (from === 'OPEN') return { ok: true, to: 'ACKNOWLEDGED', changed: true };
      if (from === 'ACKNOWLEDGED') return { ok: true, to: 'ACKNOWLEDGED', changed: false };
      return { ok: false };
    case 'RESOLVE':
      return from === 'RESOLVED' ? { ok: false } : { ok: true, to: 'RESOLVED', changed: true };
    case 'REOPEN':
      return from === 'RESOLVED' ? { ok: true, to: 'OPEN', changed: true } : { ok: false };
  }
}
