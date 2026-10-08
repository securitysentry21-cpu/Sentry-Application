// Visual foundation (design/README.md; PROD §7.1): dark by default for night work, high contrast,
// large touch targets. Colour is never the only signal: every state also has words.
export const colors = {
  background: '#12161B',
  surface: '#1B2128',
  surfaceRaised: '#232B34',
  border: '#323B46',
  text: '#FAF9F9',
  muted: '#B4BAC2',
  // Status colours, all ≥ 4.5:1 on the background (WCAG AA for normal text).
  ok: '#5FD38D',
  warning: '#F5C451',
  danger: '#FF6B6B',
  info: '#7DB7FF',
  // Filled buttons.
  primary: '#FAF9F9',
  onPrimary: '#12161B',
  sos: '#D7263D',
  onSos: '#FFFFFF',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Primary actions are at least 64 dp tall and full width (PROD §7.1). */
export const TOUCH_MIN = 64;

export const type = {
  title: 26,
  heading: 20,
  body: 17,
  small: 14,
  /** Urdu (Nastaliq) needs roughly twice the line height of Latin text (design/README.md). */
  urduLineHeight: 2,
  latinLineHeight: 1.35,
} as const;
