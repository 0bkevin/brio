import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Button } from '@/components/t3-ui';
import { T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';

export function EnvironmentOnboardingScreen() {
  const colors = useT3Theme();
  const router = useRouter();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.screen }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brandRow}>
          <View style={[styles.brandMark, { backgroundColor: colors.primary }]}>
            <AppText accessible={false} style={[styles.brandLetter, { color: colors.primaryForeground }]}>B</AppText>
          </View>
          <AppText style={styles.brand}>Brio</AppText>
        </View>

        <View style={styles.main}>
          <View style={styles.heroCopy}>
            <AppText style={styles.title}>Connect to Hermes</AppText>
            <AppText style={[styles.detail, { color: colors.muted }]}>Sign in to your Brio Relay, then enroll the computer running Hermes.</AppText>
          </View>

          <View style={styles.actions}>
            <Button
              accessibilityHint="Opens Brio Relay setup"
              onPress={() => router.push('/relay')}
            >
              Connect with Brio Relay
            </Button>
          </View>
          <AppText style={[styles.setupNote, { color: colors.tertiary }]}>After signing in, Brio generates the current Hermes enrollment command for you.</AppText>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    alignSelf: 'center',
    flexGrow: 1,
    maxWidth: 520,
    paddingBottom: T3Spacing.xl,
    paddingHorizontal: T3Spacing.xl,
    paddingTop: T3Spacing.xxl,
    width: '100%',
  },
  brandRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: T3Spacing.sm,
    justifyContent: 'center',
  },
  brandMark: {
    alignItems: 'center',
    borderRadius: 11,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  brandLetter: { fontFamily: T3Typography.bold, fontSize: 17, lineHeight: 22 },
  brand: { fontFamily: T3Typography.bold, fontSize: 21, lineHeight: 27 },
  main: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingBottom: T3Spacing.huge,
  },
  heroCopy: { alignItems: 'center', gap: T3Spacing.sm },
  title: {
    fontFamily: T3Typography.bold,
    fontSize: 32,
    letterSpacing: -0.9,
    lineHeight: 38,
    textAlign: 'center',
  },
  detail: { fontSize: 15, lineHeight: 21, maxWidth: 320, textAlign: 'center' },
  actions: { gap: T3Spacing.md, marginTop: T3Spacing.xxl, width: '100%' },
  setupNote: { fontSize: 12, lineHeight: 18, marginTop: T3Spacing.lg, maxWidth: 320, textAlign: 'center' },
});
