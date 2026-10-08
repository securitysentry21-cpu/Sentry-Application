// React glue: the GuardApp's snapshot as React state, and the i18n helpers for the current language.
import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from 'react';

import type { AppSnapshot, GuardApp } from '../core/app.ts';
import { isRtl, type Locale, type Translate, translator } from '../core/i18n/index.ts';
import { type } from './theme.ts';

const AppContext = createContext<GuardApp | null>(null);

export function AppProvider({ app, children }: { app: GuardApp; children: ReactNode }) {
  return <AppContext.Provider value={app}>{children}</AppContext.Provider>;
}

export function useGuardApp(): GuardApp {
  const app = useContext(AppContext);
  if (!app) throw new Error('useGuardApp outside AppProvider');
  return app;
}

/** Re-renders whenever the engine's state changes. */
export function useSnapshot(): AppSnapshot {
  const app = useGuardApp();
  return useSyncExternalStore(
    (listener) => app.subscribe(listener),
    () => app.snapshot(),
  );
}

export type I18n = {
  readonly locale: Locale;
  readonly t: Translate;
  readonly rtl: boolean;
  /** Text alignment and writing direction for the current language. */
  readonly textStyle: {
    textAlign: 'left' | 'right';
    writingDirection: 'ltr' | 'rtl';
    lineHeightFactor: number;
  };
};

export function useI18n(): I18n {
  const { locale } = useSnapshot();
  return useMemo(() => {
    const rtl = isRtl(locale);
    return {
      locale,
      t: translator(locale),
      rtl,
      textStyle: {
        textAlign: rtl ? 'right' : 'left',
        writingDirection: rtl ? 'rtl' : 'ltr',
        lineHeightFactor: rtl ? type.urduLineHeight : type.latinLineHeight,
      },
    };
  }, [locale]);
}
