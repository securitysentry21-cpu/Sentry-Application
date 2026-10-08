// Small building blocks for every screen: large, high-contrast, direction-aware (Urdu is RTL), with
// icon + text on every action and haptic feedback on critical ones (PROD §7.1). User text always
// renders as text (SEC §8).
import { type ReactNode, useEffect, useRef, useState } from 'react';
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
import { colors, space, TOUCH_MIN, type } from './theme.ts';

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
  const { textStyle } = useI18n();
  const size = type[kind];
  return (
    <Text
      style={[
        {
          color: toneColor[tone],
          fontSize: size,
          lineHeight: Math.round(size * textStyle.lineHeightFactor),
          fontWeight: kind === 'title' || kind === 'heading' ? '700' : '400',
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
  const background =
    kind === 'primary'
      ? colors.primary
      : kind === 'sos'
        ? colors.sos
        : kind === 'danger'
          ? colors.danger
          : colors.surfaceRaised;
  const foreground =
    kind === 'primary' ? colors.onPrimary : kind === 'secondary' ? colors.text : colors.onSos;
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
        { backgroundColor: background, opacity: inactive ? 0.5 : pressed ? 0.8 : 1 },
        kind === 'secondary' && styles.buttonOutline,
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
    <View style={[styles.banner, { borderColor: toneColor[tone] }]} accessibilityRole="alert">
      <Txt tone={tone}>{`${icon}  ${text}`}</Txt>
      {action ? (
        <Pressable accessibilityRole="button" onPress={action.onPress} style={styles.bannerAction}>
          <Text style={[styles.bannerActionText, { color: toneColor[tone] }]}>{action.label}</Text>
        </Pressable>
      ) : null}
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
      style={[styles.button, { backgroundColor: colors.sos, overflow: 'hidden' }]}
    >
      {/* The bar grows from the start edge (the right in Urdu). */}
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          start: 0,
          backgroundColor: '#8E1626',
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
  content: { flex: 1, padding: space.lg, gap: space.md },
  button: {
    minHeight: TOUCH_MIN,
    width: '100%',
    borderRadius: 14,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space.sm,
  },
  buttonOutline: { borderWidth: 1, borderColor: colors.border },
  buttonText: { fontSize: 19, fontWeight: '700', textAlign: 'center' },
  banner: {
    borderWidth: 2,
    borderRadius: 12,
    padding: space.md,
    backgroundColor: colors.surface,
    gap: space.sm,
  },
  bannerAction: { minHeight: 44, justifyContent: 'center' },
  bannerActionText: { fontSize: 17, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: 14, padding: space.lg, gap: space.sm },
  row: { paddingVertical: space.xs, gap: 2 },
  field: { gap: space.xs },
  input: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: space.md,
    color: colors.text,
    fontSize: 19,
    backgroundColor: colors.surface,
  },
  inputMultiline: { minHeight: 120, textAlignVertical: 'top', paddingVertical: space.md },
});
