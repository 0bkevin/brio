import * as Device from 'expo-device';
import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, Button, Card } from '@/components/t3-ui';
import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
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
  const [connecting, setConnecting] = useState(false);
  const abortController = useRef<AbortController | null>(null);

  useEffect(() => () => abortController.current?.abort(), []);

  const connect = async () => {
    if (connecting) return;
    const validation = validateRelayDetails(relayURL, email, deviceName);
    if (validation) {
      setError(validation);
      return;
    }
    const details = {
      relayURL: normalizeRelayURL(relayURL),
      email: email.trim(),
      deviceName: deviceName.trim(),
    };
    const controller = new AbortController();
    abortController.current = controller;
    setRelayURL(details.relayURL);
    setError('');
    setConnecting(true);
    try {
      const session = await createRelayDevice(
        details.relayURL,
        details.email,
        details.deviceName,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      await saveSession({
        relayURL: details.relayURL,
        email: session.user.email,
        deviceName: session.device.name,
        token: session.token,
        userID: session.user.id,
        deviceID: session.device.id,
      });
      router.dismissTo('/');
    } catch (reason) {
      if (!controller.signal.aborted) setError(explainRelayError(reason));
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
      abortController.current = null;
    }
  };

  const close = () => {
    abortController.current?.abort();
    router.dismissTo('/');
  };

  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={[styles.safe, { backgroundColor: colors.sheet }]}
    >
      <Stack.Screen
        options={{
          gestureEnabled: !connecting,
          headerBackVisible: false,
          headerLeft: () => (
            <Pressable
              accessibilityLabel={connecting ? 'Cancel Relay connection' : 'Close Relay setup'}
              accessibilityRole="button"
              onPress={close}
              style={({ pressed }) => [styles.headerIcon, { opacity: pressed ? 0.5 : 1 }]}
            >
              <SymbolView name="xmark" size={17} tintColor={colors.foreground} />
            </Pressable>
          ),
          title: 'Connect Relay',
        }}
      />
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
            <View style={[styles.heroIcon, { backgroundColor: colors.subtleStrong }]}>
              <SymbolView name="network" size={25} tintColor={colors.foreground} />
            </View>
            <AppText style={styles.title}>Connect a development Relay</AppText>
            <AppText style={[styles.detail, { color: colors.muted }]}>For local testing with a Relay you control. This preview does not verify account ownership.</AppText>
          </View>

          <Card style={styles.formCard}>
            <FieldLabel>Relay address</FieldLabel>
            <AppTextInput
              accessibilityHint="The address of a development Relay you control"
              accessibilityLabel="Relay address"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!connecting}
              inputMode="url"
              onChangeText={(value) => {
                setRelayURL(value);
                setError('');
              }}
              placeholder="https://relay.example.com"
              value={relayURL}
            />

            <FieldLabel>Developer identity email</FieldLabel>
            <AppTextInput
              accessibilityLabel="Relay developer identity email"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!connecting}
              inputMode="email"
              onChangeText={(value) => {
                setEmail(value);
                setError('');
              }}
              placeholder="owner@example.com"
              value={email}
            />

            <FieldLabel>This phone</FieldLabel>
            <AppTextInput
              accessibilityHint="A recognizable name shown in the Relay"
              accessibilityLabel="Device name"
              autoCapitalize="words"
              autoCorrect={false}
              editable={!connecting}
              onChangeText={(value) => {
                setDeviceName(value);
                setError('');
              }}
              onSubmitEditing={() => void connect()}
              placeholder="My phone"
              returnKeyType="go"
              value={deviceName}
            />

            {error ? (
              <View accessibilityRole="alert" style={[styles.error, { backgroundColor: colors.dangerSurface }]}>
                <AppText style={[styles.errorTitle, { color: colors.danger }]}>Could not connect to Relay</AppText>
                <AppText style={[styles.errorText, { color: colors.secondary }]}>{error}</AppText>
              </View>
            ) : null}

            <Button
              disabled={!relayURL.trim() || !email.trim() || !deviceName.trim()}
              loading={connecting}
              onPress={() => void connect()}
            >
              {connecting ? 'Connecting…' : 'Continue to test environments'}
            </Button>
          </Card>

          <View style={[styles.privacyNote, { backgroundColor: colors.subtle }]}>
            <SymbolView name="info.circle" size={17} tintColor={colors.tertiary} />
            <AppText style={[styles.note, { color: colors.muted }]}>This development flow trusts the email you enter without verification. Do not use it with a public or untrusted Relay.</AppText>
          </View>

          <Button onPress={() => router.replace('/connect')} tone="plain">Connect directly instead</Button>
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
    return 'Check the Relay address and your internet connection, then try again.';
  }
  return message || 'Check the Relay details and try again.';
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerIcon: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  content: { alignSelf: 'center', gap: T3Spacing.lg, maxWidth: 620, padding: T3Spacing.xl, paddingBottom: T3Spacing.huge, width: '100%' },
  intro: { alignItems: 'center', gap: T3Spacing.sm, marginBottom: T3Spacing.sm, paddingHorizontal: T3Spacing.md },
  heroIcon: { alignItems: 'center', borderRadius: T3Radius.medium, height: 52, justifyContent: 'center', marginBottom: T3Spacing.xs, width: 52 },
  title: { fontFamily: T3Typography.bold, fontSize: 23, letterSpacing: -0.4, lineHeight: 29, textAlign: 'center' },
  detail: { fontSize: 14, lineHeight: 20, maxWidth: 430, textAlign: 'center' },
  formCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
  fieldLabel: { fontFamily: T3Typography.bold, fontSize: 11, letterSpacing: 0.8, marginBottom: -4, textTransform: 'uppercase' },
  error: { borderRadius: T3Radius.small, gap: 2, padding: T3Spacing.md },
  errorTitle: { fontFamily: T3Typography.bold, fontSize: 13, lineHeight: 18 },
  errorText: { fontSize: 13, lineHeight: 18 },
  privacyNote: { alignItems: 'flex-start', borderRadius: T3Radius.medium, flexDirection: 'row', gap: T3Spacing.sm, padding: T3Spacing.md },
  note: { flex: 1, fontSize: 12, lineHeight: 17 },
});
