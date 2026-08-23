import { useAuth, useClerk, useUser } from '@clerk/expo';
import * as Device from 'expo-device';
import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CloudAuthView } from '@/components/cloud-auth-view';
import { AppText, AppTextInput, Button, Card } from '@/components/t3-ui';
import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import { createRelayDevice, revokeRelayDevice } from '@/lib/brio';
import {
  cloudAuthConfigured,
  configuredRelayURL,
  developmentAuthEnabled,
  relayTokenOptions,
} from '@/lib/cloud-auth';
import { useRelaySessionStore } from '@/state/relay-session-store';

export function RelaySignInScreen() {
  if (cloudAuthConfigured()) return <CloudRelaySignInScreen />;
  if (developmentAuthEnabled()) return <DevelopmentRelaySignInScreen />;
  return <UnconfiguredRelayScreen />;
}

function CloudRelaySignInScreen() {
  const router = useRouter();
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const { user } = useUser();
  const { signOut } = useClerk();
  const session = useRelaySessionStore((state) => state.session);
  const saveSession = useRelaySessionStore((state) => state.saveSession);
  const clearSession = useRelaySessionStore((state) => state.clearSession);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const registering = useRef('');
  const currentIdentity = useRef<string | null>(null);
  const mounted = useRef(false);
  const relayURL = configuredRelayURL();
  const sessionMatches = Boolean(
    session &&
      session.identitySubject === userId &&
      session.relayURL.replace(/\/+$/, '') === relayURL &&
      session.token &&
      session.deviceID,
  );

  useLayoutEffect(() => {
    currentIdentity.current = isSignedIn && userId ? userId : null;
  }, [isSignedIn, userId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (sessionMatches) router.dismissTo('/');
  }, [router, sessionMatches]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId || !user || sessionMatches) return;
    if (session?.identitySubject && session.identitySubject !== userId) return;
    if (registering.current) return;
    registering.current = userId;

    void (async () => {
      try {
        const identityToken = await getToken(relayTokenOptions());
        if (!identityToken) throw new Error('Your Brio Relay identity token could not be created.');
        const deviceName = Device.deviceName ?? `${Device.brand ?? 'Brio'} device`;
        const registration = await createRelayDevice(
          relayURL,
          user.primaryEmailAddress?.emailAddress ?? '',
          deviceName,
          identityToken,
        );
        if (currentIdentity.current !== userId) {
          await Promise.allSettled([
            revokeRelayDevice(relayURL, registration.token, registration.device.id),
          ]);
          return;
        }
        await saveSession({
          relayURL,
          email: registration.user.email || user.primaryEmailAddress?.emailAddress || userId,
          deviceName: registration.device.name,
          token: registration.token,
          userID: registration.user.id,
          deviceID: registration.device.id,
          identitySubject: userId,
        });
        if (currentIdentity.current !== userId) {
          await Promise.allSettled([
            revokeRelayDevice(relayURL, registration.token, registration.device.id),
            clearSession(),
          ]);
          return;
        }
        if (mounted.current) setError('');
      } catch (reason) {
        if (mounted.current && currentIdentity.current === userId) {
          setError(
            reason instanceof Error ? reason.message : 'This device could not be secured.',
          );
        }
      } finally {
        if (registering.current === userId) registering.current = '';
      }
    })();
  }, [
    attempt,
    clearSession,
    getToken,
    isLoaded,
    isSignedIn,
    relayURL,
    saveSession,
    session,
    sessionMatches,
    user,
    userId,
  ]);

  return (
    <RelayScreenFrame
      busy={Boolean(isSignedIn && !sessionMatches && !error)}
      detail="Sign in with your verified account. Brio will issue separate, revocable credentials for this phone."
      title="Connect to Brio Relay"
    >
      {!isLoaded ? (
        <View style={styles.centeredState}>
          <ActivityIndicator />
          <AppText>Loading secure sign-in…</AppText>
        </View>
      ) : !isSignedIn ? (
        <CloudAuthView />
      ) : error ? (
        <Card style={styles.formCard}>
          <AppText style={styles.errorTitle}>Could not activate Brio Relay</AppText>
          <AppText style={styles.errorText}>{error}</AppText>
          <Button onPress={() => setAttempt((value) => value + 1)}>Try again</Button>
          <Button onPress={() => void signOut()} tone="secondary">
            Sign out
          </Button>
        </Card>
      ) : (
        <View style={styles.centeredState}>
          <ActivityIndicator />
          <AppText>Securing this phone…</AppText>
        </View>
      )}
    </RelayScreenFrame>
  );
}

