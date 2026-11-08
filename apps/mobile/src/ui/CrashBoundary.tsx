// Catches an error thrown while a screen draws (ARCH §18.6): reports its class and code location,
// never its message, and shows a plain screen with a way back instead of a blank or dead app.
import { Component, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { GuardApp } from '../core/app.ts';
import { isRtl, translate } from '../core/i18n/index.ts';
import { colors } from './theme.ts';

type Props = { readonly app: GuardApp; readonly children: ReactNode };
type State = { readonly failed: boolean };

export class CrashBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    void this.props.app.reportError('RENDER_ERROR', error, false);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const locale = this.props.app.locale;
    const rtl = isRtl(locale);
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          padding: 24,
          gap: 16,
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: colors.text, fontSize: 26, fontWeight: '700' }}>SENTRY</Text>
        <Text
          style={{
            color: colors.danger,
            fontSize: 18,
            textAlign: rtl ? 'right' : 'left',
            writingDirection: rtl ? 'rtl' : 'ltr',
          }}
        >
          {translate(locale, 'app.crashed')}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => this.setState({ failed: false })}
          style={{ backgroundColor: colors.info, padding: 16, borderRadius: 8, minHeight: 56 }}
        >
          <Text style={{ color: colors.background, fontSize: 18, fontWeight: '700', textAlign: 'center' }}>
            {translate(locale, 'common.retry')}
          </Text>
        </Pressable>
      </View>
    );
  }
}
