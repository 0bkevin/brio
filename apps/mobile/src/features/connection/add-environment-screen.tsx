import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, Button, Card } from '@/components/t3-ui';
import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  connectionFromPairingPayload,
  extractPairingPayload,
  finalizeConnection,
  normalizeConnectionURL,
  type ConnectionProgress,
  type PairingPayload,
} from '@/lib/brio';
import { useConnectionStore } from '@/state/connection-store';

const HERMES_PAIRING_PROMPT = `I want to connect the Brio mobile app to this Hermes machine.

Please run "brio companion pair" and reply with only the pairing payload. If Brio Companion is not ready, run "brio companion status" and tell me the short reason.`;

type Flow = 'options' | 'scanner' | 'manual' | 'connecting' | 'success';
type ReturnFlow = Extract<Flow, 'options' | 'scanner' | 'manual'>;
type ConnectionIssue = { title: string; detail: string };

const progressCopy: Record<ConnectionProgress, string> = {
  claiming: 'Securing the relay connection…',
  checking_companion: 'Finding Brio Companion…',
  checking_hermes: 'Checking Hermes Agent…',
  ready: 'Finishing setup…',
};

export function AddEnvironmentScreen() {
  const colors = useT3Theme();
  const router = useRouter();
  const saveConnection = useConnectionStore((state) => state.saveConnection);
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [flow, setFlow] = useState<Flow>('options');
  const [issue, setIssue] = useState<ConnectionIssue | null>(null);
  const [progress, setProgress] = useState('Checking pairing details…');
  const scannerLocked = useRef(false);
  const connectionAttemptActive = useRef(false);
  const [copied, setCopied] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const busy = flow === 'connecting' || flow === 'success';

  useEffect(() => {
    if (flow === 'connecting' || flow === 'success') {
      AccessibilityInfo.announceForAccessibility(
        flow === 'success' ? 'Environment connected' : progress,
      );
    }
  }, [flow, progress]);

  const applyPayload = (raw: string) => {
    const parsed = extractPairingPayload(raw);
    setHost(parsed.url);
    setCode(parsed.token ?? '');
    setIssue(null);
    return parsed;
  };

  const attemptConnection = async (candidate: PairingPayload, returnFlow: ReturnFlow) => {
    if (connectionAttemptActive.current) return;
    connectionAttemptActive.current = true;
    setIssue(null);
    setProgress('Checking pairing details…');
    setFlow('connecting');
    try {
      const connection = connectionFromPairingPayload(candidate);
      const connected = await finalizeConnection(connection, (nextProgress) => {
        setProgress(progressCopy[nextProgress]);
      });
      await saveConnection(connected);
      setFlow('success');
      await delay(700);
      router.dismissTo('/');
    } catch (reason) {
      setIssue(explainConnectionError(reason));
      setFlow(returnFlow);
      if (returnFlow === 'scanner') {
        setTimeout(() => {
          scannerLocked.current = false;
        }, 900);
      }
    } finally {
      connectionAttemptActive.current = false;
    }
  };

  const pastePairingPayload = async () => {
    try {
      const parsed = applyPayload(await Clipboard.getStringAsync());
      await attemptConnection(parsed, 'options');
    } catch (reason) {
      setIssue({
        title: 'No pairing details found',
        detail:
          reason instanceof Error
            ? friendlyPayloadError(reason.message)
            : 'Copy the full payload shown by `brio companion pair`, then try again.',
      });
      setFlow('options');
    }
  };

  const copyHermesPrompt = async () => {
    try {
      await Clipboard.setStringAsync(HERMES_PAIRING_PROMPT);
      setIssue(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setIssue({
        title: 'Couldn’t copy the message',
        detail: 'Copy `brio companion pair` manually and run it on the Hermes machine.',
      });
    }
  };

  const openScanner = async () => {
    setIssue(null);
    if (Platform.OS === 'web') {
      setIssue({
        title: 'QR scanning needs the mobile app',
        detail: 'Paste the pairing payload below, or enter the connection details manually.',
      });
      return;
    }
    if (cameraPermission?.granted) {
      scannerLocked.current = false;
      setFlow('scanner');
      return;
    }
    const permission = await requestCameraPermission();
    if (permission.granted) {
      scannerLocked.current = false;
      setFlow('scanner');
      return;
    }
    setIssue({
      title: 'Camera access is off',
      detail: 'Allow camera access in Settings, or paste the pairing payload instead.',
    });
    if (!permission.canAskAgain) {
      Alert.alert('Camera access is off', 'Open Settings to allow Brio to scan pairing QR codes.', [
        { text: 'Not now', style: 'cancel' },
        { text: 'Open Settings', onPress: () => void Linking.openSettings() },
      ]);
    }
  };

  const handleQrScan = async ({ data }: { data: string }) => {
    if (scannerLocked.current) return;
    scannerLocked.current = true;
    try {
      const parsed = applyPayload(data);
      await attemptConnection(parsed, 'scanner');
    } catch (reason) {
      setIssue({
        title: 'That is not a Brio pairing code',
        detail:
          reason instanceof Error
            ? friendlyPayloadError(reason.message)
            : 'Scan the QR code shown by `brio companion pair`.',
      });
      setTimeout(() => {
        scannerLocked.current = false;
      }, 900);
    }
  };

  const submitManual = async () => {
    const normalizedHost = normalizeConnectionURL(host);
    const validation = validateManualConnection(normalizedHost, code);
    if (validation) {
      setIssue(validation);
      return;
    }
    setHost(normalizedHost);
    const manualPayload: PairingPayload = {
      url: normalizedHost,
      token: code.trim(),
      mode: 'direct',
      transport: 'direct',
    };
    await attemptConnection(manualPayload, 'manual');
  };

  const closeScanner = () => {
    scannerLocked.current = false;
    setIssue(null);
    setFlow('options');
  };

  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={[styles.safe, { backgroundColor: colors.sheet }]}
    >
      <Stack.Screen
        options={{
          gestureEnabled: !busy,
          headerBackVisible: !busy,
          title:
            flow === 'scanner'
              ? 'Scan QR Code'
              : flow === 'manual'
                ? 'Enter Details'
                : 'Add Environment',
          headerRight:
            flow === 'scanner'
              ? () => (
                  <Pressable
                    accessibilityLabel="Close scanner"
                    onPress={closeScanner}
                    style={({ pressed }) => [styles.headerButton, { opacity: pressed ? 0.5 : 1 }]}
                  >
                    <SymbolView name="xmark" size={19} tintColor={colors.foreground} />
                  </Pressable>
                )
              : undefined,
        }}
      />

      {flow === 'connecting' || flow === 'success' ? (
        <ConnectionStatus progress={progress} success={flow === 'success'} />
      ) : flow === 'scanner' ? (
        <Scanner
          issue={issue}
          onManual={() => {
            setIssue(null);
            setFlow('manual');
          }}
          onScan={(event) => void handleQrScan(event)}
        />
      ) : (
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
            {flow === 'manual' ? (
              <ManualConnectionForm
                code={code}
                host={host}
                issue={issue}
                onBack={() => {
                  setIssue(null);
                  setFlow('options');
                }}
                onCodeChange={(value) => {
                  setCode(value);
                  setIssue(null);
                }}
                onHostChange={(value) => {
                  setHost(value);
                  setIssue(null);
                }}
                onSubmit={() => void submitManual()}
                onToggleCode={() => setShowCode((current) => !current)}
                showCode={showCode}
              />
            ) : (
              <ConnectionOptions
                copied={copied}
                issue={issue}
                onCopyPrompt={() => void copyHermesPrompt()}
                onManual={() => {
                  setIssue(null);
                  setFlow('manual');
                }}
                onPaste={() => void pastePairingPayload()}
                onScan={() => void openScanner()}
              />
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function ConnectionOptions({
  copied,
  issue,
  onCopyPrompt,
  onManual,
  onPaste,
  onScan,
}: {
  copied: boolean;
  issue: ConnectionIssue | null;
  onCopyPrompt: () => void;
  onManual: () => void;
  onPaste: () => void;
  onScan: () => void;
}) {
  const colors = useT3Theme();
  return (
    <>
      <View style={styles.intro}>
        <View style={[styles.heroIcon, { backgroundColor: colors.subtleStrong }]}>
          <SymbolView name="desktopcomputer" size={25} tintColor={colors.foreground} />
        </View>
        <AppText style={styles.title}>Connect to your Hermes machine</AppText>
        <AppText style={[styles.detail, { color: colors.muted }]}>
          On that machine, open a terminal and run:
        </AppText>
        <View style={[styles.command, { backgroundColor: colors.code }]}>
          <AppText selectable style={styles.commandText}>
            brio companion pair
          </AppText>
        </View>
      </View>

      {issue ? <IssueCard issue={issue} /> : null}

      <Card style={styles.actionCard}>
        {Platform.OS !== 'web' ? <Button onPress={onScan}>Scan pairing QR code</Button> : null}
        <Button onPress={onPaste} tone={Platform.OS === 'web' ? 'primary' : 'secondary'}>
          Paste pairing details
        </Button>
        <AppText style={[styles.safeNote, { color: colors.muted }]}>
          Brio checks both Companion and Hermes before saving anything.
        </AppText>
      </Card>

      <View style={styles.alternatives}>
        <Pressable
          accessibilityRole="button"
          onPress={onManual}
          style={({ pressed }) => [styles.textAction, { opacity: pressed ? 0.55 : 1 }]}
        >
          <AppText style={[styles.textActionLabel, { color: colors.secondary }]}>
            Enter details manually
          </AppText>
          <AppText style={{ color: colors.tertiary }}>›</AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onCopyPrompt}
          style={({ pressed }) => [styles.textAction, { opacity: pressed ? 0.55 : 1 }]}
        >
          <AppText style={[styles.textActionLabel, { color: colors.secondary }]}>
            {copied ? 'Message copied' : 'Ask Hermes to set this up'}
          </AppText>
          <SymbolView
            name={copied ? 'checkmark.circle.fill' : 'doc.on.doc'}
            size={17}
            tintColor={copied ? colors.success : colors.tertiary}
          />
        </Pressable>
      </View>
    </>
  );
}

function ManualConnectionForm({
  code,
  host,
  issue,
  onBack,
  onCodeChange,
  onHostChange,
  onSubmit,
  onToggleCode,
  showCode,
}: {
  code: string;
  host: string;
  issue: ConnectionIssue | null;
  onBack: () => void;
  onCodeChange: (value: string) => void;
  onHostChange: (value: string) => void;
  onSubmit: () => void;
  onToggleCode: () => void;
  showCode: boolean;
}) {
  const colors = useT3Theme();
  return (
    <>
      <View style={styles.manualIntro}>
        <AppText style={styles.title}>Enter connection details</AppText>
        <AppText style={[styles.detail, { color: colors.muted }]}>
          Use the address and pairing code shown by `brio companion pair`.
        </AppText>
      </View>

      {issue ? <IssueCard issue={issue} /> : null}

      <Card style={styles.formCard}>
        <FieldLabel>Companion address</FieldLabel>
        <AppTextInput
          accessibilityLabel="Companion address"
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          onChangeText={onHostChange}
          placeholder="192.168.1.100:8787"
          returnKeyType="next"
          value={host}
        />
        <AppText style={[styles.fieldHint, { color: colors.muted }]}>
          Your phone and computer usually need to be on the same network.
        </AppText>

        <View style={styles.labelRow}>
          <FieldLabel>Pairing code</FieldLabel>
          {code ? (
            <Pressable accessibilityRole="button" onPress={onToggleCode}>
              <AppText style={[styles.revealCode, { color: colors.secondary }]}>
                {showCode ? 'Hide' : 'Show'}
              </AppText>
            </Pressable>
          ) : null}
        </View>
        <AppTextInput
          accessibilityLabel="Pairing code"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={onCodeChange}
          onSubmitEditing={onSubmit}
          placeholder="Paste the full token"
          returnKeyType="go"
          secureTextEntry={!showCode}
          value={code}
        />

        <Button disabled={!host.trim() || !code.trim()} onPress={onSubmit}>
          Connect environment
        </Button>
      </Card>

      <Button onPress={onBack} tone="plain">
        Use QR code instead
      </Button>
    </>
  );
}

function Scanner({
  issue,
  onManual,
  onScan,
}: {
  issue: ConnectionIssue | null;
  onManual: () => void;
  onScan: (event: { data: string }) => void;
}) {
  const colors = useT3Theme();
  return (
    <View style={[styles.scannerScreen, { backgroundColor: colors.screen }]}>
      <View style={styles.scannerCopy}>
        <AppText style={styles.scannerTitle}>Point your camera at the QR code</AppText>
        <AppText style={[styles.scannerDetail, { color: colors.muted }]}>
          Brio will connect automatically when the code is recognized.
        </AppText>
      </View>
      <View style={[styles.scanner, { borderColor: colors.border }]}>
        <CameraView
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          facing="back"
          onBarcodeScanned={onScan}
          style={styles.camera}
        />
        <View pointerEvents="none" style={styles.scanFrame}>
          <View style={[styles.scanTarget, { borderColor: '#ffffff' }]} />
        </View>
      </View>
      {issue ? <IssueCard issue={issue} /> : null}
      <Button onPress={onManual} tone="secondary">
        Enter details manually
      </Button>
    </View>
  );
}

function ConnectionStatus({ progress, success }: { progress: string; success: boolean }) {
  const colors = useT3Theme();
  return (
    <View style={[styles.statusScreen, { backgroundColor: colors.screen }]}>
      <View
        style={[
          styles.statusIcon,
          {
            backgroundColor: success ? `${colors.success}1f` : colors.subtleStrong,
          },
        ]}
      >
        {success ? (
          <SymbolView name="checkmark" size={30} tintColor={colors.success} />
        ) : (
          <ActivityIndicator color={colors.foreground} size="large" />
        )}
      </View>
      <AppText style={styles.statusTitle}>{success ? 'You’re connected' : progress}</AppText>
      <AppText style={[styles.statusDetail, { color: colors.muted }]}>
        {success
          ? 'Opening your Hermes environment…'
          : 'Keep Brio Companion running while we verify the connection.'}
      </AppText>
    </View>
  );
}

function IssueCard({ issue }: { issue: ConnectionIssue }) {
  const colors = useT3Theme();
  return (
    <View
      accessibilityRole="alert"
      style={[styles.issue, { backgroundColor: colors.dangerSurface }]}
    >
      <SymbolView name="exclamationmark.circle.fill" size={19} tintColor={colors.danger} />
      <View style={styles.issueCopy}>
        <AppText style={[styles.issueTitle, { color: colors.danger }]}>{issue.title}</AppText>
        <AppText style={[styles.issueDetail, { color: colors.secondary }]}>{issue.detail}</AppText>
      </View>
    </View>
  );
}

function FieldLabel({ children }: { children: string }) {
  const colors = useT3Theme();
  return <AppText style={[styles.fieldLabel, { color: colors.muted }]}>{children}</AppText>;
}

function validateManualConnection(host: string, code: string): ConnectionIssue | null {
  if (!host || !code.trim()) {
    return {
      title: 'More information is needed',
      detail: 'Enter both the Companion address and pairing code.',
    };
  }
  try {
    const parsed = new URL(host);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
  } catch {
    return {
      title: 'Check the Companion address',
      detail: 'Use an address like 192.168.1.100:8787 or https://companion.example.com.',
    };
  }
  return null;
}

function explainConnectionError(reason: unknown): ConnectionIssue {
  const raw = reason instanceof Error ? reason.message : 'The connection could not be completed.';
  const message = raw.toLowerCase();

  if (message.includes('hermes agent') || message.includes('hermes_ok')) {
    return {
      title: 'Companion is ready, but Hermes is not',
      detail: 'Start or restart Hermes Agent on the computer, then try connecting again.',
    };
  }
  if (message.includes('unauthorized') || message.includes('401') || message.includes('token')) {
    return {
      title: 'The pairing code was rejected',
      detail: 'Run `brio companion pair` again and use the newly displayed code.',
    };
  }
  if (message.includes('expired') || message.includes('claim') || message.includes('not found')) {
    return {
      title: 'This pairing code has expired',
      detail: 'Relay codes last 10 minutes. Restart Brio Companion and scan the new QR code.',
    };
  }
  if (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('timed out') ||
    message.includes('abort') ||
    message.includes('socket')
  ) {
    return {
      title: 'We couldn’t reach that environment',
      detail:
        'Keep Brio Companion running and confirm this phone can reach the same network, then try again.',
    };
  }
  return {
    title: 'We couldn’t finish connecting',
    detail: raw.length <= 160 ? raw : 'Check Brio Companion on the computer and try again.',
  };
}

function friendlyPayloadError(message: string) {
  if (message.toLowerCase().includes('empty')) {
    return 'Copy the full payload shown by `brio companion pair`, then try again.';
  }
  if (message.toLowerCase().includes('not ready')) return message;
  return 'Use the QR code or full payload shown by `brio companion pair`.';
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    alignSelf: 'center',
    gap: T3Spacing.xl,
    maxWidth: 620,
    padding: T3Spacing.xl,
    paddingBottom: T3Spacing.huge,
    width: '100%',
  },
  headerButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  intro: {
    alignItems: 'center',
    gap: T3Spacing.sm,
    paddingHorizontal: T3Spacing.md,
    paddingTop: T3Spacing.sm,
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
    fontSize: 21,
    lineHeight: 27,
    textAlign: 'center',
  },
  detail: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  command: {
    borderRadius: T3Radius.small,
    marginTop: T3Spacing.xs,
    paddingHorizontal: T3Spacing.lg,
    paddingVertical: T3Spacing.md,
  },
  commandText: { fontFamily: T3Typography.mono, fontSize: 14, lineHeight: 19 },
  actionCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
  safeNote: {
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: T3Spacing.sm,
    textAlign: 'center',
  },
  alternatives: { gap: T3Spacing.xs },
  textAction: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 48,
    paddingHorizontal: T3Spacing.md,
  },
  textActionLabel: { flex: 1, fontFamily: T3Typography.medium, fontSize: 14 },
  manualIntro: {
    gap: T3Spacing.sm,
    paddingHorizontal: T3Spacing.md,
    paddingTop: T3Spacing.sm,
  },
  formCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
  fieldLabel: {
    fontFamily: T3Typography.bold,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  fieldHint: { fontSize: 12, lineHeight: 17, marginTop: -T3Spacing.xs },
  labelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: T3Spacing.xs,
  },
  revealCode: {
    fontFamily: T3Typography.medium,
    fontSize: 12,
    paddingHorizontal: T3Spacing.xs,
    paddingVertical: T3Spacing.xs,
  },
  issue: {
    borderRadius: T3Radius.medium,
    flexDirection: 'row',
    gap: T3Spacing.md,
    padding: T3Spacing.md,
  },
  issueCopy: { flex: 1, gap: 2 },
  issueTitle: { fontFamily: T3Typography.bold, fontSize: 13, lineHeight: 18 },
  issueDetail: { fontSize: 13, lineHeight: 18 },
  scannerScreen: {
    alignSelf: 'center',
    flex: 1,
    gap: T3Spacing.lg,
    maxWidth: 620,
    padding: T3Spacing.xl,
    width: '100%',
  },
  scannerCopy: { gap: T3Spacing.xs },
  scannerTitle: {
    fontFamily: T3Typography.bold,
    fontSize: 18,
    lineHeight: 24,
    textAlign: 'center',
  },
  scannerDetail: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  scanner: {
    aspectRatio: 1,
    borderRadius: T3Radius.large,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    width: '100%',
  },
  camera: { flex: 1 },
  scanFrame: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  scanTarget: {
    borderRadius: T3Radius.medium,
    borderWidth: 3,
    height: '62%',
    opacity: 0.9,
    width: '62%',
  },
  statusScreen: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: T3Spacing.huge,
  },
  statusIcon: {
    alignItems: 'center',
    borderRadius: T3Radius.pill,
    height: 76,
    justifyContent: 'center',
    marginBottom: T3Spacing.xl,
    width: 76,
  },
  statusTitle: {
    fontFamily: T3Typography.bold,
    fontSize: 21,
    lineHeight: 27,
    textAlign: 'center',
  },
  statusDetail: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: T3Spacing.sm,
    maxWidth: 340,
    textAlign: 'center',
  },
});