function DevelopmentRelaySignInScreen() {
  const router = useRouter();
  const saveSession = useRelaySessionStore((state) => state.saveSession);
  const [relayURL, setRelayURL] = useState('http://127.0.0.1:8082');
  const [email, setEmail] = useState('dev@brio.local');
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
        undefined,
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

  return (
    <RelayScreenFrame
      busy={connecting}
      detail="Use this unverified identity flow only with a local Relay started in insecure development mode."
      onClose={() => abortController.current?.abort()}
      title="Connect to a development Relay"
    >
      <Card style={styles.formCard}>
        <FieldLabel>Relay address</FieldLabel>
        <AppTextInput
          accessibilityHint="The loopback address of a development Relay"
          accessibilityLabel="Relay address"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!connecting}
          inputMode="url"
          onChangeText={(value) => {
            setRelayURL(value);
            setError('');
          }}
          placeholder="http://127.0.0.1:8082"
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
          placeholder="dev@brio.local"
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
          <View accessibilityRole="alert" style={styles.error}>
            <AppText style={styles.errorTitle}>Could not connect to Relay</AppText>
            <AppText style={styles.errorText}>{error}</AppText>
          </View>
        ) : null}

        <Button
          disabled={!relayURL.trim() || !email.trim() || !deviceName.trim()}
          loading={connecting}
          onPress={() => void connect()}
        >
          {connecting ? 'Connecting…' : 'Continue to environments'}
        </Button>
      </Card>
    </RelayScreenFrame>
  );
}

function UnconfiguredRelayScreen() {
  return (
    <RelayScreenFrame
      detail="This build does not contain a hosted Relay identity configuration."
      title="Brio Relay is not configured"
    >
      <Card style={styles.formCard}>
        <AppText style={styles.errorTitle}>A secure Relay build is required</AppText>
        <AppText style={styles.errorText}>
          Configure the Clerk publishable key, Brio JWT template, and HTTPS Relay URL when
          building the app. Unverified email access is available only in an explicitly enabled
          local development build.
        </AppText>
      </Card>
    </RelayScreenFrame>
  );
}

function RelayScreenFrame({
  busy = false,
  children,
  detail,
  onClose,
  title,
}: {
  busy?: boolean;
  children: ReactNode;
  detail: string;
  onClose?: () => void;
  title: string;
}) {
  const colors = useT3Theme();
  const router = useRouter();
  const close = () => {
    onClose?.();
    router.dismissTo('/');
  };

  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={[styles.safe, { backgroundColor: colors.sheet }]}
    >
      <Stack.Screen
        options={{
          gestureEnabled: !busy,
          headerBackVisible: false,
          headerLeft: () => (
            <Pressable
              accessibilityLabel={busy ? 'Cancel Relay connection' : 'Close Relay setup'}
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
            <AppText style={styles.title}>{title}</AppText>
            <AppText style={[styles.detail, { color: colors.muted }]}>{detail}</AppText>
          </View>
          {children}
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
  const loopback = /^(localhost|127\.|\[?::1\]?)(?::\d+)?$/i.test(trimmed);
  return `${loopback ? 'http' : 'https'}://${trimmed}`;
}

function validateRelayDetails(relayURL: string, email: string, deviceName: string) {
  const normalizedURL = normalizeRelayURL(relayURL);
  try {
    const parsed = new URL(normalizedURL);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
      return 'Remote Relay addresses must use HTTPS.';
    }
  } catch {
    return 'Enter a valid Relay address, such as http://127.0.0.1:8082.';
  }
  if (!/^\S+@\S+\.\S+$/.test(email.trim())) return 'Enter a valid email address.';
  if (!deviceName.trim()) return 'Give this device a recognizable name.';
  return '';
}

function isLoopbackHost(value: string) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
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
    return 'Check the Relay address and your network connection, then try again.';
  }
  return message || 'Check the Relay details and try again.';
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerIcon: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  content: {
    alignSelf: 'center',
    gap: T3Spacing.lg,
    maxWidth: 620,
    padding: T3Spacing.xl,
    paddingBottom: T3Spacing.huge,
    width: '100%',
  },
  intro: {
    alignItems: 'center',
    gap: T3Spacing.sm,
    marginBottom: T3Spacing.sm,
    paddingHorizontal: T3Spacing.md,
  },
  heroIcon: {
    alignItems: 'center',
    borderRadius: T3Radius.medium,
    height: 52,
    justifyContent: 'center',
    marginBottom: T3Spacing.xs,
    width: 52,
  },
  title: {
    fontFamily: T3Typography.bold,
    fontSize: 23,
    letterSpacing: -0.4,
    lineHeight: 29,
    textAlign: 'center',
  },
  detail: { fontSize: 14, lineHeight: 20, maxWidth: 430, textAlign: 'center' },
  formCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
  fieldLabel: {
    fontFamily: T3Typography.bold,
    fontSize: 11,
    letterSpacing: 0.8,
    marginBottom: -4,
    textTransform: 'uppercase',
  },
  centeredState: {
    alignItems: 'center',
    gap: T3Spacing.md,
    justifyContent: 'center',
    minHeight: 180,
  },
  error: { borderRadius: T3Radius.small, gap: 2, paddingVertical: T3Spacing.sm },
  errorTitle: { fontFamily: T3Typography.bold, fontSize: 13, lineHeight: 18 },
  errorText: { fontSize: 13, lineHeight: 18 },
});
