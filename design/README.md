# SENTRY — brand foundation (draft)

Status: **draft, pending product-owner approval** · derived on 2026-10-08 from the supplied wordmark.
Colour values below were measured from the image. The typeface match is approximate (see "Typography").

## Files

| File | What it is |
|---|---|
| `brand/sentry-wordmark-on-dark.png` | The supplied wordmark, unmodified. 2172 × 724 px, RGB, no embedded colour profile (treat as sRGB). Raster only. |
| `brand/` (vector, to come) | The owner has a vector version of the wordmark; it goes here once supplied. |

## Colour

| Role | Value | How it was measured |
|---|---|---|
| Background (flat) | `#12161B` | Median of every background pixel outside the lettering. Use this as the app background. |
| Background gradient — top | `#14171D` | The image darkens slightly from top to bottom. |
| Background gradient — bottom | `#0C0F15` | Darkest at the bottom-left corner (`#0B0E14`). |
| Wordmark letters | `#FAF9F9` | Median of the letter pixels; effectively white. |

- `#12161B` is a cool blue-black: hue 213°, saturation 20 %, lightness 8.8 %.
- Contrast of `#FAF9F9` on `#12161B` is **17.3 : 1** (WCAG AAA needs 7 : 1).
- This matches the spec's "dark theme by default" for night work (PROD §7.1). It also suits control-room screens that stay on all day.

## Typography

### The wordmark itself

Measured from the artwork:

- Extended (wide) letters: each is 1.1–1.4 × the cap height wide.
- Bold strokes: the vertical stem is about 0.24 × cap height; horizontal bars are slightly thinner.
- Very wide letter spacing: the gap between letters is about 0.75 × cap height.
- Squarish, rounded curves on S and R. The S terminals are cut on a diagonal. The R has a straight diagonal leg.

I rendered "SENTRY" in 24 open-licence display families and scored each letter's shape against the original. **None matches exactly.** The closest:

| Candidate | Match | Gap |
|---|---|---|
| **Orbitron** (weight 800–900) | Best overall shape score: squarish curves, same R construction | Narrower letters; S terminals are vertical, not diagonal |
| **Archivo**, width 125, weight 700 | Closest width and stroke weight | Round S and R (a grotesque, not squarish) |
| **Michroma** | Same lineage (Microgramma/Eurostile), right width | Much too thin; only one weight |

The diagonal S terminals look custom-drawn. **Rule: never retype the wordmark. Always use the artwork.**

### Proposed type system (for approval)

| Role | Typeface | Licence | Use |
|---|---|---|---|
| Wordmark | The artwork (PNG now, SVG once redrawn) | n/a | Logo, splash screen, sign-in, report headers |
| Display | **Orbitron 800** (closest free match); alternative: Archivo Expanded 700 if you want a more sober look | SIL OFL 1.1 | Short uppercase labels only: screen titles, status words (SHIFT ACTIVE, SOS), KPI numbers on dashboard tiles. At least 20 px, with tracking of about 0.08–0.15 em. |
| Text / UI | **Inter** (the platform system font is an acceptable alternative on mobile) | SIL OFL 1.1 | Everything else: body text, tables, forms, buttons, timestamps (tabular figures) |
| Urdu | **Noto Nastaliq Urdu** | SIL OFL 1.1 | All Urdu text. Needs about 1.8–2 × line height. Test on low-end Android early. |

Why the wordmark style isn't used for body text:

- Wide display faces become hard to read at small sizes.
- At 200 % system font size (a PROD §7.1 requirement) they overflow a 360 dp phone screen.
- They waste space in dense dashboard tables.
- None of them contains Urdu glyphs.

## Usage rules (draft)

- Clear space around the wordmark: at least the cap height (the height of the S) on every side.
- Minimum on-screen width: 120 px, which puts the cap height at about 11 px.
- Use it only on `#12161B` or the gradient above until light-background and one-colour versions exist.
- Do not stretch, outline, recolour, add effects to, or retype the wordmark.

