import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Button, Card } from '@/components/t3-ui';
import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';

export function EnvironmentOnboardingScreen() {
  const colors = useT3Theme();
  const router = useRouter();

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.screen }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.brandBlock}>
          <View style={[styles.brandMark, { backgroundColor: colors.primary }]}>
            <AppText style={[styles.brandLetter, { color: colors.primaryForeground }]}>B</AppText>
          </View>
          <AppText style={styles.brand}>Brio</AppText>
          <AppText style={[styles.tagline, { color: colors.muted }]}>Hermes Agent, wherever you are.</AppText>
        </View>

        <Card style={styles.emptyCard}>
          <View style={[styles.environmentIcon, { backgroundColor: colors.subtle }]}>
            <SymbolView
              name="point.3.connected.trianglepath.dotted"
              size={23}
              tintColor={colors.secondary}
            />
          </View>
          <AppText style={styles.emptyTitle}>No environments connected</AppText>
          <AppText style={[styles.emptyDetail, { color: colors.muted }]}>
            Pair this device with Brio Companion to load Hermes conversations and start tasks remotely.
          </AppText>
          <Button onPress={() => router.push('/connect')} style={styles.primaryAction}>
            Add environment
          </Button>
        </Card>

        <View style={styles.instructions}>
          <AppText style={[styles.sectionLabel, { color: colors.muted }]}>How it works</AppText>
          <Instruction index="1" text="Run Brio Companion beside Hermes Agent." />
          <Instruction index="2" text="Scan its QR code or paste the host and pairing code." />
          <Instruction index="3" text="Brio verifies Hermes before saving the environment." />
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/relay')}
          style={({ pressed }) => [
            styles.relayLink,
            { borderColor: colors.border, opacity: pressed ? 0.6 : 1 },
          ]}>
          <View style={styles.relayCopy}>
            <AppText style={styles.relayTitle}>Use Brio Relay</AppText>
            <AppText style={[styles.relayDetail, { color: colors.muted }]}>
              Sign in to discover and enroll persistent remote environments.
            </AppText>
          </View>
          <AppText style={{ color: colors.tertiary }}>›</AppText>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Instruction({ index, text }: { index: string; text: string }) {
  const colors = useT3Theme();
  return (
    <View style={styles.instruction}>
      <View style={[styles.step, { backgroundColor: colors.subtleStrong }]}>
        <AppText style={styles.stepText}>{index}</AppText>
      </View>
      <AppText style={[styles.instructionText, { color: colors.secondary }]}>{text}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    alignSelf: 'center',
    gap: T3Spacing.xxl,
    maxWidth: 560,
    padding: T3Spacing.xl,
    paddingBottom: T3Spacing.huge,
    width: '100%',
  },
  brandBlock: { alignItems: 'center', gap: T3Spacing.xs, paddingBottom: T3Spacing.sm, paddingTop: T3Spacing.xxl },
  brandMark: { alignItems: 'center', borderRadius: T3Radius.medium, height: 52, justifyContent: 'center', marginBottom: T3Spacing.sm, width: 52 },
  brandLetter: { fontFamily: T3Typography.bold, fontSize: 24, lineHeight: 30 },
  brand: { fontFamily: T3Typography.bold, fontSize: 30, lineHeight: 36 },
  tagline: { fontSize: 14, lineHeight: 19 },
  emptyCard: { alignItems: 'center', gap: T3Spacing.md, padding: T3Spacing.xxl },
  environmentIcon: { alignItems: 'center', borderRadius: T3Radius.medium, height: 52, justifyContent: 'center', width: 52 },
  emptyTitle: { fontFamily: T3Typography.bold, fontSize: 18, lineHeight: 23, textAlign: 'center' },
  emptyDetail: { fontSize: 14, lineHeight: 20, maxWidth: 380, textAlign: 'center' },
  primaryAction: { marginTop: T3Spacing.xs, width: '100%' },
  instructions: { gap: T3Spacing.md, paddingHorizontal: T3Spacing.xs },
  sectionLabel: { fontFamily: T3Typography.bold, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  instruction: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.md },
  step: { alignItems: 'center', borderRadius: T3Radius.pill, height: 28, justifyContent: 'center', width: 28 },
  stepText: { fontFamily: T3Typography.bold, fontSize: 12 },
  instructionText: { flex: 1, fontSize: 14, lineHeight: 19 },
  relayLink: { alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', paddingHorizontal: T3Spacing.xs, paddingTop: T3Spacing.lg },
  relayCopy: { flex: 1 },
  relayTitle: { fontFamily: T3Typography.medium, fontSize: 14 },
  relayDetail: { fontSize: 12, lineHeight: 17 },
});
