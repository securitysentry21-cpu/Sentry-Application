import { CURRENT_DISCLOSURE_VERSION } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import { DISCLOSURES, disclosureFor } from '../src/core/i18n/disclosure.ts';
import { en } from '../src/core/i18n/en.ts';
import { formatAgo, formatTime, localDateKey } from '../src/core/i18n/format.ts';
import {
  DICTIONARIES,
  errorMessageKey,
  isRtl,
  placeholdersOf,
  translate,
  translator,
} from '../src/core/i18n/index.ts';
import { ur } from '../src/core/i18n/ur.ts';

describe('English and Urdu (D-14)', () => {
  it('both dictionaries have exactly the same keys', () => {
    expect(Object.keys(ur).sort()).toEqual(Object.keys(en).sort());
  });

  it('every message has the same {placeholders} in both languages, and none is empty', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholdersOf(ur[key]), key).toEqual(placeholdersOf(en[key]));
      expect(en[key].trim().length, key).toBeGreaterThan(0);
      expect(ur[key].trim().length, key).toBeGreaterThan(0);
    }
  });

  it('Urdu strings are written in Urdu (Arabic script), apart from names and codes', () => {
    const latinOnly = (Object.keys(ur) as (keyof typeof ur)[]).filter(
      (key) => !/[؀-ۿ]/.test(ur[key]) && ur[key] !== en[key],
    );
    expect(latinOnly).toEqual([]);
    const untranslated = (Object.keys(ur) as (keyof typeof ur)[]).filter(
      (key) =>
        ur[key] === en[key] &&
        ![
          'app.name',
          'language.english',
          'language.urdu',
          'enroll.phonePlaceholder',
          'notification.title',
          'shift.time',
        ].includes(key),
    );
    expect(untranslated).toEqual([]);
  });

  it('Urdu is laid out right to left, English left to right', () => {
    expect(isRtl('ur')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'sync.waiting', { count: 42, age: '18 min' })).toBe(
      'Offline — 42 updates waiting · oldest 18 min',
    );
    expect(translate('ur', 'sync.waitingShort', { count: 3 })).toContain('3');
    expect(translate('en', 'home.greeting')).toBe('Hello, {name}');
    const t = translator('en');
    expect(t('shift.pending')).toBe('Shift started on this phone — waiting to confirm with server');
  });

  it('has a message for every rejection code the guard can meet, with a fallback', () => {
    expect(errorMessageKey('SHIFT_OUTSIDE_START_WINDOW')).toBe('error.SHIFT_OUTSIDE_START_WINDOW');
    expect(errorMessageKey('SOMETHING_NEW')).toBe('error.default');
    expect(errorMessageKey(null)).toBe('error.default');
  });

  it('this build bundles the disclosure version the server asks guards to accept (SEC §16.3)', () => {
    // Otherwise a guard could never accept the disclosure, and tracking could never start.
    expect(Object.keys(DISCLOSURES)).toContain(CURRENT_DISCLOSURE_VERSION);
    expect(disclosureFor(CURRENT_DISCLOSURE_VERSION, 'en')).not.toBeNull();
    expect(disclosureFor(CURRENT_DISCLOSURE_VERSION, 'ur')).not.toBeNull();
  });

  it('every bundled tracking disclosure exists in both languages with the same structure', () => {
    for (const [version, texts] of Object.entries(DISCLOSURES)) {
      expect(texts.en.purposes.length, version).toBe(texts.ur.purposes.length);
      expect(texts.en.paragraphs.length, version).toBe(texts.ur.paragraphs.length);
      expect(texts.en.purposes.length).toBeGreaterThanOrEqual(3);
    }
    expect(disclosureFor('1', 'ur')?.title).toBe('ہمیں آپ کی لوکیشن کیوں چاہیے');
    expect(disclosureFor('999', 'en')).toBeNull();
    // PROD §7.2: the core sentence about when tracking runs is there.
    expect(disclosureFor('1', 'en')?.paragraphs[0]).toContain(
      'only during your assigned shift and during an SOS',
    );
  });

  it('dictionaries are complete for each locale the contract allows', () => {
    expect(Object.keys(DICTIONARIES).sort()).toEqual(['en', 'ur']);
  });
});

describe('times in the site timezone (PROD §6.1, ADV-TM01 display)', () => {
  it('shows 24-hour times in the site timezone, not the phone’s', () => {
    const ms = Date.parse('2026-10-08T15:00:00.000Z');
    expect(formatTime(ms, 'Asia/Karachi', 'en')).toBe('20:00');
    expect(formatTime(ms, 'Europe/London', 'en')).toBe('16:00');
    expect(formatTime(ms, 'Asia/Karachi', 'ur')).toMatch(/20:00/);
  });

  it('an overnight shift crosses midnight in the site timezone', () => {
    const start = Date.parse('2026-10-08T15:00:00.000Z'); // 20:00 in Karachi
    const end = start + 12 * 3_600_000; // 08:00 next day
    expect(formatTime(end, 'Asia/Karachi', 'en')).toBe('08:00');
    expect(localDateKey(start, 'Asia/Karachi')).toBe('2026-10-08');
    expect(localDateKey(end, 'Asia/Karachi')).toBe('2026-10-09');
  });

  it('says so when the zone is unknown instead of using the phone’s zone', () => {
    expect(formatTime(Date.parse('2026-10-08T15:00:00.000Z'), 'Not/AZone', 'en')).toBe('15:00 UTC');
  });

  it('formats ages for “last update … ago”', () => {
    const t = translator('en');
    expect(formatAgo(2_000, t)).toBe('just now');
    expect(formatAgo(8_000, t)).toBe('8 s ago');
    expect(formatAgo(4 * 60_000, t)).toBe('4 min ago');
    expect(formatAgo(3 * 3_600_000, t)).toBe('3 h ago');
    expect(formatAgo(-50_000, t)).toBe('just now');
  });
});
