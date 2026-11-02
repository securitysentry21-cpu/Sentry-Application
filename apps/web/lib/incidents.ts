// Incidents in words (PROD §10): types, severities, statuses, a photo's source and why one was
// refused, and each step of an incident's history, as the dashboard says them. Severity and status
// are never colour alone: every badge carries one of these words (PROD §14.7). The limits are the
// contracts' (packages/contracts/src/incidents.ts): the server enforces them; the forms only say so
// early, and zod stays out of the browser bundle.
import type {
  IncidentAttachment,
  IncidentEvent,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
} from '@sentryops/contracts';

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 4000;
export const NOTE_MAX = 4000;
export const RESOLUTION_NOTE_MAX = 4000;
export const REOPEN_REASON_MAX = 1000;
/** PROD §10.1: the occurred time may be set up to 24 hours back, never in the future. */
export const MAX_BACKDATE_H = 24;

export const INCIDENT_TYPES: readonly IncidentType[] = [
  'THEFT',
  'INTRUSION',
  'FIRE',
  'MEDICAL',
  'PROPERTY_DAMAGE',
  'ALTERCATION',
  'SUSPICIOUS_ACTIVITY',
  'OTHER',
];

export const TYPE_LABEL: Record<IncidentType, string> = {
  THEFT: 'Theft',
  INTRUSION: 'Intrusion',
  FIRE: 'Fire',
  MEDICAL: 'Medical emergency',
  PROPERTY_DAMAGE: 'Property damage',
  ALTERCATION: 'Altercation',
  SUSPICIOUS_ACTIVITY: 'Suspicious activity',
  OTHER: 'Other',
};

/** Most severe first. */
export const SEVERITIES: readonly IncidentSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const SEVERITY_BADGE: Record<IncidentSeverity, string> = {
  CRITICAL: 'danger',
  HIGH: 'danger',
  MEDIUM: 'warn',
  LOW: 'info',
};

/** PROD §7.8: the severity a type starts with (FIRE and MEDICAL high); the reporter may change it. */
export const DEFAULT_SEVERITY: Record<IncidentType, IncidentSeverity> = {
  THEFT: 'MEDIUM',
  INTRUSION: 'HIGH',
  FIRE: 'HIGH',
  MEDICAL: 'HIGH',
  PROPERTY_DAMAGE: 'MEDIUM',
  ALTERCATION: 'HIGH',
  SUSPICIOUS_ACTIVITY: 'MEDIUM',
  OTHER: 'MEDIUM',
};

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
};

export const STATUS_BADGE: Record<IncidentStatus, string> = {
  OPEN: 'danger',
  ACKNOWLEDGED: 'warn',
  RESOLVED: 'ok',
};

/** D-18: every photo says where it came from. */
export const SOURCE_LABEL: Record<IncidentAttachment['captureSource'], string> = {
  IN_APP_CAMERA: 'Camera',
  GALLERY: 'From gallery',
};

export const PHOTO_STATUS_LABEL: Record<IncidentAttachment['status'], string> = {
  PENDING_UPLOAD: 'Uploading from the phone',
  PROCESSING: 'Being checked',
  AVAILABLE: 'Ready',
  REJECTED: 'Refused',
};

/** Why the server refused a photo (ARCH §12 step 5). */
const REJECTION_LABEL: Record<string, string> = {
  NOT_UPLOADED: 'the upload never arrived',
  SIZE_MISMATCH: 'its size was not what the phone declared',
  HASH_MISMATCH: 'it changed on the way (checksum mismatch)',
  TYPE_NOT_ALLOWED: 'it is not a JPEG, PNG or WebP image',
  TOO_MANY_PIXELS: 'it is larger than 40 megapixels',
  UNREADABLE: 'the image could not be read',
};

/** A code the dashboard has no words for yet, still readable. */
const plainWords = (code: string) => code.toLowerCase().replaceAll('_', ' ');

export function rejectionText(reason: string | null): string {
  return reason ? (REJECTION_LABEL[reason] ?? plainWords(reason)) : 'no reason given';
}

/** Location flags (PROD §8.5): what looked wrong about where the report was filed. */
export function locationFlagsText(flags: readonly string[]): string {
  return flags.map((f) => (f === 'MOCK_LOCATION' ? 'fake GPS reported' : plainWords(f))).join(', ');
}

/** "Theft", "Critical", "Open" for a code the event carries as text. */
function valueWords(kind: 'type' | 'severity' | 'status', value: string | null): string {
  if (value === null) return '—';
  const table: Record<string, string> =
    kind === 'type' ? TYPE_LABEL : kind === 'severity' ? SEVERITY_LABEL : STATUS_LABEL;
  return table[value] ?? plainWords(value);
}

/**
 * One step of an incident's history in words. `body` is a person's own text (a note, a resolution
 * note, a reason for reopening): the page shows it as text, after `label` when there is one.
 */
export function eventText(e: IncidentEvent): { what: string; label: string | null; body: string | null } {
  switch (e.type) {
    case 'CREATED':
      return { what: 'Reported', label: null, body: null };
    case 'NOTE_ADDED':
      return { what: 'Note', label: null, body: e.body };
    case 'STATUS_CHANGED':
      return {
        what: `Status: ${valueWords('status', e.fromValue)} → ${valueWords('status', e.toValue)}`,
        label: e.toValue === 'RESOLVED' ? 'Resolution' : e.toValue === 'OPEN' ? 'Reason' : null,
        body: e.body,
      };
    case 'SEVERITY_CHANGED':
      return {
        what: `Severity: ${valueWords('severity', e.fromValue)} → ${valueWords('severity', e.toValue)}`,
        label: null,
        body: null,
      };
    case 'TYPE_CHANGED':
      return {
        what: `Type: ${valueWords('type', e.fromValue)} → ${valueWords('type', e.toValue)}`,
        label: null,
        body: null,
      };
    case 'ATTACHMENT_ADDED':
      return { what: 'Photo added', label: null, body: null };
    case 'ATTACHMENT_REJECTED':
      return { what: 'Photo refused', label: null, body: null };
  }
}

/** Who did it: the guard who reported it, a dashboard user, or SENTRY itself. */
export function actorText(e: Pick<IncidentEvent, 'actorType' | 'actorName'>): string {
  if (e.actorType === 'SYSTEM') return 'SENTRY';
  const name = e.actorName ?? 'someone';
  return e.actorType === 'GUARD' ? `${name} (guard)` : name;
}

/**
 * The occurred time the dashboard may send (PROD §10.1): not in the future, at most 24 hours back.
 * Null when it is fine; otherwise what to say.
 */
export function occurredAtProblem(occurredMs: number, nowMs: number): string | null {
  if (!Number.isFinite(occurredMs)) return 'Enter when it happened.';
  if (occurredMs > nowMs + 60_000) return 'When it happened can’t be in the future.';
  if (occurredMs < nowMs - MAX_BACKDATE_H * 3_600_000)
    return `When it happened can be at most ${MAX_BACKDATE_H} hours ago.`;
  return null;
}
