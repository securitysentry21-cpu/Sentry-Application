import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

// Brand foundation: design/README.md. The guard app is dark by default for night work (PROD §7.1).
const BG = '#12161B';
const FG = '#FAF9F9';
const MUTED = '#A7ADB5';

export default function App() {
  return (
    <View style={styles.screen}>
      <Text style={styles.wordmark} accessibilityRole="header">
        SENTRY
      </Text>
      <Text style={styles.note}>Guard app — Phase 0 skeleton</Text>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center', padding: 24 },
  wordmark: { color: FG, fontSize: 36, fontWeight: '700', letterSpacing: 12 },
  note: { color: MUTED, fontSize: 16, marginTop: 16 },
});
