import { useMutation } from '@tanstack/react-query';
import * as Device from 'expo-device';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
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
  const [relayURL, setRelayURL] = useState('');
  const [email, setEmail] = useState('');
  const [deviceName, setDeviceName] = useState(Device.deviceName ?? 'My phone');
  const [error, setError] = useState('');

  const signIn = useMutation({
    mutationFn: () =>
      createRelayDevice(normalizeRelayURL(relayURL), email.trim(), deviceName.trim()),
    onSuccess: async (session) => {
      await saveSession({
        relayURL: normalizeRelayURL(relayURL),
        email: session.user.email,
        deviceName: session.device.name,
        token: session.token,
        userID: session.user.id,
        deviceID: session.device.id,
      });
      router.dismissTo('/');
    },
    onError: (reason) => setError(explainRelayError(reason)),
  });

  const connect = () => {
    const validation = validateRelayDetails(relayURL, email, deviceName);
    if (validation) {
      setError(validation);
      return;
    }
    setRelayURL(normalizeRelayURL(relayURL));
    setError('');
    signIn.mutate();
  };

  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={[styles.safe, { backgroundColor: colors.sheet }]}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={88}
        style={styles.safe}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.intro}>
            <AppText style={styles.title}>Connect from anywhere</AppText>
            <AppText style={[styles.detail, { color: colors.muted }]}>
              Brio Relay keeps your environments available when your phone is away from their local
              network.
            </AppText>
          </View>

          <Card style={styles.formCard}>
            <FieldLabel>Relay URL</FieldLabel>
            <AppTextInput
              accessibilityLabel="Relay address"
              autoCapitalize="none"
              autoCorrect={false}
              inputMode="url"
              onChangeText={(value) => {
                setRelayURL(value);
                setError('');
              }}
              placeholder="https://relay.example.com"
              value={relayURL}
            />

            <FieldLabel>Email</FieldLabel>
            <AppTextInput
              accessibilityLabel="Email"
              autoCapitalize="none"
              autoCorrect={false}
              inputMode="email"
              onChangeText={(value) => {
                setEmail(value);
                setError('');
              }}
              placeholder="owner@example.com"
              value={email}
            />

            <FieldLabel>Device name</FieldLabel>
            <AppTextInput
              accessibilityLabel="Device name"
              autoCapitalize="words"
              autoCorrect={false}
              onChangeText={(value) => {
                setDeviceName(value);
                setError('');
              }}
              onSubmitEditing={connect}
              placeholder="My phone"
              returnKeyType="go"
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
              onPress={connect}
            >
              {signIn.isPending ? 'Connecting…' : 'Connect relay'}
            </Button>
          </Card>

          <AppText style={[styles.note, { color: colors.muted }]}>
            Use the Relay address provided by your administrator. Your device stays signed in
            securely.
          </AppText>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function FieldLabel({ children }: { children: string }) {
  const colors = useT3Theme();
  return <AppText style={[styles.fieldLabel, { color: colors.muted }]}>{children}</AppText>;
}

function normalizeRelayURL(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(trimmed);
  return `${local ? 'http' : 'https'}://${trimmed}`;
}

function validateRelayDetails(relayURL: string, email: string, deviceName: string) {
  const normalizedURL = normalizeRelayURL(relayURL);
  try {
    const parsed = new URL(normalizedURL);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch {
    return 'Enter a valid Relay address, such as https://relay.example.com.';
  }
  if (!/^\S+@\S+\.\S+$/.test(email.trim())) return 'Enter a valid email address.';
  if (!deviceName.trim()) return 'Give this device a recognizable name.';
  return '';
}

function explainRelayError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : '';
  const normalized = message.toLowerCase();
  if (
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('timed out') ||
    normalized.includes('abort')
  ) {
    return 'Brio could not reach that Relay. Check the address and your internet connection, then try again.';
  }
  return message || 'Brio could not connect to that Relay. Check the details and try again.';
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
  intro: {
    alignItems: 'center',
    gap: T3Spacing.xs,
    marginBottom: T3Spacing.sm,
    paddingHorizontal: T3Spacing.md,
  },
  title: {
    fontFamily: T3Typography.bold,
    fontSize: 21,
    lineHeight: 27,
    textAlign: 'center',
  },
  detail: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  fieldLabel: {
    fontFamily: T3Typography.bold,
    fontSize: 11,
    letterSpacing: 0.8,
    marginBottom: -4,
    textTransform: 'uppercase',
  },
  error: { borderRadius: 10, padding: T3Spacing.md },
  errorText: { fontSize: 13, lineHeight: 18 },
  note: {
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: T3Spacing.xs,
    textAlign: 'center',
  },
});
