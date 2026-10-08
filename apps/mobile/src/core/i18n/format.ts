// Times shown to the guard: 24-hour, in the SITE's timezone (PROD §6.1, §7.1), never the phone's.
import type { Locale, Translate } from './index.ts';

const INTL_LOCALE: Record<Locale, string> = { en: 'en-GB', ur: 'ur-PK' };

function format(ms: number, timeZone: string, locale: Locale, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
      ...options,
      timeZone,
      numberingSystem: 'latn',
    }).format(new Date(ms));
  } catch {
    // An unknown zone: say so rather than silently showing the phone's own timezone.
    return `${new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(new Date(ms))} UTC`;
  }
}

/** "20:00" */
export const formatTime = (ms: number, timeZone: string, locale: Locale): string =>
  format(ms, timeZone, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "Thu 8 Oct" */
export const formatDay = (ms: number, timeZone: string, locale: Locale): string =>
  format(ms, timeZone, locale, { weekday: 'short', day: 'numeric', month: 'short' });

/** The calendar date in the zone, for grouping ("2026-10-08"). */
export function localDateKey(ms: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** "8 s ago", "4 min ago", "2 h ago". Negative ages (clock differences) read as "just now". */
export function formatAgo(ageMs: number, t: Translate): string {
  if (!Number.isFinite(ageMs) || ageMs < 5_000) return t('common.justNow');
  const s = Math.floor(ageMs / 1_000);
  if (s < 60) return t('common.secondsAgo', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('common.minutesAgo', { n: m });
  return t('common.hoursAgo', { n: Math.floor(m / 60) });
}

/** "18 min", "3 h". */
export function formatDuration(ms: number, t: Translate): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? t('common.minutes', { n: m }) : t('common.hours', { n: Math.floor(m / 60) });
}
