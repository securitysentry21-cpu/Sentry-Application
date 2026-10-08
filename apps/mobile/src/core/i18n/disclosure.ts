// The tracking disclosure (PROD §7.2, SEC §16.3): shown before any permission request, versioned,
// and accepted with "I understand". The acceptance is recorded on the server with the version and
// language (POST /tracking-consents). The server's GET /mobile/config names the current version; the
// app can only record acceptance of text it actually showed, so a version this build does not
// contain blocks tracking and asks for an update instead of showing other words.
//
// DRAFT TEXT: the legal review (EXT-17) must approve the wording in both languages before any real
// guard sees it.
import type { Locale } from './index.ts';

export type DisclosureText = {
  readonly title: string;
  readonly intro: string;
  readonly purposes: readonly string[];
  readonly paragraphs: readonly string[];
};

/** Bundled disclosure versions. The server's `disclosureVersion` must be one of these keys. */
export const DISCLOSURES: Readonly<Record<string, Readonly<Record<Locale, DisclosureText>>>> = {
  '1': {
    en: {
      title: 'Why we need your location',
      intro: 'During an active security shift, the app uses your location to:',
      purposes: [
        'verify you are at your assigned site;',
        'record patrol activity;',
        'help supervisors respond to emergencies.',
      ],
      paragraphs: [
        'Location tracking runs only during your assigned shift and during an SOS. It stops when your shift ends.',
        "What is collected: your location and its accuracy, and the phone's tracking status (location permission, battery, connection). Nothing is collected outside shifts and an SOS.",
        "Who sees it: your company's supervisors and administrators. Every view of your location history is recorded.",
        "How long it is kept: your company's settings decide. By default, location is kept for 90 days.",
        'While tracking is on, Android shows a notification that you cannot swipe away, and iPhone shows the location indicator.',
        'Android may show a notice that SENTRY is a workplace monitoring app. Google Play requires this notice; it is expected.',
      ],
    },
    ur: {
      title: 'ہمیں آپ کی لوکیشن کیوں چاہیے',
      intro: 'سیکیورٹی شفٹ کے دوران یہ ایپ آپ کی لوکیشن ان کاموں کے لیے استعمال کرتی ہے:',
      purposes: [
        'یہ تصدیق کرنا کہ آپ اپنی مقررہ سائٹ پر موجود ہیں؛',
        'گشت کی سرگرمی ریکارڈ کرنا؛',
        'ہنگامی صورتحال میں سپروائزرز کو بروقت جواب دینے میں مدد دینا۔',
      ],
      paragraphs: [
        'لوکیشن ٹریکنگ صرف آپ کی مقررہ شفٹ کے دوران اور SOS کے دوران چلتی ہے۔ شفٹ ختم ہوتے ہی یہ بند ہو جاتی ہے۔',
        'کیا جمع کیا جاتا ہے: آپ کی لوکیشن اور اس کی درستگی، اور فون کی ٹریکنگ کی حالت (لوکیشن کی اجازت، بیٹری، کنکشن)۔ شفٹ اور SOS کے علاوہ کچھ جمع نہیں کیا جاتا۔',
        'کون دیکھتا ہے: آپ کی کمپنی کے سپروائزرز اور ایڈمنسٹریٹرز۔ آپ کی لوکیشن ہسٹری دیکھنے کا ہر عمل ریکارڈ ہوتا ہے۔',
        'کتنی دیر رکھا جاتا ہے: یہ آپ کی کمپنی کی سیٹنگز طے کرتی ہیں۔ عام طور پر لوکیشن 90 دن تک رکھی جاتی ہے۔',
        'ٹریکنگ کے دوران اینڈرائیڈ ایک ایسا نوٹیفکیشن دکھاتا ہے جو ہٹایا نہیں جا سکتا، اور آئی فون لوکیشن کا نشان دکھاتا ہے۔',
        'اینڈرائیڈ یہ نوٹس دکھا سکتا ہے کہ SENTRY دفتری نگرانی کی ایپ ہے۔ گوگل پلے اس نوٹس کا تقاضا کرتا ہے؛ یہ معمول کی بات ہے۔',
      ],
    },
  },
};

export function disclosureFor(version: string, locale: Locale): DisclosureText | null {
  return DISCLOSURES[version]?.[locale] ?? null;
}
