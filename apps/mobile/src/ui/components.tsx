// Small building blocks for every screen: large, high-contrast, direction-aware (Urdu is RTL), with
// icon + text on every action and haptic feedback on critical ones (PROD §7.1). User text always
// renders as text (SEC §8). The look is the dashboard's: graphite cards with hairline edges, bone
// for the main action, a state's colour only where there is a state, and filled red only for SOS.
import { Children, Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextStyle,
  Vibration,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useI18n } from './context.tsx';
import { colors, radius, space, tints, TOUCH_MIN, type } from './theme.ts';

export type Tone = 'default' | 'muted' | 'ok' | 'warning' | 'danger' | 'info';

const toneColor: Record<Tone, string> = {
  default: colors.text,
  muted: colors.muted,
  ok: colors.ok,
  warning: colors.warning,
  danger: colors.danger,
  info: colors.info,
};

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const { rtl } = useI18n();
  const content = <View style={[styles.content, { direction: rtl ? 'rtl' : 'ltr' }]}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}

export function Txt({
  children,
  kind = 'body',
  tone = 'default',
  style,
  center = false,
}: {
  children: ReactNode;
  kind?: 'title' | 'heading' | 'body' | 'small';
  tone?: Tone;
  style?: TextStyle;
  center?: boolean;
}) {
  const { textStyle, rtl } = useI18n();
  const size = type[kind];
  return (
    <Text
      style={[
        {
          color: toneColor[tone],
          fontSize: size,
          lineHeight: Math.round(size * textStyle.lineHeightFactor),
          fontWeight: kind === 'title' ? '700' : kind === 'heading' ? '600' : '400',
          // Display text sits tighter in Latin only: spacing would break Nastaliq's joined letters.
          letterSpacing: rtl ? 0 : kind === 'title' ? -0.5 : kind === 'heading' ? -0.2 : 0,
          textAlign: center ? 'center' : textStyle.textAlign,
          writingDirection: textStyle.writingDirection,
        },
        style,
      ]}
      accessibilityRole={kind === 'title' ? 'header' : undefined}
    >
      {children}
    </Text>
  );
}

export function Button({
  label,
  icon,
  onPress,
  kind = 'primary',
  disabled = false,
  busy = false,
}: {
  label: string;
  icon?: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'sos';
  disabled?: boolean;
  busy?: boolean;
}) {
  // Bone for the main action; danger is a red outline, so that filled red means SOS only.
  const look = {
    primary: { background: colors.primary, foreground: colors.onPrimary, border: colors.primary },
    secondary: { background: 'rgba(255, 255, 255, 0.06)', foreground: colors.text, border: colors.border },
    danger: { background: tints.danger.background, foreground: colors.danger, border: tints.danger.border },
    sos: { background: colors.sos, foreground: colors.onSos, border: colors.sos },
  }[kind];
  const foreground = look.foreground;
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={() => {
        Vibration.vibrate(15);
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: look.background,
          borderColor: look.border,
          opacity: inactive ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator color={foreground} /> : null}
      <Text style={[styles.buttonText, { color: foreground }]}>
        {icon ? `${icon}  ` : ''}
        {label}
      </Text>
    </Pressable>
  );
}

