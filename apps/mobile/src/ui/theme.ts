// Visual foundation (design/README.md, "Dashboard look"; PROD §7.1): the dashboard's graphite and
// bone, dark by default for night work, high contrast, large touch targets. Colour is never the only
// signal: every state also has words. Contrast ratios below were measured (WCAG 2), on the
// background and on a card.
export const colors = {
  background: '#17181B',
  surface: '#212226',
  surfaceRaised: '#2A2B30',
  /** Text fields. */
  well: '#121316',
  /** Hairlines around and between surfaces. */
  hairline: 'rgba(255, 255, 255, 0.08)',
  border: 'rgba(255, 255, 255, 0.14)',
  /** A text field's outline: 3:1 against a card and against the field itself (WCAG 1.4.11). */
  fieldLine: '#6B6C74',
  text: '#EDECE7',
  muted: '#A6A7AD',
  // States as text: 5.9:1 or more on a card, 6.6:1 or more on the background (WCAG AA).
  ok: '#80E2AC',
  warning: '#E8A346',
  danger: '#F07A88',
  info: '#8DB0E8',
  // Filled buttons. Filled red is the SOS button's alone.
  primary: '#EDECE7',
  onPrimary: '#17181B',
  sos: '#D7263D',
  onSos: '#FFFFFF',
  /** The SOS button filling while it is held. */
  sosHold: '#8E1626',
} as const;

/** A state's tinted surface and outline, behind text in that state's colour. */
export const tints = {
  ok: { background: 'rgba(128, 226, 172, 0.10)', border: 'rgba(128, 226, 172, 0.42)' },
  warning: { background: 'rgba(232, 163, 70, 0.11)', border: 'rgba(232, 163, 70, 0.48)' },
  danger: { background: 'rgba(227, 69, 90, 0.14)', border: 'rgba(227, 69, 90, 0.58)' },
  info: { background: 'rgba(141, 176, 232, 0.11)', border: 'rgba(141, 176, 232, 0.45)' },
} as const;

export const radius = { control: 16, card: 22, banner: 16, field: 14 } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Primary actions are at least 64 dp tall and full width (PROD §7.1). */
export const TOUCH_MIN = 64;

export const type = {
  title: 28,
  heading: 20,
  body: 17,
  small: 14,
  /** Urdu (Nastaliq) needs roughly twice the line height of Latin text (design/README.md). */
  urduLineHeight: 2,
  latinLineHeight: 1.35,
} as const;
