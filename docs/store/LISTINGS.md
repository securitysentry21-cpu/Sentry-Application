# Store listing texts

> **DRAFT for owner review. Date: 2026-11-08.** Prepared by an AI coding assistant. The app name, domain and contacts are placeholders. **All Urdu text below is a SUGGESTION and needs a native speaker's review before use.** Open points are marked `[OWNER TO CONFIRM: ...]` and `[LAWYER: ...]`.

## 1. Limits and rules

| Field                        | Google Play          | Apple App Store                 |
| ---------------------------- | -------------------- | ------------------------------- |
| App name                     | 30 characters        | 30 characters                   |
| Short description / subtitle | **80** characters    | Subtitle 30 characters          |
| Full description             | **4,000** characters | 4,000 characters                |
| What's new                   | 500 characters       | 4,000 characters                |
| Promotional text             | —                    | 170 characters                  |
| Keywords                     | —                    | 100 characters, comma separated |

These limits are from memory of the stores' rules. `[OWNER TO CONFIRM: check each limit on the live form (EXT-45).]` Counted by script on 2026-11-08 on the text as written, placeholders included (spaces included): English short description 62 of 80; Apple subtitle 24 of 30; full description 2,405 of 4,000; what's new 122 of 500; promotional text 125 of 170; keywords 62 of 100; Urdu short description 56 of 80; Urdu full description 1,992 of 4,000. **Recount after the placeholders are replaced and after any edit.** The English SOS block is already counted in the 2,405.

**Rules for every text in this file**

