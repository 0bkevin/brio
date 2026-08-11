import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
            <AppText style={[styles.detail, { color: colors.muted }]}>Connect the Hermes Agent running on your computer.</AppText>
          </View>

          <View style={styles.actions}>
            <Button
              accessibilityHint="Opens the camera to scan your Hermes connection code"
              onPress={() => router.push({ pathname: '/connect', params: { mode: 'scan' } })}
            >
              Scan QR code
            </Button>
            <Button
              accessibilityHint="Opens a field for an existing connection code"
              onPress={() => router.push({ pathname: '/connect', params: { mode: 'paste' } })}
              tone="secondary"
            >
              Paste connection code
            </Button>
          </View>

          <Pressable
            accessibilityHint="Shows the computer setup command"
            accessibilityLabel="First time? Set up Hermes"
            accessibilityRole="button"
            onPress={() => router.push('/connect')}
            style={({ pressed }) => [styles.setupLink, { opacity: pressed ? 0.55 : 1 }]}
          >
            <AppText style={[styles.setupLabel, { color: colors.secondary }]}>First time? Set up Hermes</AppText>
            <AppText accessible={false} style={{ color: colors.tertiary }}>›</AppText>
          </Pressable>
        </View>

        <Pressable
          accessibilityHint="Connect through an existing Brio Relay"
          accessibilityLabel="Use Brio Relay"
          accessibilityRole="button"
          onPress={() => router.push('/relay')}
          style={({ pressed }) => [styles.relayLink, { opacity: pressed ? 0.55 : 1 }]}
        >
          <SymbolView accessible={false} name="network" size={15} tintColor={colors.tertiary} />
          <AppText style={[styles.relayLabel, { color: colors.tertiary }]}>Use Brio Relay</AppText>
        </Pressable>
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
  setupLink: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: T3Spacing.sm,
    justifyContent: 'center',
    marginTop: T3Spacing.lg,
    minHeight: 44,
    paddingHorizontal: T3Spacing.md,
  },
  setupLabel: { fontFamily: T3Typography.medium, fontSize: 13, lineHeight: 18 },
  relayLink: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 7,
    minHeight: 40,
    paddingHorizontal: T3Spacing.lg,
  },
  relayLabel: { fontFamily: T3Typography.medium, fontSize: 12, lineHeight: 17 },
});