export function Banner({
  tone,
  text,
  action,
}: {
  tone: 'info' | 'warning' | 'danger' | 'ok';
  text: string;
  action?: { label: string; onPress: () => void };
}) {
  const icon = tone === 'danger' || tone === 'warning' ? '⚠' : tone === 'ok' ? '✓' : 'ⓘ';
  return (
    <View
      style={[styles.banner, { backgroundColor: tints[tone].background, borderColor: tints[tone].border }]}
      accessibilityRole="alert"
    >
      <Txt tone={tone}>{`${icon}  ${text}`}</Txt>
      {action ? (
        <Pressable accessibilityRole="button" onPress={action.onPress} style={styles.bannerAction}>
          <Text style={[styles.bannerActionText, { color: toneColor[tone] }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A state as a word in a tinted capsule, with a dot: the dashboard's badge. */
export function Pill({ tone, text }: { tone: Tone; text: string }) {
  const { textStyle } = useI18n();
  const tint =
    tone === 'ok' || tone === 'warning' || tone === 'danger' || tone === 'info'
      ? tints[tone]
      : { background: 'rgba(255, 255, 255, 0.07)', border: colors.border };
  return (
    <View style={[styles.pill, { backgroundColor: tint.background, borderColor: tint.border }]}>
      <View style={[styles.dot, { backgroundColor: toneColor[tone] }]} />
      <Text
        style={[
          styles.pillText,
          {
            color: toneColor[tone],
            lineHeight: Math.round(type.small * textStyle.lineHeightFactor),
            writingDirection: textStyle.writingDirection,
          },
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

/** A status sentence led by a dot of its colour (tracking, sync, the shift's own line). */
export function StatusLine({ tone, text }: { tone: Tone; text: string }) {
  const { textStyle } = useI18n();
  // The dot sits on the first line, however tall the language's lines are.
  const lineHeight = Math.round(type.body * textStyle.lineHeightFactor);
  return (
    <View style={styles.statusLine}>
      <View style={[styles.dot, { backgroundColor: toneColor[tone], marginTop: (lineHeight - 8) / 2 }]} />
      <Txt tone={tone} style={{ flex: 1 }}>
        {text}
      </Txt>
    </View>
  );
}

/** Secondary actions grouped in one card, one 64 dp row each, hairlines between. */
export function ListCard({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <View style={[styles.card, styles.listCard]}>
      {rows.map((row, i) => (
        <Fragment key={i}>
          {i > 0 ? <View style={styles.separator} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

export function ListRow({
  icon,
  label,
  onPress,
  chevron = true,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  /** Leads somewhere else (a chevron), or acts here (none). */
  chevron?: boolean;
}) {
  const { rtl, textStyle } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        Vibration.vibrate(15);
        onPress();
      }}
      style={({ pressed }) => [styles.listRow, pressed && styles.listRowPressed]}
    >
      <View style={styles.listIcon}>
        <Text style={styles.listIconText}>{icon}</Text>
      </View>
      <Text
        style={[
          styles.listLabel,
          {
            lineHeight: Math.round(18 * textStyle.lineHeightFactor),
            textAlign: textStyle.textAlign,
            writingDirection: textStyle.writingDirection,
          },
        ]}
      >
        {label}
      </Text>
      {chevron ? <Text style={styles.chevron}>{rtl ? '‹' : '›'}</Text> : null}
    </Pressable>
  );
}

/** A card's title with something beside it (a status pill), wrapping when the name is long. */
export function CardHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <View style={styles.cardHead}>
      <Txt kind="heading" style={{ flexShrink: 1 }}>
        {title}
      </Txt>
      {aside}
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Row({ label, value, tone = 'default' }: { label: string; value: string; tone?: Tone }) {
  return (
    <View style={styles.row}>
      <Txt kind="small" tone="muted">
        {label}
      </Txt>
      <Txt tone={tone}>{value}</Txt>
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  autoCapitalize = 'none',
  multiline = false,
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'phone-pad';
  autoCapitalize?: 'none' | 'characters' | 'sentences';
  multiline?: boolean;
  maxLength?: number;
}) {
  const { textStyle } = useI18n();
  return (
    <View style={styles.field}>
      <Txt kind="small" tone="muted">
        {label}
      </Txt>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        multiline={multiline}
        maxLength={maxLength}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          { textAlign: textStyle.textAlign, writingDirection: textStyle.writingDirection },
        ]}
      />
    </View>
  );
}

/**
 * Press and hold for `durationMs` (SOS: 3 s, PROD §11.1). A progress bar fills and the phone ticks
 * each second; letting go early cancels. No confirmation dialog afterwards.
 */
export function HoldButton({
  label,
  holdingLabel,
  durationMs,
  onComplete,
}: {
  label: string;
  holdingLabel: string;
  durationMs: number;
  onComplete: () => void;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const [holding, setHolding] = useState(false);
  const ticks = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (ticks.current) clearInterval(ticks.current);
    },
    [],
  );

  const begin = () => {
    setHolding(true);
    Vibration.vibrate(30);
    ticks.current = setInterval(() => Vibration.vibrate(30), 1_000);
    Animated.timing(progress, { toValue: 1, duration: durationMs, useNativeDriver: false }).start(
      ({ finished }) => {
        if (ticks.current) clearInterval(ticks.current);
        ticks.current = null;
        setHolding(false);
        progress.setValue(0);
        if (finished) {
          Vibration.vibrate([0, 120, 80, 120]);
          onComplete();
        }
      },
    );
  };
  const cancel = () => {
    progress.stopAnimation();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={label}
      onPressIn={begin}
      onPressOut={cancel}
      style={[styles.button, styles.sos]}
    >
      {/* The bar grows from the start edge (the right in Urdu). */}
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          start: 0,
          backgroundColor: colors.sosHold,
          width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        }}
      />
      <Text
        style={[styles.buttonText, { color: colors.onSos }]}
      >{`🆘  ${holding ? holdingLabel : label}`}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1 },
  content: { flex: 1, paddingHorizontal: 20, paddingVertical: space.xl, gap: 14 },
  button: {
    minHeight: TOUCH_MIN,
    width: '100%',
    borderRadius: radius.control,
    borderWidth: 1,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space.sm,
  },
  buttonText: { fontSize: 19, fontWeight: '700', textAlign: 'center' },
  // The one bold thing on a guard's screen: filled red with a red glow (boxShadow: New Architecture).
  sos: {
    backgroundColor: colors.sos,
    borderColor: colors.sos,
    overflow: 'hidden',
    // Cast downwards, so it does not tint the button above.
    boxShadow: '0 8px 24px 0 rgba(215, 38, 61, 0.4)',
  },
  banner: {
    borderWidth: 1,
    borderRadius: radius.banner,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    gap: space.sm,
  },
  bannerAction: { minHeight: 44, justifyContent: 'center' },
  bannerActionText: { fontSize: 17, fontWeight: '700' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    // A slightly lighter top edge, as if lit from above (the dashboard's panels).
    borderTopColor: 'rgba(255, 255, 255, 0.12)',
    padding: 18,
    gap: 10,
  },
  cardHead: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 4,
  },
  pillText: { fontSize: type.small, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  listCard: { padding: 0, gap: 0, overflow: 'hidden' },
  listRow: {
    minHeight: TOUCH_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  listRowPressed: { backgroundColor: 'rgba(255, 255, 255, 0.06)' },
  listIcon: {
    minWidth: 38,
    height: 38,
    paddingHorizontal: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  listIconText: { color: colors.text, fontSize: 17, fontWeight: '600' },
  listLabel: { flex: 1, color: colors.text, fontSize: 18, fontWeight: '600' },
  chevron: { color: colors.muted, fontSize: 26, fontWeight: '400' },
  separator: { height: 1, backgroundColor: colors.hairline, marginStart: 68 },
  row: { paddingVertical: space.xs, gap: 2 },
  field: { gap: 6 },
  input: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.fieldLine,
    borderRadius: radius.field,
    paddingHorizontal: 14,
    color: colors.text,
    fontSize: 19,
    backgroundColor: colors.well,
  },
  inputMultiline: { minHeight: 120, textAlignVertical: 'top', paddingVertical: space.md },
});
