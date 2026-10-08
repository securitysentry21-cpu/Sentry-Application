// The guard app's root: builds the engine, keeps it informed (foreground, a 5-second tick for the
// failsafe and the "… ago" labels) and picks the screen from the engine's state. Navigation is a
// small state machine: no navigation library is needed for a handful of screens.
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, BackHandler, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { GuardApp } from '../core/app.ts';
import { translate } from '../core/i18n/index.ts';
import { errorKind } from '../core/log.ts';
import { getGuardApp } from '../platform/runtime.ts';
import { Screen, Txt } from './components.tsx';
import { AppProvider, useGuardApp, useSnapshot } from './context.tsx';
import { colors } from './theme.ts';
import { DiagnosticsScreen } from './screens/Diagnostics.tsx';
import { DisclosureScreen } from './screens/Disclosure.tsx';
import { EnrollmentScreen } from './screens/Enrollment.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { IncidentScreen } from './screens/Incident.tsx';
import { LanguageScreen } from './screens/Language.tsx';
import { ShiftScreen } from './screens/Shift.tsx';
import { SignedOutScreen } from './screens/SignedOut.tsx';
import { SosScreen } from './screens/Sos.tsx';
import { UpdateRequiredScreen } from './screens/UpdateRequired.tsx';

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'shift'; readonly shiftId: string }
  | { readonly name: 'incident'; readonly shiftId: string }
  | { readonly name: 'sos' }
  | { readonly name: 'diagnostics' }
  | { readonly name: 'language' };

export type Navigate = (route: Route) => void;

export default function App() {
  const [boot, setBoot] = useState<{ app: GuardApp } | { error: string } | null>(null);
  useEffect(() => {
    try {
      const app = getGuardApp();
      setBoot({ app });
      void app.start().then(() => app.onForeground());
    } catch (error) {
      setBoot({ error: errorKind(error) });
    }
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {boot === null ? null : 'error' in boot ? (
        // No engine, so no chosen language yet: say it in both.
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
          <Text style={{ color: colors.danger, fontSize: 17 }}>
            {translate('en', 'app.misconfigured', { reason: boot.error })}
          </Text>
          <Text
            style={{
              color: colors.danger,
              fontSize: 17,
              textAlign: 'right',
              writingDirection: 'rtl',
              lineHeight: 34,
            }}
          >
            {translate('ur', 'app.misconfigured', { reason: boot.error })}
          </Text>
        </View>
      ) : (
        <AppProvider app={boot.app}>
          <Root />
        </AppProvider>
      )}
    </SafeAreaProvider>
  );
}

function Root() {
  const app = useGuardApp();
  const snap = useSnapshot();
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [reEnroll, setReEnroll] = useState(false);

  // The app came to the front: re-read the phone and the server (ARCH §8.8).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void app.onForeground();
    });
    return () => subscription.remove();
  }, [app]);

  // Failsafe, heartbeats and "… ago" labels while the screens are open.
  useEffect(() => {
    const timer = setInterval(() => void app.tick(), 5_000);
    return () => clearInterval(timer);
  }, [app]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'home') return false;
      setRoute(route.name === 'incident' ? { name: 'shift', shiftId: route.shiftId } : { name: 'home' });
      return true;
    });
    return () => subscription.remove();
  }, [route]);

  useEffect(() => {
    if (snap.phase === 'READY') setReEnroll(false);
  }, [snap.phase]);

  switch (snap.phase) {
    case 'BOOTING':
      return (
        <Screen>
          <Txt kind="title" center>
            SENTRY
          </Txt>
        </Screen>
      );
    case 'STORAGE_ERROR':
      return (
        <Screen>
          <Txt kind="title">SENTRY</Txt>
          <Txt tone="danger">
            {translate(snap.locale, 'app.storageError', { reason: snap.storageError ?? 'unknown' })}
          </Txt>
        </Screen>
      );
    case 'CHOOSE_LANGUAGE':
      return <LanguageScreen onDone={() => setRoute({ name: 'home' })} />;
    case 'ENROLL':
      return <EnrollmentScreen />;
    case 'SIGNED_OUT':
      if (reEnroll) return <EnrollmentScreen onCancel={() => setReEnroll(false)} />;
      if (route.name === 'sos' && snap.settings.features.sos) return <SosScreen navigate={setRoute} />;
      return <SignedOutScreen onReEnroll={() => setReEnroll(true)} navigate={setRoute} />;
    case 'READY':
      break;
  }

  const tracking = Object.values(snap.localShifts).some((s) => s.tracking);
  if (snap.versionGate === 'REVOKED') return <UpdateRequiredScreen revoked navigate={setRoute} />;
  if (route.name === 'diagnostics') return <DiagnosticsScreen navigate={setRoute} />;
  if (route.name === 'sos' && snap.settings.features.sos) return <SosScreen navigate={setRoute} />;
  if (snap.versionGate === 'UPDATE_REQUIRED' && !tracking)
    return <UpdateRequiredScreen revoked={false} navigate={setRoute} />;
  // A new disclosure version is shown again before the next shift start (PROD §7.2), never mid-shift.
  if (snap.consent.required && !tracking) return <DisclosureScreen />;

  switch (route.name) {
    case 'shift':
      return <ShiftScreen shiftId={route.shiftId} navigate={setRoute} />;
    case 'incident':
      return <IncidentScreen shiftId={route.shiftId} navigate={setRoute} />;
    case 'language':
      return <LanguageScreen onDone={() => setRoute({ name: 'home' })} />;
    default:
      return <HomeScreen navigate={setRoute} />;
  }
}
