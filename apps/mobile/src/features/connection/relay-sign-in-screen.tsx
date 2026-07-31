import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, Button, Card } from '@/components/t3-ui';
import { T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import { createRelayDevice } from '@/lib/brio';
import { useRelaySessionStore } from '@/state/relay-session-store';

export function RelaySignInScreen() {
  const colors = useT3Theme();
  const router = useRouter();
  const saveSession = useRelaySessionStore((state) => state.saveSession);
  const [relayURL, setRelayURL] = useState('http://127.0.0.1:8082');
  const [email, setEmail] = useState('');
  const [deviceName, setDeviceName] = useState('Brio mobile');
  const [error, setError] = useState('');

  const signIn = useMutation({
    mutationFn: () => createRelayDevice(relayURL.trim(), email.trim(), deviceName.trim()),
    onSuccess: async (session) => {
      await saveSession({
        relayURL: relayURL.trim(),
        email: session.user.email,
        deviceName: session.device.name,
        token: session.token,
        userID: session.user.id,
        deviceID: session.device.id,
      });
      router.dismissTo('/');
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : 'Could not sign in.'),
  });

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.sheet }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Card style={styles.formCard}>
          <View style={styles.intro}>
            <AppText style={styles.title}>Connect to Brio Relay</AppText>
            <AppText style={[styles.detail, { color: colors.muted }]}>
              Relay environments remain attached to this device and can reconnect without a new pairing payload.
            </AppText>
          </View>

          <FieldLabel>Relay URL</FieldLabel>
          <AppTextInput
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            onChangeText={setRelayURL}
            placeholder="https://relay.example.com"
            value={relayURL}
          />

          <FieldLabel>Email</FieldLabel>
          <AppTextInput
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="email"
            onChangeText={setEmail}
            placeholder="owner@example.com"
            value={email}
          />

          <FieldLabel>Device name</FieldLabel>
          <AppTextInput
            autoCapitalize="words"
            autoCorrect={false}
            onChangeText={setDeviceName}
            placeholder="My phone"
            value={deviceName}
          />

          {error ? (
            <View style={[styles.error, { backgroundColor: colors.dangerSurface }]}>
              <AppText style={[styles.errorText, { color: colors.danger }]}>{error}</AppText>
            </View>
          ) : null}

          <Button
            disabled={!relayURL.trim() || !email.trim() || !deviceName.trim()}
            loading={signIn.isPending}
            onPress={() => {
              setError('');
              signIn.mutate();
            }}>
            {signIn.isPending ? 'Connecting…' : 'Connect relay'}
          </Button>
        </Card>

        <AppText style={[styles.note, { color: colors.muted }]}>
          Brio Relay currently uses lightweight device identity. Use a trusted relay deployment.
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

function FieldLabel({ children }: { children: string }) {
  const colors = useT3Theme();
  return <AppText style={[styles.fieldLabel, { color: colors.muted }]}>{children}</AppText>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    alignSelf: 'center',
    gap: T3Spacing.lg,
    maxWidth: 620,
    padding: T3Spacing.xl,
    width: '100%',
  },
  formCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
  intro: { gap: T3Spacing.xs, marginBottom: T3Spacing.sm },
  title: { fontFamily: T3Typography.bold, fontSize: 20, lineHeight: 26 },
  detail: { fontSize: 14, lineHeight: 20 },
  fieldLabel: {
    fontFamily: T3Typography.bold,
    fontSize: 11,
    letterSpacing: 0.8,
    marginBottom: -4,
    textTransform: 'uppercase',
  },
  error: { borderRadius: 10, padding: T3Spacing.md },
  errorText: { fontSize: 13, lineHeight: 18 },
  note: { fontSize: 12, lineHeight: 17, paddingHorizontal: T3Spacing.xs, textAlign: 'center' },
});
