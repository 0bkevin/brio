import { Redirect } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { T3Spacing } from '@/constants/t3-theme';
import { HermesProfilesScreen } from '@/features/profiles/hermes-profiles-screen';
import { useT3Theme } from '@/hooks/use-t3-theme';
import { useConnectionStore } from '@/state/connection-store';

export default function ProfilesRoute() {
  const colors = useT3Theme();
  const connection = useConnectionStore((state) => state.connection);

  if (!connection) return <Redirect href="/" />;

  return (
    <SafeAreaView
      edges={['left', 'right', 'bottom']}
      style={[styles.safe, { backgroundColor: colors.screen }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <HermesProfilesScreen connection={connection} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    alignSelf: 'center',
    maxWidth: 920,
    padding: T3Spacing.xl,
    paddingBottom: 56,
    width: '100%',
  },
});
