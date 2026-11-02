import { describe, expect, it } from 'vitest';

import { translator } from '../src/core/i18n/index.ts';
import type { Receipt } from '../src/core/outbox/outbox.ts';
import {
  receiptLine,
  scanLine,
  scanProgress,
  shiftLine,
  sosLine,
  syncLine,
  trackingLine,
} from '../src/core/presenter.ts';
import { newLocalShift, shiftReducer } from '../src/core/shift/local-shift.ts';
import { newSos } from '../src/core/sos/machine.ts';

const t = translator('en');
const NOW = Date.parse('2026-10-08T15:00:00.000Z');

const receipt = (status: Receipt['status'], errorCode: string | null = null): Receipt => ({
  clientEventId: 'c',
  type: 'INCIDENT',
  shiftId: 's',
  status,
  errorCode,
  serverRef: null,
  scan: null,
  createdAtMs: NOW,
  updatedAtMs: NOW,
});

const scanReceipt = (status: Receipt['status'], scan: Receipt['scan']): Receipt => ({
  ...receipt(status),
  type: 'CHECKPOINT_SCAN',
  scan,
});

describe('checkpoint scans on the phone (PROD §7.7)', () => {
  const judged = (
    scan: Partial<NonNullable<Receipt['scan']>> & Pick<NonNullable<Receipt['scan']>, 'outcome'>,
  ) =>
    scanLine(
      scanReceipt('ACCEPTED', { counted: false, checkpointName: null, distanceM: null, run: null, ...scan }),
      false,
      t,
    );

  it('INV-16 a scan reads “Saved — will verify when online” (“Checking…” while sending) until the server answers', () => {
    expect(scanLine(null, false, t)).toEqual({ text: 'Saved — will verify when online', tone: 'warning' });
    expect(scanLine(scanReceipt('QUEUED', null), false, t).text).toBe('Saved — will verify when online');
    expect(scanLine(scanReceipt('QUEUED', null), true, t)).toEqual({ text: 'Checking…', tone: 'info' });
  });

  it('words each outcome the way PROD §7.7 lists them', () => {
    expect(judged({ outcome: 'VERIFIED', counted: true, checkpointName: 'Main gate' })).toEqual({
      text: '✓ Verified: Main gate',
      tone: 'ok',
    });
    expect(judged({ outcome: 'LOCATION_UNCONFIRMED', counted: true }).text).toBe(
      'QR accepted — location could not be confirmed',
    );
    expect(judged({ outcome: 'LOCATION_UNCONFIRMED', counted: false }).text).toBe(
      'QR accepted — location could not be confirmed. It does not count for the round.',
    );
    expect(judged({ outcome: 'OUTSIDE_RADIUS', distanceM: 85 })).toEqual({
      text: 'Not verified: about 85 m from this checkpoint',
      tone: 'danger',
    });
    expect(judged({ outcome: 'INVALID_QR' }).text).toBe(
      'QR code not recognised. If this label is at your site, it may be old: tell your supervisor.',
    );
    expect(judged({ outcome: 'WRONG_SITE' }).text).toBe('This checkpoint belongs to another site');
    expect(judged({ outcome: 'NO_ACTIVE_SHIFT' }).text).toBe('No active shift');
    expect(judged({ outcome: 'DUPLICATE' }).text).toBe('Already scanned in this round');
  });

  it('a resubmitted scan shows its first answer; a refusal shows the reason', () => {
    const first = {
      outcome: 'VERIFIED' as const,
      counted: true,
      checkpointName: 'Main gate',
      distanceM: null,
      run: null,
    };
    expect(scanLine(scanReceipt('DUPLICATE', first), false, t).text).toBe('✓ Verified: Main gate');
    expect(scanLine({ ...scanReceipt('REJECTED', null), errorCode: 'NOT_FOUND' }, false, t)).toEqual({
      text: 'Not accepted by server: The server does not know this shift.',
      tone: 'danger',
    });
  });

  it("shows a round's progress only once the server counted the scan toward it", () => {
    expect(scanProgress(null, t)).toBeNull();
    expect(scanProgress(scanReceipt('QUEUED', null), t)).toBeNull();
    const counted = scanReceipt('ACCEPTED', {
      outcome: 'VERIFIED',
      counted: true,
      checkpointName: 'Store room',
      distanceM: null,
      run: { countedCount: 2, requiredCount: 6, status: 'IN_PROGRESS' },
    });
    expect(scanProgress(counted, t)).toBe('Round: 2 of 6 done');
  });
});