- It must match what the product does today. Every claim below is traced to a source in section 6.
- **No** "emergency services", "emergency response", "rescue", "police", "ambulance" (except in the sentence that says SOS does **not** call them), "guaranteed", "100%", "always accurate", "instant", "never miss", "secure" as a promise, "real-time" as a promise, "saves lives", "GPS proof".
- The monitoring purpose is stated plainly (Play's monitoring-tool rule, EXT-20).
- SOS is mentioned **only if** the SOS feature is switched on in the reviewed build. Today it is off for pilot guards. Lines for SOS are marked `[ONLY WHEN SOS IS ON]`.
- No store text names the pilot customer or any real person.

## 2. English

### 2.1 App name (up to 30 characters)

```text
[APP NAME]
```

Working name: SENTRY. `[OWNER TO CONFIRM: final name, after the trademark search (EXT-17)]`. The store name must not claim more than the product (no "Emergency", "Safe", "Guardian Angel").

### 2.2 Short description (up to 80 characters)

```text
Shifts, patrol scans and incident reports for security guards.
```

Apple subtitle (up to 30 characters):

```text
Guard shifts and patrols
```

### 2.3 Full description (up to 4,000 characters)

```text
[APP NAME] is a work app for security guards. It is used by guards whose employer is a private security company that uses [APP NAME]. You need a one-time enrollment code from your supervisor to set up your phone. The app does nothing without it.

WHAT YOU CAN DO
- See your assigned shifts and the site for each.
- Start your shift and end it.
- Scan the QR labels at patrol checkpoints. The app tells you if a scan was verified, and why if it was not.
- Report an incident: choose what happened, say how serious it is, add details and up to 5 photos.
- Use the app in English or Urdu.
- See the real state of your phone's connection. The app shows what your company's server has confirmed, and what is still saved on your phone.
- With no signal, the app saves your shift, scans and reports on the phone and sends them when the network returns.

EMPLOYEE MONITORING: PLEASE READ
This is an employee monitoring app. When you start a shift, it shares your phone's location with your employer's control room until the shift ends. It does this even when the app is closed or the screen is off, so you will be asked to allow location "all the time". While it runs, a notification stays on your phone.
- Location is collected only during your shift [ONLY WHEN SOS IS ON: and during an SOS]. Nothing is collected outside them.
- Before any permission is requested, the app shows a notice that explains what is collected, why, who sees it and how long it is kept. You must accept it.
- Your employer's staff see your location on their dashboard. Your employer decides how long it is kept; the default is 90 days.
- The app does not collect your contacts, microphone, messages, call history, other apps or photo library.
- The app has no advertising and no analytics.

[ONLY WHEN SOS IS ON]
SOS
Press and hold the SOS button for 3 seconds to alert your company's control room. SOS does not call the police, an ambulance or any other emergency service.
[END ONLY WHEN SOS IS ON]

PERMISSIONS
- Location, including "all the time": to share your location with your control room during your shift.
- Notifications: to show the tracking notification and shift messages.
- Camera: only to scan QR labels and take incident photos.

PRIVACY
Your employer is responsible for your shift data. [COMPANY LEGAL NAME] runs the service for your employer. Read our privacy policy at [PRIVACY POLICY URL].

SUPPORT
[SUPPORT EMAIL]
```

`[OWNER TO CONFIRM: the "default is 90 days" and "your employer decides" lines depend on the final tracking notice.]` Do not publish a description that says more than the in-app notice. The in-app notice is incomplete today (`docs/legal/GUARD_DISCLOSURE_CHECK.md`).

### 2.4 The monitoring disclosure (Play wants it in the listing, EXT-20)

This is a self-contained sentence you can also place at the top of the description:

```text
This is an employee monitoring app: while you are on a shift you start, it shares your phone's location with your employer.
```

### 2.5 What's new (up to 500 characters)

First release:

```text
First release for guards of companies that use [APP NAME]. Shifts, patrol scans and incident reports, in English and Urdu.
```

### 2.6 Apple promotional text (up to 170 characters)

```text
A work app for security guards: shifts, patrol checkpoints and incident reports. Needs an enrollment code from your employer.
```

### 2.7 Apple keywords (up to 100 characters)

```text
security guard,patrol,shift,checkpoint,incident,QR,roster,site
```

## 3. Urdu (SUGGESTIONS, for a native speaker to rewrite or reject)

Written by an assistant that reads Urdu but is not a native speaker. Terms follow the app's own Urdu text (`apps/mobile/src/core/i18n/ur.ts`), which also awaits review. For example the app uses "لوکیشن" for location in most places but "مقام" in the SOS text; the reviewer should pick one.

### 3.1 App name

```text
[APP NAME]
```

### 3.2 Short description (up to 80 characters, SUGGESTION)

```text
سیکیورٹی گارڈز کے لیے شفٹ، گشت اسکین اور واقعے کی رپورٹ۔
```

### 3.3 Full description (up to 4,000 characters, SUGGESTION)

```text
[APP NAME] سیکیورٹی گارڈز کے لیے کام کی ایپ ہے۔ اسے وہ گارڈز استعمال کرتے ہیں جن کا آجر ایک پرائیویٹ سیکیورٹی کمپنی ہو جو [APP NAME] استعمال کرتی ہے۔ فون سیٹ اپ کرنے کے لیے آپ کو اپنے سپروائزر سے ایک بار استعمال ہونے والا اندراج کوڈ چاہیے۔ اس کے بغیر ایپ کچھ نہیں کرتی۔

آپ کیا کر سکتے ہیں
- اپنی مقررہ شفٹیں اور ہر شفٹ کی سائٹ دیکھیں۔
- شفٹ شروع کریں اور ختم کریں۔
- گشت کے چیک پوائنٹس پر QR لیبل اسکین کریں۔ ایپ بتاتی ہے کہ اسکین کی تصدیق ہوئی یا نہیں، اور نہ ہونے کی وجہ کیا ہے۔
- واقعے کی رپورٹ کریں: بتائیں کیا ہوا، کتنا سنگین ہے، تفصیل لکھیں اور زیادہ سے زیادہ 5 تصاویر شامل کریں۔
- ایپ انگریزی یا اردو میں استعمال کریں۔
- نیٹ ورک کے نہ ہونے پر ایپ آپ کی شفٹ، اسکین اور رپورٹیں فون پر محفوظ رکھتی ہے اور نیٹ ورک واپس آنے پر بھیج دیتی ہے۔

ملازمین کی نگرانی: براہِ کرم پڑھیں
یہ ملازمین کی نگرانی کی ایپ ہے۔ جب آپ شفٹ شروع کرتے ہیں تو یہ شفٹ ختم ہونے تک آپ کے فون کی لوکیشن آپ کے آجر کے کنٹرول روم کو بھیجتی ہے۔ ایپ بند ہو یا اسکرین بند ہو، تب بھی ایسا ہوتا ہے، اس لیے آپ سے لوکیشن "ہر وقت" کی اجازت مانگی جائے گی۔ ٹریکنگ کے دوران آپ کے فون پر ایک نوٹیفکیشن موجود رہتا ہے۔
- لوکیشن صرف آپ کی شفٹ کے دوران جمع ہوتی ہے۔ اس کے علاوہ کچھ جمع نہیں ہوتا۔
- کوئی اجازت مانگنے سے پہلے ایپ ایک نوٹس دکھاتی ہے جس میں بتایا جاتا ہے کہ کیا جمع ہوتا ہے، کیوں، کون دیکھتا ہے اور کتنی دیر رکھا جاتا ہے۔ اسے قبول کرنا ضروری ہے۔
- آپ کے آجر کا عملہ آپ کی لوکیشن اپنے ڈیش بورڈ پر دیکھتا ہے۔ کتنی دیر رکھنی ہے یہ آپ کا آجر طے کرتا ہے؛ عام ترتیب 90 دن ہے۔
- ایپ آپ کے رابطے، مائیکروفون، پیغامات، کال کی تاریخ، دوسری ایپس یا فوٹو لائبریری جمع نہیں کرتی۔
- ایپ میں اشتہارات یا تجزیاتی ٹولز نہیں ہیں۔

اجازتیں
- لوکیشن، بشمول "ہر وقت": شفٹ کے دوران اپنی لوکیشن کنٹرول روم کو بھیجنے کے لیے۔
- نوٹیفکیشنز: ٹریکنگ کا نوٹیفکیشن اور شفٹ کے پیغامات دکھانے کے لیے۔
- کیمرا: صرف QR لیبل اسکین کرنے اور واقعے کی تصاویر لینے کے لیے۔

پرائیویسی
آپ کی شفٹ کے ڈیٹا کی ذمہ داری آپ کے آجر پر ہے۔ [COMPANY LEGAL NAME] آپ کے آجر کے لیے سروس چلاتی ہے۔ ہماری پرائیویسی پالیسی یہاں پڑھیں: [PRIVACY POLICY URL]۔

مدد
[SUPPORT EMAIL]
```

The SOS paragraph is left out of the Urdu suggestion. When SOS is on, a native speaker should write it from the English, and must keep the sentence that SOS does not call the police or an ambulance. The app already has that sentence in Urdu (`sos.disclaimer`), so the store text should reuse it once the reviewer approves it.

### 3.4 What's new (SUGGESTION)

```text
[APP NAME] کی پہلی ریلیز۔ شفٹ، گشت اسکین اور واقعے کی رپورٹ، انگریزی اور اردو میں۔
```

## 4. Screenshots plan

Use only the **demo organization** (`REVIEW_NOTES.md`). No real person, phone number, site or map of a real place.

| #   | Screen          | What it shows                                                         | Caption (English; plain)                   |
| --- | --------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| 1   | Home            | Today's shift, "Not started", Start shift button                      | "See your shifts"                          |
| 2   | Tracking notice | The final reviewed notice (top part)                                  | "Read what is collected before you start"  |
| 3   | Active shift    | "SHIFT ACTIVE", tracking status line, patrol, report incident buttons | "Start and end your shift"                 |
| 4   | Notification    | The tracking notification in the Android shade                        | "A notification shows while tracking runs" |
| 5   | Patrol rounds   | A round with checkpoints and "to do" or "verified"                    | "Scan patrol checkpoints"                  |
| 6   | Scan result     | "Verified: [demo checkpoint]"                                         | "See the result of each scan"              |
| 7   | Incident report | Type, severity, photos                                                | "Report incidents with photos"             |
| 8   | Offline state   | "Offline — 3 updates waiting"                                         | "Works without signal and sends later"     |
| 9   | Language        | The language choice, or Urdu home screen                              | "English and Urdu"                         |

**Rules.** Use the final build. Show the dark theme (the app's default). Take an Urdu set as well, only after the native-speaker review; right-to-left layout. Leave out the SOS screen unless SOS is on in the reviewed build (then use the drill). Captions must not promise accuracy, speed or safety.

**Formats** `[OWNER TO CONFIRM against each store's current rules]`: Google Play needs an icon of 512 by 512 pixels, a feature graphic of 1,024 by 500 pixels and at least 2 phone screenshots (up to 8). Apple needs screenshots for the required iPhone sizes. The icon art is under `apps/mobile/assets/`. The wordmark is AI-generated and awaits a legal check (`docs/DECISIONS.md`, Brand).

## 5. Category, age and contact fields

| Field           | Suggestion                                                                                         | Note                                                                |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Category        | Business `[OWNER TO CONFIRM]`                                                                      | A B2B work app                                                      |
| Content rating  | Complete the questionnaire honestly. The app has no user-to-user content, no ads and no purchases. |                                                                     |
| Target audience | Adults (18+) `[LAWYER: minimum age for guards]`                                                    |                                                                     |
| Contact email   | `[SUPPORT EMAIL]`                                                                                  |                                                                     |
| Website         | `[DOMAIN]`                                                                                         |                                                                     |
| Privacy policy  | `[PRIVACY POLICY URL]`                                                                             | Must be live before submission (`docs/PRODUCT_SPEC.md` §17; EXT-16) |
| Pricing         | Free to download. The employer pays the company; `[OWNER TO CONFIRM]`                              | Billing is outside the app                                          |

## 6. Where each claim comes from

| Claim in the texts                                                                                      | Source                                                        |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Needs an enrollment code from the supervisor; no self-sign-up                                           | `docs/PRODUCT_SPEC.md` §4.2, §4.3                             |
| See shifts, start and end a shift                                                                       | `PRODUCT_SPEC.md` §6.4, §6.6, §7.5                            |
| Patrol QR scans and the verification states                                                             | `PRODUCT_SPEC.md` §7.7, §9.3                                  |
| Incident type, severity, details, up to 5 photos                                                        | `PRODUCT_SPEC.md` §7.8, §10                                   |
| English and Urdu                                                                                        | `docs/DECISIONS.md` D-14; `apps/mobile/src/core/i18n/`        |
| The app shows what the server confirmed and what is still on the phone                                  | `PRODUCT_SPEC.md` §7.6; `SECURITY_AND_INVARIANTS.md` INV-16   |
| Saves with no signal and sends later                                                                    | `PRODUCT_SPEC.md` §7.1; `docs/ARCHITECTURE.md` §8.6           |
| Location shared with the control room during a shift, also when the screen is off; a notification stays | `PRODUCT_SPEC.md` §8.1, §16; `ARCHITECTURE.md` §8.2           |
| Nothing collected outside a shift [and an SOS]                                                          | `SECURITY_AND_INVARIANTS.md` INV-08                           |
| Notice before any permission; must be accepted                                                          | `PRODUCT_SPEC.md` §7.2                                        |
| Staff see location on the dashboard; default 90 days; the employer decides                              | `PRODUCT_SPEC.md` §3.2, Appendix B                            |
| No contacts, microphone, messages, calls, other apps, photo-library browsing                            | `PRODUCT_SPEC.md` §16; `apps/mobile/android-permissions.ts`   |
| No advertising or analytics                                                                             | `apps/mobile/DEPENDENCIES.md`; `PRODUCT_SPEC.md` §2.2         |
| Camera only for QR and incident photos                                                                  | `apps/mobile/src/ui/screens/QrScanner.tsx`, `PhotoCamera.tsx` |
| SOS: hold 3 seconds; alerts the control room; does not call the police or an ambulance                  | `PRODUCT_SPEC.md` §11.1; `en.ts` `sos.disclaimer`             |
| Employer responsible; the company runs the service for the employer                                     | `docs/legal/PRIVACY_POLICY.md` section 2 `[LAWYER]`           |

**Claims deliberately left out** because the product cannot back them yet: battery use (a target, not a result), accuracy of location, delivery or response times, "works on every phone" (device matrix pending), certifications, uptime.
