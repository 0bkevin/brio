import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, Button, Card } from '@/components/t3-ui';
import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  connectionFromPairingPayload,
  extractPairingPayload,
  finalizeConnection,
  type PairingPayload,
} from '@/lib/brio';
import { useConnectionStore } from '@/state/connection-store';

const HERMES_PAIRING_PROMPT = `I want to connect the Brio mobile app to this Hermes machine.

Please run "brio companion pair" and reply with only the pairing payload. If Brio Companion is not ready, run "brio companion status" and tell me the short reason.`;

export function AddEnvironmentScreen() {
  const colors = useT3Theme();
  const router = useRouter();
  const saveConnection = useConnectionStore((state) => state.saveConnection);
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [payload, setPayload] = useState<PairingPayload | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [scannerLocked, setScannerLocked] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const applyPayload = (raw: string) => {
    const parsed = extractPairingPayload(raw);
    setHost(parsed.url);
    setCode(parsed.token);
    setPayload(parsed);
    setError('');
    return parsed;
  };

  const pastePairingPayload = async () => {
    try {
      applyPayload(await Clipboard.getStringAsync());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Clipboard did not contain pairing details.');
    }
  };

  const copyHermesPrompt = async () => {
    await Clipboard.setStringAsync(HERMES_PAIRING_PROMPT);
  };

  const openScanner = async () => {
    if (Platform.OS === 'web') {
      setError('QR scanning is available in the iOS and Android app.');
      return;
    }
    if (cameraPermission?.granted) {
      setScannerLocked(false);
      setShowScanner(true);
      return;
    }
    const permission = await requestCameraPermission();
    if (permission.granted) {
      setScannerLocked(false);
      setShowScanner(true);
    } else {
      Alert.alert('Camera access needed', 'Allow camera access to scan a Brio pairing QR code.');
    }
  };

  const handleQrScan = ({ data }: { data: string }) => {
    if (scannerLocked) return;
    setScannerLocked(true);
    try {
      applyPayload(data);
      setShowScanner(false);
    } catch (reason) {
      Alert.alert(
        'Invalid QR code',
        reason instanceof Error ? reason.message : 'The QR code is not a Brio pairing payload.',
      );
    } finally {
      setTimeout(() => setScannerLocked(false), 600);
    }
  };

  const submit = async () => {
    if (!host.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const connection = connectionFromPairingPayload(
        payload ?? {
          url: normalizeHost(host),
          token: code.trim(),
          mode: 'direct',
          transport: 'direct',
        },
      );
      await saveConnection(await finalizeConnection(connection));
      router.dismissTo('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The environment could not be added.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.sheet }]}>
      <Stack.Screen
        options={{
          title: showScanner ? 'Scan QR Code' : 'Add Environment',
          headerRight: () => (
            <Pressable
              accessibilityLabel={showScanner ? 'Close scanner' : 'Scan QR code'}
              onPress={() => (showScanner ? setShowScanner(false) : void openScanner())}
              style={({ pressed }) => [styles.headerButton, { opacity: pressed ? 0.5 : 1 }]}>
              <SymbolView
                name={showScanner ? 'xmark' : 'qrcode.viewfinder'}
                size={19}
                tintColor={colors.foreground}
              />
            </Pressable>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {showScanner ? (
          cameraPermission?.granted ? (
            <View style={[styles.scanner, { borderColor: colors.border }]}>
              <CameraView
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={handleQrScan}
                style={styles.camera}
              />
            </View>
          ) : (
            <Card style={styles.permissionCard}>
              <AppText style={[styles.helpText, { color: colors.muted }]}>
                Camera permission is required to scan a pairing QR code.
              </AppText>
              <Button onPress={() => void openScanner()} tone="secondary">Allow camera</Button>
            </Card>
          )
        ) : (
          <>
            <Card style={styles.formCard}>
              <FieldLabel>Host</FieldLabel>
              <AppTextInput
                autoCapitalize="none"
                autoCorrect={false}
                inputMode="url"
                onChangeText={(value) => {
                  setHost(value);
                  setPayload(null);
                }}
                placeholder="192.168.1.100:8787"
                value={host}
              />

              <FieldLabel>Pairing code</FieldLabel>
              <AppTextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(value) => {
                  setCode(value);
                  setPayload(null);
                }}
                placeholder="Optional companion token"
                secureTextEntry={code.length > 0}
                value={code}
              />

              {payload?.transport === 'relay' ? (
                <View style={[styles.detected, { backgroundColor: colors.subtle }]}>
                  <AppText style={[styles.detectedText, { color: colors.secondary }]}>Relay pairing detected</AppText>
                </View>
              ) : null}

              {error ? (
                <View style={[styles.error, { backgroundColor: colors.dangerSurface }]}>
                  <AppText style={[styles.errorText, { color: colors.danger }]}>{error}</AppText>
                </View>
              ) : null}

              <Button disabled={!host.trim()} loading={submitting} onPress={() => void submit()}>
                {submitting ? 'Pairing…' : 'Add environment'}
              </Button>
            </Card>

            <View style={styles.quickActions}>
              <Button onPress={() => void pastePairingPayload()} style={styles.quickButton} tone="secondary">
                Paste pairing payload
              </Button>
              <Button onPress={() => void copyHermesPrompt()} style={styles.quickButton} tone="secondary">
                Copy message for Hermes
              </Button>
            </View>

            <AppText style={[styles.helpText, { color: colors.muted }]}>
              On the Hermes machine, run `brio companion pair`. Scan the QR code, paste its payload,
              or enter the displayed host and token manually.
            </AppText>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function FieldLabel({ children }: { children: string }) {
  const colors = useT3Theme();
  return <AppText style={[styles.fieldLabel, { color: colors.muted }]}>{children}</AppText>;
}

function normalizeHost(host: string) {
  const trimmed = host.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(trimmed);
  return `${local ? 'http' : 'https'}://${trimmed}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    alignSelf: 'center',
    gap: T3Spacing.xl,
    maxWidth: 620,
    padding: T3Spacing.xl,
    width: '100%',
  },
  headerButton: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  formCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
  fieldLabel: {
    fontFamily: T3Typography.bold,
    fontSize: 11,
    letterSpacing: 0.8,
    marginBottom: -4,
    textTransform: 'uppercase',
  },
  detected: { borderRadius: T3Radius.small, padding: T3Spacing.sm },
  detectedText: { fontFamily: T3Typography.medium, fontSize: 12, textAlign: 'center' },
  error: { borderRadius: T3Radius.small, padding: T3Spacing.md },
  errorText: { fontSize: 13, lineHeight: 18 },
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: T3Spacing.sm },
  quickButton: { flexGrow: 1, minWidth: 190 },
  helpText: { fontSize: 13, lineHeight: 19, paddingHorizontal: T3Spacing.xs, textAlign: 'center' },
  scanner: { aspectRatio: 1, borderRadius: T3Radius.large, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', width: '100%' },
  camera: { flex: 1 },
  permissionCard: { alignItems: 'center', gap: T3Spacing.lg, padding: T3Spacing.xxl },
});