describe('honest words on the phone (PROD §7.6)', () => {
  it('INV-16 an action reads “Saved on this phone” until the server answered, then what it answered', () => {
    expect(receiptLine(null, t).text).toBe('Saved on this phone — will send when online');
    expect(receiptLine(receipt('QUEUED'), t).text).toBe('Saved on this phone — will send when online');
    expect(receiptLine(receipt('ACCEPTED'), t).text).toBe('Received by server');
    expect(receiptLine(receipt('REJECTED', 'OUTSIDE_SHIFT_WINDOW'), t).text).toBe(
      'Not accepted by server: It was outside your shift time.',
    );
    expect(receiptLine(receipt('DISCARDED'), t).text).toBe('Not sent — removed from this phone');
    for (const status of ['QUEUED', 'DISCARDED'] as const) {
      expect(receiptLine(receipt(status), t).text).not.toContain('Received');
    }
  });

  it('INV-10 the SOS says “received” only in the RECEIVED state, and never “notified” or “acknowledged”', () => {
    const queued = newSos('c', NOW);
    expect(sosLine(queued, t).text).toBe('SOS ACTIVE — waiting for network…');
    expect(sosLine({ ...queued, phase: 'SENDING' }, t).text).toBe('Sending SOS…');
    expect(sosLine({ ...queued, phase: 'RECEIVED' }, t).text).toBe('SOS received — alerting supervisors…');
    for (const phase of ['QUEUED', 'SENDING', 'RECEIVED', 'FAILED'] as const) {
      const text = sosLine({ ...queued, phase }, t).text.toLowerCase();
      expect(text).not.toMatch(/notified|acknowledged|reached/);
    }
  });

  it('INV-09 a fix is shown with its age and accuracy, poor accuracy is labelled, and no fix is “waiting for GPS”', () => {
    const base = { running: true, problem: null } as const;
    expect(trackingLine({ ...base, lastFixAtMs: null, lastFixAccuracyM: null }, true, NOW, t).text).toBe(
      'Waiting for GPS',
    );
    expect(trackingLine({ ...base, lastFixAtMs: NOW - 20_000, lastFixAccuracyM: 8 }, true, NOW, t).text).toBe(
      'Tracking active · 20 s ago · ±8 m',
    );
    expect(
      trackingLine({ ...base, lastFixAtMs: NOW - 4 * 60_000, lastFixAccuracyM: 8 }, true, NOW, t).text,
    ).toContain('4 min ago');
    expect(trackingLine({ ...base, lastFixAtMs: NOW, lastFixAccuracyM: 120 }, true, NOW, t).text).toBe(
      'Low accuracy (~120 m)',
    );
    expect(
      trackingLine(
        { running: true, problem: 'APPROXIMATE_ONLY', lastFixAtMs: NOW, lastFixAccuracyM: 8 },
        true,
        NOW,
        t,
      ).text,
    ).toBe('Approximate location only');
    expect(trackingLine({ ...base, lastFixAtMs: NOW, lastFixAccuracyM: 8 }, false, NOW, t).text).toBe(
      'Tracking off',
    );
  });

  it('ADV-U03 “all data sent” appears only for the ALL_SENT state', () => {
    expect(syncLine({ kind: 'ALL_SENT', lastSuccessAtMs: NOW - 6_000 }, NOW, t).text).toBe(
      'Server confirmed 6 s ago · all data sent',
    );
    const others = [
      syncLine({ kind: 'NOTHING_YET' }, NOW, t),
      syncLine({ kind: 'SENDING', pending: 3 }, NOW, t),
      syncLine({ kind: 'WAITING', pending: 42, oldestAtMs: NOW - 18 * 60_000 }, NOW, t),
      syncLine({ kind: 'SIGNED_OUT', pending: 42 }, NOW, t),
      syncLine({ kind: 'DISCARDED', count: 3, reason: 'EXPIRED', pending: 0 }, NOW, t),
    ];
    for (const line of others) expect(line.text).not.toContain('all data sent');
    expect(others[2]?.text).toBe('Offline — 42 updates waiting · oldest 18 min');
    expect(others[3]?.text).toBe('Signed out — 42 updates cannot be sent');
  });

  it('ADV-O02 an offline start reads “waiting to confirm with server”, a confirmed one “SHIFT ACTIVE”', () => {
    const pending = shiftReducer(newLocalShift('s', NOW + 3_600_000, 60), {
      type: 'START_QUEUED',
      eventId: 'e',
      atMs: NOW,
      endsAtMs: NOW + 3_600_000,
      autoEndAfterMinutes: 60,
    });
    expect(shiftLine(pending, t)?.text).toBe('Shift started on this phone — waiting to confirm with server');
    const active = shiftReducer(
      shiftReducer(pending, { type: 'START_RESULT', status: 'ACCEPTED', errorCode: null, atMs: NOW }),
      {
        type: 'SERVER_STATUS',
        status: 'ACTIVE',
        endsAtMs: NOW + 3_600_000,
        nowMs: NOW,
      },
    );
    expect(shiftLine(active, t)?.text).toBe('SHIFT ACTIVE');
    const stopped = shiftReducer(active, { type: 'CLOCK', nowMs: NOW + 3 * 3_600_000 });
    expect(shiftLine(stopped, t)?.text).toBe('Shift time over — tracking stopped. Tap End Shift.');
  });
});
