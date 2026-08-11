import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/t3-ui';
import { T3Spacing } from '@/constants/t3-theme';
import { EnvironmentOnboardingScreen } from '@/features/connection/environment-onboarding-screen';
import { RelayEnvironmentsScreen } from '@/features/connection/relay-environments-screen';
import { HermesHomeScreen } from '@/features/home/hermes-home-screen';
import { useT3Theme } from '@/hooks/use-t3-theme';
import { useConnectionStore } from '@/state/connection-store';
import { useRelaySessionStore } from '@/state/relay-session-store';

export default function HomeScreen() {
  const connectionHydrated = useConnectionStore((state) => state.hydrated);
  const connection = useConnectionStore((state) => state.connection);
  const relayHydrated = useRelaySessionStore((state) => state.hydrated);
  const relaySession = useRelaySessionStore((state) => state.session);

  if (!connectionHydrated || !relayHydrated) {
    return <LoadingScreen />;
  }
  if (connection) {
    return <HermesHomeScreen connection={connection} />;
  }
  if (relaySession) {
    return <RelayEnvironmentsScreen session={relaySession} />;
  }
  return <EnvironmentOnboardingScreen />;
}

function LoadingScreen() {
  const colors = useT3Theme();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.screen }]}>
      <View style={styles.loading}>
        <ActivityIndicator color={colors.foreground} />
        <AppText style={{ color: colors.muted }}>Loading Brio…</AppText>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  loading: { alignItems: 'center', flex: 1, gap: T3Spacing.md, justifyContent: 'center' },
});