## Open items

1. **Source of the wordmark (answered 2026-10-08).** It was made with OpenAI's image generator, so no source font exists, and the type system above stands. A vector file exists and goes in `brand/`. Copyright may not protect AI-generated artwork. Registering the trademark protects the brand, and a designer's vector redraw strengthens the claim. Both go to the legal review (`docs/DECISIONS.md`, "Brand").
2. **Name clearance.** "SENTRY" is final for now. Check it for trademark and App Store availability. Note the collision with Sentry (sentry.io), the error-tracking product named in ARCH §2.
3. **Light and one-colour versions.** Printed QR label sheets and CSV/PDF reports sit on white. Printing white-on-navy wastes toner and fades.
4. **App icon.** A six-letter extended wordmark is unreadable at launcher size (48 dp). The app needs a symbol or an "S" monogram.
5. **Status palette.** Alert severities and freshness states must reach WCAG AA contrast on `#12161B`. Colour must never be the only signal (PROD §14.7). For the dashboard, checked on 2026-11-10 against its own surfaces: see "Dashboard look" below.

## Dashboard look (2026-11-10, after the owner's reference)

The owner asked for the dashboard to look like a reference design: a dark graphite interface, a slim rail of icons, the map as the main thing on screen with frosted panels floating over it, large numbers, and meters made of ticks. The values below are in `apps/web/app/globals.css` and `apps/web/lib/map-style.ts`. They were measured, not eyeballed.

| Role | Value | Contrast on a panel (`#212226`) |
|---|---|---|
| Canvas | `#17181B` (neutral graphite) | n/a |
| Rail | `#121315` | n/a |
| Panels | `rgb(35 36 40 / 72%)`, about `#212226` over the canvas | n/a |
| Text, secondary, faint | `#EDECE7`, `#A6A7AD`, `#8F9097` | 13.4 : 1, 6.6 : 1, 5.0 : 1 |
| Primary button | `#EDECE7` ("bone") with `#17181B` text | 15 : 1 |
| Live | `#80E2AC` | 10.1 : 1 |
| Delayed | `#E8A346` | 7.4 : 1 |
| Offline, SOS | `#E3455A` for marks; `#F07A88` for text | 4.0 : 1 for marks (at least 3 : 1 needed); 5.9 : 1 for text |
| Input borders | `#6B6C74` | 3.0 : 1 (WCAG 1.4.11 needs 3 : 1) |
| Sites on the map | `#B9C97E` | not a status colour |

- **Colour means a state.** The interface itself is graphite and bone, so live, delayed, offline and SOS are the only strong colours on screen. Each always comes with its word.
- **Colour-blind separation.** The three tracking colours were run through the dataviz palette validator, all pairs: the worst pair, delayed against live for deuteranopia, is ΔE 11.3 (OKLab × 100; at least 8 is the target), and for normal vision ΔE 19.1. Under deuteranopia red and green differ mostly in lightness, so the offline red is darker and the live green lighter. The validator's lightness-band check fails by design here: it is meant for chart series, and these colours are lighter so that they read as text.
- **Type.** Inter everywhere, labels in sentence case. Orbitron appears only in the SOS alarm's title, a status word (the type system above allows that).
- **Map.** OpenFreeMap's "dark" style, recoloured before the first frame to an olive-tinted graphite. Only paint changes; every address stays on the tile host the Content-Security-Policy allows (tested).
- **Wordmark.** Shown at 120 px, the minimum, in the top bar and on the sign-in card. The artwork carries its own `#12161B` box. The dashboard draws it with `mix-blend-mode: lighten` on an opaque surface lighter than that box, so the box vanishes and the letters stay exactly as drawn. **This departs from usage rule 3 above:** the letters now sit on `#17181B`, not `#12161B`. If you want the rule kept as written, the top bar and the sign-in card can use `#12161B`, which gives a darker frame around the content.
