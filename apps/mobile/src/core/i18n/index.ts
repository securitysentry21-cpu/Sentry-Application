// A small i18n layer (D-14: English and Urdu only, English by default). Every string the guard sees
// comes from here; Urdu is laid out right-to-left. Times are 24-hour, in the site's timezone.
import type { GUARD_LOCALES } from '@sentryops/contracts';

import { en, type MessageKey } from './en.ts';
import { ur } from './ur.ts';

export type Locale = (typeof GUARD_LOCALES)[number];
export type { MessageKey };
export type Params = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, params?: Params) => string;

export const DICTIONARIES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { en, ur };
export const DEFAULT_LOCALE: Locale = 'en';

export const isLocale = (value: unknown): value is Locale => value === 'en' || value === 'ur';
export const isRtl = (locale: Locale): boolean => locale === 'ur';

/** The `{name}` placeholders in a message, sorted (for the parity test). */
export function placeholdersOf(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
}

export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const template = DICTIONARIES[locale][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export const translator =
  (locale: Locale): Translate =>
  (key, params) =>
    translate(locale, key, params);

/** A message key for an API error code, falling back to the generic one. */
export function errorMessageKey(code: string | null | undefined): MessageKey {
  const key = `error.${code ?? 'default'}`;
  return (key in en ? key : 'error.default') as MessageKey;
}
