import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
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
  type AgentConnection,
  type ConnectionProgress,
  type PairingPayload,
} from '@/lib/brio';
import { useConnectionStore } from '@/state/connection-store';

import {
  explainConnectionError,
  friendlyPayloadError,
  validateManualConnection,
  type ConnectionIssue,
} from './connection-experience';

const PAIR_COMMAND = 'brio companion pair';
const INSTALL_COMMAND = 'brio companion install';
const BINARY_INSTALL_COMMAND =
  'curl -fsSL https://github.com/0bkevin/brio/releases/latest/download/install.sh | sh';
const BRIO_RELEASES_URL = 'https://github.com/0bkevin/brio/releases/latest';
const AGENT_SETUP_PROMPT = `Help me connect the Brio mobile app to this computer.

Run "brio companion pair" and return only the QR code or connection payload. If Brio Companion is not installed or running, set it up first and then create a fresh pairing code.`;

type Flow =
  | 'guide'
  | 'scanner'
  | 'camera_permission'
  | 'paste'
  | 'manual'
  | 'connecting'
  | 'failure'
  | 'success';
type ReturnFlow = Extract<Flow, 'guide' | 'scanner' | 'paste' | 'manual'>;
type ProgressStage = 'preparing' | ConnectionProgress | 'saving';

const progressSteps: { stage: ProgressStage; label: string }[] = [
  { stage: 'preparing', label: 'Reading connection details' },
  { stage: 'checking_companion', label: 'Checking Brio on your computer' },
  { stage: 'checking_hermes', label: 'Checking your agent' },
  { stage: 'saving', label: 'Saving this environment' },
];

export function AddEnvironmentScreen() {
  const colors = useT3Theme();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const saveConnection = useConnectionStore((state) => state.saveConnection);
  const [flow, setFlow] = useState<Flow>(
    params.mode === 'paste' ? 'paste' : params.mode === 'scan' ? 'camera_permission' : 'guide',
  );
  const [returnFlow, setReturnFlow] = useState<ReturnFlow>('guide');
  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [pasteValue, setPasteValue] = useState('');
  const [issue, setIssue] = useState<ConnectionIssue | null>(null);
  const [progress, setProgress] = useState<ProgressStage>('preparing');
  const [connectedEnvironment, setConnectedEnvironment] = useState<AgentConnection | null>(null);
  const [lastCandidate, setLastCandidate] = useState<PairingPayload | null>(null);
  const [showFirstTimeHelp, setShowFirstTimeHelp] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [copiedValue, setCopiedValue] = useState('');
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [cameraPermission, requestCameraPermission, getCameraPermission] = useCameraPermissions();
  const scannerLocked = useRef(false);
  const automaticCameraRequestStarted = useRef(false);
  const attemptID = useRef(0);
  const abortController = useRef<AbortController | null>(null);
  const commitStarted = useRef(false);

  const busy = flow === 'connecting' || flow === 'success';
  const displayFlow =
    params.mode === 'scan' && flow === 'camera_permission' && cameraPermission?.granted
      ? 'scanner'
      : flow;

  useEffect(() => {
    if (flow === 'connecting') {
      const activeStep = progressSteps.find((step) => step.stage === progress)?.label;
      if (activeStep) AccessibilityInfo.announceForAccessibility(activeStep);
    } else if (flow === 'success') {
      AccessibilityInfo.announceForAccessibility('Agent connected');
    } else if (flow === 'failure' && issue) {
      AccessibilityInfo.announceForAccessibility(`${issue.title}. ${issue.detail}`);
    }
  }, [flow, issue, progress]);

  useEffect(() => () => abortController.current?.abort(), []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active' || flow !== 'camera_permission') return;
      void getCameraPermission().then((permission) => {
        if (permission.granted) {
          scannerLocked.current = false;
          setFlow('scanner');
        }
      }).catch(() => {
        setIssue({
          title: 'Could not check camera access',
          detail: 'Try again, or paste the connection code instead.',
        });
      });
    });
    return () => subscription.remove();
  }, [flow, getCameraPermission]);

  useEffect(() => {
    if (
      params.mode !== 'scan' ||
      flow !== 'camera_permission' ||
      !cameraPermission ||
      cameraPermission.granted ||
      cameraPermission.canAskAgain === false ||
      automaticCameraRequestStarted.current
    ) {
      return;
    }
    automaticCameraRequestStarted.current = true;
    void requestCameraPermission().then((permission) => {
      if (permission.granted) {
        scannerLocked.current = false;
        setFlow('scanner');
      }
    }).catch(() => undefined);
  }, [cameraPermission, flow, params.mode, requestCameraPermission]);

  const rememberPayload = (raw: string) => {
    const parsed = extractPairingPayload(raw);
    setHost(parsed.url);
    setCode(parsed.token ?? '');
    setLastCandidate(parsed);
    setIssue(null);
    return parsed;
  };

  const attemptConnection = async (candidate: PairingPayload, fallback: ReturnFlow) => {
    const currentAttempt = ++attemptID.current;
    const controller = new AbortController();
    abortController.current?.abort();
    abortController.current = controller;
    commitStarted.current = false;
    setLastCandidate(candidate);
    setReturnFlow(fallback);
    setIssue(null);
    setProgress('preparing');
    setFlow('connecting');

    try {
      const connection = connectionFromPairingPayload(candidate);
      const connected = await finalizeConnection(
        connection,
        (nextProgress) => {
          if (currentAttempt === attemptID.current) setProgress(nextProgress);
        },
        controller.signal,
      );
      if (controller.signal.aborted) throw new Error('Connection cancelled');
      commitStarted.current = true;
      setProgress('saving');
      await saveConnection(connected);
      if (currentAttempt !== attemptID.current) return;
      setConnectedEnvironment(connected);
      setFlow('success');
    } catch (reason) {
      if (currentAttempt !== attemptID.current) return;
      if (controller.signal.aborted) {
        setIssue(null);
        setFlow(fallback);
      } else {
        setIssue(explainConnectionError(reason));
        setFlow('failure');
      }
    } finally {
      if (currentAttempt === attemptID.current) abortController.current = null;
      if (currentAttempt === attemptID.current) commitStarted.current = false;
      scannerLocked.current = false;
    }
  };

  const cancelConnection = () => {
    if (commitStarted.current) return;
    abortController.current?.abort();
  };

  const openCameraSettings = async () => {
    try {
      await Linking.openSettings();
    } catch {
      setIssue({
        title: 'Could not open Settings',
        detail: 'Open Settings and allow camera access for Brio, or paste the connection code.',
      });
    }
  };

  const copyText = async (value: string) => {
    try {
      await Clipboard.setStringAsync(value);
      setIssue(null);
      setCopiedValue(value);
      setTimeout(() => setCopiedValue((current) => (current === value ? '' : current)), 1800);
    } catch {
      setIssue({
        title: 'Could not copy to the clipboard',
        detail: 'Select the command and copy it manually.',
      });
    }
  };

  const openBrioDownloads = async () => {
    try {
      await Linking.openURL(BRIO_RELEASES_URL);
    } catch {
      setIssue({
        title: 'Could not open Brio downloads',
        detail: 'Open github.com/0bkevin/brio/releases/latest on your computer.',
      });
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const clipboard = await Clipboard.getStringAsync();
      setPasteValue(clipboard);
      setIssue(null);
      if (!clipboard.trim()) {
        setIssue({
          title: 'Your clipboard is empty',
          detail: `Copy the full code shown by \`${PAIR_COMMAND}\`, then come back and try again.`,
        });
      }
    } catch {
      setIssue({
        title: 'Brio could not read the clipboard',
        detail: 'Touch and hold the field, then paste your connection code manually.',
      });
    }
  };

  const submitPaste = async () => {
    try {
      await attemptConnection(rememberPayload(pasteValue), 'paste');
    } catch (reason) {
      setIssue({
        title: 'That does not look like a Brio connection code',
        detail:
          reason instanceof Error
            ? friendlyPayloadError(reason.message)
            : `Use the full code shown by \`${PAIR_COMMAND}\`.`,
      });
    }
  };

  const openScanner = async () => {
    setIssue(null);
    if (Platform.OS === 'web') {
      setFlow('paste');
      setIssue({
        title: 'QR scanning is available on mobile',
        detail: 'Paste the connection code here to continue.',
      });
      return;
    }
    if (cameraPermission?.granted) {
      scannerLocked.current = false;
      setFlow('scanner');
      return;
    }
    if (cameraPermission?.canAskAgain !== false) {
      try {
        const permission = await requestCameraPermission();
        if (permission.granted) {
          scannerLocked.current = false;
          setFlow('scanner');
          return;
        }
      } catch {
        // The permission recovery screen below always offers a paste fallback.
      }
    }
    setFlow('camera_permission');
  };

  const askForCamera = async () => {
    automaticCameraRequestStarted.current = true;
    try {
      const permission = await requestCameraPermission();
      if (permission.granted) {
        scannerLocked.current = false;
        setFlow('scanner');
      }
    } catch {
      // Keep the permission screen visible so the user can choose the paste fallback.
    }
  };

  const handleQrScan = async ({ data }: { data: string }) => {
    if (scannerLocked.current) return;
    scannerLocked.current = true;
    try {
      await attemptConnection(rememberPayload(data), 'scanner');
    } catch (reason) {
      setIssue({
        title: 'That is not a Brio connection code',
        detail:
          reason instanceof Error
            ? friendlyPayloadError(reason.message)
            : `Scan the QR code shown by \`${PAIR_COMMAND}\`.`,
      });
      setTimeout(() => {
        scannerLocked.current = false;
      }, 900);
    }
  };

  const submitManual = async () => {
    const validation = validateManualConnection(host, code);
    if (validation) {
      setIssue(validation);
      return;
    }
    const normalizedHost = normalizeConnectionURL(host);
    setHost(normalizedHost);
    await attemptConnection(
      {
        url: normalizedHost,
        token: code.trim(),
        mode: 'direct',
        transport: 'direct',
      },
      'manual',
    );
  };

  const useAnotherMethod = () => {
    setIssue(null);
    setFlow('guide');
  };

  const headerTitle =
    displayFlow === 'scanner'
      ? 'Scan code'
      : displayFlow === 'paste'
        ? 'Paste code'
        : displayFlow === 'manual'
          ? 'Manual setup'
          : displayFlow === 'camera_permission'
            ? 'Camera access'
            : displayFlow === 'connecting'
              ? 'Connecting'
              : displayFlow === 'failure'
                ? 'Connection issue'
                : displayFlow === 'success'
                  ? 'Connected'
                  : 'Set up Hermes';

  return (
    <SafeAreaView
      edges={['bottom', 'left', 'right']}
      style={[styles.safe, { backgroundColor: colors.sheet }]}
    >
      <Stack.Screen
        options={{
          gestureEnabled: !busy,
          headerBackVisible: false,
          headerLeft: !busy
            ? () => (
                <Pressable
                  accessibilityLabel="Close setup"
                  accessibilityRole="button"
                  onPress={() => router.dismissTo('/')}
                  style={({ pressed }) => [styles.headerIcon, { opacity: pressed ? 0.5 : 1 }]}
                >
                  <SymbolView name="xmark" size={17} tintColor={colors.foreground} />
                </Pressable>
              )
            : undefined,
          title: headerTitle,
          headerRight:
            displayFlow === 'connecting' && progress !== 'saving'
              ? () => (
                  <Pressable
                    accessibilityHint="Stops this connection attempt and keeps your details"
                    accessibilityRole="button"
                    onPress={cancelConnection}
                    style={({ pressed }) => [styles.headerAction, { opacity: pressed ? 0.5 : 1 }]}
                  >
                    <AppText style={{ color: colors.secondary }}>Cancel</AppText>
                  </Pressable>
                )
              : undefined,
        }}
      />

      {displayFlow === 'connecting' ? (
        <ConnectionProgressScreen progress={progress} />
      ) : displayFlow === 'success' ? (
        <SuccessScreen
          connection={connectedEnvironment}
          onContinue={() => router.dismissTo('/')}
        />
      ) : displayFlow === 'failure' && issue ? (
        <FailureScreen
          issue={issue}
          onAnotherMethod={useAnotherMethod}
          onRetry={() => {
            if (lastCandidate) void attemptConnection(lastCandidate, returnFlow);
          }}
        />
      ) : displayFlow === 'scanner' ? (
        <Scanner
          issue={issue}
          onClose={() => {
            scannerLocked.current = false;
            setIssue(null);
            if (params.mode === 'scan') {
              router.dismissTo('/');
            } else {
              setFlow('guide');
            }
          }}
          onPaste={() => {
            setIssue(null);
            setFlow('paste');
          }}
          onScan={(event) => void handleQrScan(event)}
          onToggleTorch={() => setTorchEnabled((current) => !current)}
          torchEnabled={torchEnabled}
        />
      ) : displayFlow === 'camera_permission' ? (
        <CameraPermissionScreen
          canAskAgain={cameraPermission?.canAskAgain !== false}
          issue={issue}
          onAllow={() => void askForCamera()}
          onOpenSettings={() => void openCameraSettings()}
          onPaste={() => setFlow('paste')}
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
            {displayFlow === 'paste' ? (
              <PasteCodeScreen
                issue={issue}
                onChange={(value) => {
                  setPasteValue(value);
                  setIssue(null);
                }}
                onPaste={() => void pasteFromClipboard()}
                onSubmit={() => void submitPaste()}
                value={pasteValue}
              />
            ) : displayFlow === 'manual' ? (
              <ManualConnectionForm
                code={code}
                host={host}
                issue={issue}
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
              <SetupGuide
                copiedValue={copiedValue}
                issue={issue}
                onCopy={(value) => void copyText(value)}
                onManual={() => setFlow('manual')}
                onOpenDownloads={() => void openBrioDownloads()}
                onPaste={() => setFlow('paste')}
                onScan={() => void openScanner()}
                onToggleFirstTime={() => setShowFirstTimeHelp((current) => !current)}
                showFirstTimeHelp={showFirstTimeHelp}
              />
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function SetupGuide({
  copiedValue,
  issue,
  onCopy,
  onManual,
  onOpenDownloads,
  onPaste,
  onScan,
  onToggleFirstTime,
  showFirstTimeHelp,
}: {
  copiedValue: string;
  issue: ConnectionIssue | null;
  onCopy: (value: string) => void;
  onManual: () => void;
  onOpenDownloads: () => void;
  onPaste: () => void;
  onScan: () => void;
  onToggleFirstTime: () => void;
  showFirstTimeHelp: boolean;
}) {
  const colors = useT3Theme();
  return (
    <>
      <View style={styles.intro}>
        <View style={[styles.heroIcon, { backgroundColor: colors.subtleStrong }]}>
          <SymbolView name="terminal" size={24} tintColor={colors.foreground} />
        </View>
        <AppText style={styles.title}>One command, then scan</AppText>
        <AppText style={[styles.detail, { color: colors.muted }]}>On the computer running Hermes, open a terminal and run:</AppText>
      </View>

      {issue ? <IssueCard issue={issue} /> : null}

      <Card style={styles.stepCard}>
        <CommandRow
          command={PAIR_COMMAND}
          copied={copiedValue === PAIR_COMMAND}
          onCopy={() => onCopy(PAIR_COMMAND)}
        />
        <Pressable
          accessibilityHint="Shows help for installing Brio Companion"
          accessibilityRole="button"
          onPress={onToggleFirstTime}
          style={({ pressed }) => [styles.helpToggle, { opacity: pressed ? 0.55 : 1 }]}
        >
          <AppText style={[styles.helpToggleLabel, { color: colors.secondary }]}>First time, or command not found?</AppText>
          <SymbolView
            name={showFirstTimeHelp ? 'chevron.up' : 'chevron.down'}
            size={13}
            tintColor={colors.tertiary}
          />
        </Pressable>
        {showFirstTimeHelp ? (
          <View style={[styles.helpBox, { backgroundColor: colors.subtle }]}>
            <AppText style={[styles.helpText, { color: colors.secondary }]}>If the <AppText style={styles.inlineCode}>brio</AppText> command is missing on macOS or Linux:</AppText>
            <CommandRow
              command={BINARY_INSTALL_COMMAND}
              copied={copiedValue === BINARY_INSTALL_COMMAND}
              onCopy={() => onCopy(BINARY_INSTALL_COMMAND)}
            />
            <AppText style={[styles.helpText, { color: colors.secondary }]}>Then start the Brio bridge:</AppText>
            <CommandRow
              command={INSTALL_COMMAND}
              copied={copiedValue === INSTALL_COMMAND}
              onCopy={() => onCopy(INSTALL_COMMAND)}
            />
            <Pressable
              accessibilityHint="Opens the latest Brio downloads, including Windows builds"
              accessibilityRole="link"
              onPress={onOpenDownloads}
              style={({ pressed }) => [styles.downloadLink, { opacity: pressed ? 0.55 : 1 }]}
            >
              <AppText style={[styles.downloadLabel, { color: colors.secondary }]}>Windows or manual download</AppText>
              <AppText accessible={false} style={{ color: colors.tertiary }}>›</AppText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => onCopy(AGENT_SETUP_PROMPT)}
              style={({ pressed }) => [styles.agentHelpAction, { opacity: pressed ? 0.55 : 1 }]}
            >
              <SymbolView
                name={copiedValue === AGENT_SETUP_PROMPT ? 'checkmark.circle.fill' : 'sparkles'}
                size={17}
                tintColor={copiedValue === AGENT_SETUP_PROMPT ? colors.success : colors.secondary}
              />
              <AppText style={[styles.agentHelpLabel, { color: colors.secondary }]}>
                {copiedValue === AGENT_SETUP_PROMPT ? 'Setup request copied' : 'Ask my agent to set this up'}
              </AppText>
            </Pressable>
          </View>
        ) : null}
      </Card>

      <View style={styles.guideActions}>
        {Platform.OS !== 'web' ? (
          <Button accessibilityHint="Opens the camera to scan a Brio QR code" onPress={onScan}>Scan QR code</Button>
        ) : null}
        <Button onPress={onPaste} tone={Platform.OS === 'web' ? 'primary' : 'secondary'}>Paste connection code</Button>
      </View>

      <Pressable accessibilityRole="button" onPress={onManual} style={({ pressed }) => [styles.manualLink, { opacity: pressed ? 0.55 : 1 }]}>
        <AppText style={[styles.manualLinkLabel, { color: colors.secondary }]}>Enter details manually</AppText>
      </Pressable>
    </>
  );
}

function PasteCodeScreen({
  issue,
  onChange,
  onPaste,
  onSubmit,
  value,
}: {
  issue: ConnectionIssue | null;
  onChange: (value: string) => void;
  onPaste: () => void;
  onSubmit: () => void;
  value: string;
}) {
  const colors = useT3Theme();
  return (
    <>
      <View style={styles.intro}>
        <View style={[styles.heroIcon, { backgroundColor: colors.subtleStrong }]}>
          <SymbolView name="doc.on.clipboard" size={24} tintColor={colors.foreground} />
        </View>
        <AppText style={styles.title}>Paste your connection code</AppText>
        <AppText style={[styles.detail, { color: colors.muted }]}>Use the full code created by <AppText style={styles.inlineCode}>{PAIR_COMMAND}</AppText>.</AppText>
      </View>
      {issue ? <IssueCard issue={issue} /> : null}
      <Card style={styles.formCard}>
        <AppTextInput
          accessibilityLabel="Brio connection code"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          onChangeText={onChange}
          placeholder="Paste the full connection code"
          style={styles.payloadInput}
          textAlignVertical="top"
          value={value}
        />
        <Button onPress={onPaste} tone="secondary">Paste from clipboard</Button>
        <Button disabled={!value.trim()} onPress={onSubmit}>Verify and connect</Button>
      </Card>
      <AppText style={[styles.centerNote, { color: colors.muted }]}>Your code stays visible if the connection fails, so you can retry without starting over.</AppText>
    </>
  );
}

function ManualConnectionForm({
  code,
  host,
  issue,
  onCodeChange,
  onHostChange,
  onSubmit,
  onToggleCode,
  showCode,
}: {
  code: string;
  host: string;
  issue: ConnectionIssue | null;
  onCodeChange: (value: string) => void;
  onHostChange: (value: string) => void;
  onSubmit: () => void;
  onToggleCode: () => void;
  showCode: boolean;
}) {
  const colors = useT3Theme();
  return (
    <>
      <View style={styles.intro}>
        <View style={[styles.heroIcon, { backgroundColor: colors.subtleStrong }]}>
          <SymbolView name="keyboard" size={24} tintColor={colors.foreground} />
        </View>
        <AppText style={styles.title}>Enter connection details</AppText>
        <AppText style={[styles.detail, { color: colors.muted }]}>Use the address and access token shown on your computer.</AppText>
      </View>
      {issue ? <IssueCard issue={issue} /> : null}
      <Card style={styles.formCard}>
        <FieldLabel>Computer address</FieldLabel>
        <AppTextInput
          accessibilityHint="The network address shown by Brio Companion"
          accessibilityLabel="Computer address"
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          onChangeText={onHostChange}
          placeholder="192.168.1.100:8787"
          returnKeyType="next"
          value={host}
        />
        <AppText style={[styles.fieldHint, { color: colors.muted }]}>Your phone must be on the same Wi-Fi or private network, such as the same tailnet.</AppText>
        <View style={styles.labelRow}>
          <FieldLabel>Access token</FieldLabel>
          {code ? (
            <Pressable accessibilityRole="button" onPress={onToggleCode}>
              <AppText style={[styles.revealCode, { color: colors.secondary }]}>{showCode ? 'Hide' : 'Show'}</AppText>
            </Pressable>
          ) : null}
        </View>
        <AppTextInput
          accessibilityLabel="Access token"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={onCodeChange}
          onSubmitEditing={onSubmit}
          placeholder="Paste the access token"
          returnKeyType="go"
          secureTextEntry={!showCode}
          value={code}
        />
        <Button disabled={!host.trim() || !code.trim()} onPress={onSubmit}>Verify and connect</Button>
      </Card>
    </>
  );
}

function Scanner({
  issue,
  onClose,
  onPaste,
  onScan,
  onToggleTorch,
  torchEnabled,
}: {
  issue: ConnectionIssue | null;
  onClose: () => void;
  onPaste: () => void;
  onScan: (event: { data: string }) => void;
  onToggleTorch: () => void;
  torchEnabled: boolean;
}) {
  const colors = useT3Theme();
  return (
    <ScrollView
      contentContainerStyle={styles.scannerScreen}
      showsVerticalScrollIndicator={false}
      style={[styles.scrollScreen, { backgroundColor: colors.screen }]}
    >
      <View style={styles.scannerCopy}>
        <AppText style={styles.scannerTitle}>Scan the QR code on your computer</AppText>
        <AppText style={[styles.scannerDetail, { color: colors.muted }]}>Brio will continue automatically when the code is recognized.</AppText>
      </View>
      <View style={[styles.scanner, { borderColor: colors.border }]}>
        <CameraView barcodeScannerSettings={{ barcodeTypes: ['qr'] }} enableTorch={torchEnabled} facing="back" onBarcodeScanned={onScan} style={styles.camera} />
        <View pointerEvents="none" style={styles.scanFrame}><View style={styles.scanTarget} /></View>
        <Pressable
          accessibilityLabel={torchEnabled ? 'Turn flashlight off' : 'Turn flashlight on'}
          accessibilityRole="button"
          onPress={onToggleTorch}
          style={({ pressed }) => [styles.torchButton, { opacity: pressed ? 0.65 : 1 }]}
        >
          <SymbolView name={torchEnabled ? 'flashlight.on.fill' : 'flashlight.off.fill'} size={19} tintColor="#ffffff" />
        </Pressable>
      </View>
      {issue ? <IssueCard issue={issue} /> : null}
      <Button onPress={onPaste} tone="secondary">Paste code instead</Button>
      <Button onPress={onClose} tone="plain">Cancel scanning</Button>
    </ScrollView>
  );
}

function CameraPermissionScreen({
  canAskAgain,
  issue,
  onAllow,
  onOpenSettings,
  onPaste,
}: {
  canAskAgain: boolean;
  issue: ConnectionIssue | null;
  onAllow: () => void;
  onOpenSettings: () => void;
  onPaste: () => void;
}) {
  const colors = useT3Theme();
  return (
    <ScrollView
      contentContainerStyle={styles.centerScreen}
      showsVerticalScrollIndicator={false}
      style={[styles.scrollScreen, { backgroundColor: colors.screen }]}
    >
      <View style={[styles.largeIcon, { backgroundColor: colors.subtleStrong }]}>
        <SymbolView name="qrcode.viewfinder" size={34} tintColor={colors.foreground} />
      </View>
      <AppText style={styles.statusTitle}>Scan instead of typing</AppText>
      <AppText style={[styles.statusDetail, { color: colors.muted }]}>Camera access is only used to read the Brio QR code. Brio does not save the image.</AppText>
      {issue ? <IssueCard issue={issue} /> : null}
      <View style={styles.fullWidthActions}>
        <Button onPress={canAskAgain ? onAllow : onOpenSettings}>{canAskAgain ? 'Allow camera access' : 'Open Settings'}</Button>
        <Button onPress={onPaste} tone="secondary">Paste code instead</Button>
      </View>
    </ScrollView>
  );
}

function ConnectionProgressScreen({ progress }: { progress: ProgressStage }) {
  const colors = useT3Theme();
  const activeIndex = progressIndex(progress);
  return (
    <ScrollView
      contentContainerStyle={styles.progressScreen}
      showsVerticalScrollIndicator={false}
      style={[styles.scrollScreen, { backgroundColor: colors.screen }]}
    >
      <View style={[styles.largeIcon, { backgroundColor: colors.subtleStrong }]}><ActivityIndicator color={colors.foreground} size="large" /></View>
      <View style={styles.progressCopy}>
        <AppText style={styles.statusTitle}>Connecting your agent</AppText>
        <AppText style={[styles.statusDetail, { color: colors.muted }]}>This usually takes only a few seconds.</AppText>
      </View>
      <Card style={styles.progressCard}>
        {progressSteps.map((step, index) => {
          const complete = index < activeIndex;
          const active = index === activeIndex;
          return (
            <View key={step.stage} style={styles.progressRow}>
              <View style={[styles.progressDot, { backgroundColor: complete ? colors.success : active ? colors.foreground : colors.subtleStrong }]}>
                {complete ? <SymbolView name="checkmark" size={11} tintColor="#ffffff" /> : null}
              </View>
              <AppText style={[styles.progressLabel, { color: active ? colors.foreground : complete ? colors.secondary : colors.tertiary }]}>{step.label}</AppText>
              {active ? <ActivityIndicator color={colors.tertiary} size="small" /> : null}
            </View>
          );
        })}
      </Card>
    </ScrollView>
  );
}

function FailureScreen({
  issue,
  onAnotherMethod,
  onRetry,
}: {
  issue: ConnectionIssue;
  onAnotherMethod: () => void;
  onRetry: () => void;
}) {
  const colors = useT3Theme();
  return (
    <ScrollView contentContainerStyle={[styles.centerScreen, styles.failureContent]} showsVerticalScrollIndicator={false}>
      <View style={[styles.largeIcon, { backgroundColor: colors.dangerSurface }]}><SymbolView name="exclamationmark.triangle.fill" size={30} tintColor={colors.danger} /></View>
      <AppText style={styles.statusTitle}>{issue.title}</AppText>
      <AppText style={[styles.statusDetail, { color: colors.muted }]}>{issue.detail}</AppText>
      {issue.checklist?.length ? (
        <Card style={styles.checklistCard}>
          {issue.checklist.map((item) => (
            <View key={item} style={styles.checkRow}>
              <View style={[styles.checkBullet, { borderColor: colors.tertiary }]} />
              <AppText style={[styles.checkText, { color: colors.secondary }]}>{item}</AppText>
            </View>
          ))}
        </Card>
      ) : null}
      <View style={styles.fullWidthActions}>
        <Button onPress={onRetry}>Try again</Button>
        <Button onPress={onAnotherMethod} tone="secondary">Use another method</Button>
      </View>
      <AppText style={[styles.centerNote, { color: colors.muted }]}>Your connection details were kept, and nothing incomplete was saved.</AppText>
    </ScrollView>
  );
}

function SuccessScreen({ connection, onContinue }: { connection: AgentConnection | null; onContinue: () => void }) {
  const colors = useT3Theme();
  return (
    <ScrollView
      contentContainerStyle={styles.centerScreen}
      showsVerticalScrollIndicator={false}
      style={[styles.scrollScreen, { backgroundColor: colors.screen }]}
    >
      <View style={[styles.largeIcon, { backgroundColor: `${colors.success}1f` }]}><SymbolView name="checkmark" size={34} tintColor={colors.success} /></View>
      <AppText style={styles.statusTitle}>Your agent is ready</AppText>
      <AppText style={[styles.statusDetail, { color: colors.muted }]}>{connection?.name ? `${connection.name} is connected and ready to use in Brio.` : 'Your environment is connected and ready to use in Brio.'}</AppText>
      <Card style={styles.successCard}>
        <SuccessRow icon="checkmark.circle.fill" label="Brio bridge verified" />
        <SuccessRow icon="checkmark.circle.fill" label="Hermes Agent online" />
        <SuccessRow icon="lock.fill" label="Credentials saved on this device" />
      </Card>
      <Button onPress={onContinue} style={styles.continueButton}>Open environment</Button>
    </ScrollView>
  );
}

function CommandRow({ command, copied, onCopy }: { command: string; copied: boolean; onCopy: () => void }) {
  const colors = useT3Theme();
  return (
    <View style={[styles.command, { backgroundColor: colors.code }]}>
      <AppText selectable style={styles.commandText}>{command}</AppText>
      <Pressable accessibilityLabel={`Copy ${command}`} accessibilityRole="button" onPress={onCopy} style={({ pressed }) => [styles.copyButton, { opacity: pressed ? 0.5 : 1 }]}>
        <SymbolView name={copied ? 'checkmark' : 'doc.on.doc'} size={17} tintColor={copied ? colors.success : colors.secondary} />
      </Pressable>
    </View>
  );
}

function IssueCard({ issue }: { issue: ConnectionIssue }) {
  const colors = useT3Theme();
  return (
    <View accessibilityRole="alert" style={[styles.issue, { backgroundColor: colors.dangerSurface }]}>
      <SymbolView name="exclamationmark.circle.fill" size={19} tintColor={colors.danger} />
      <View style={styles.issueCopy}><AppText style={[styles.issueTitle, { color: colors.danger }]}>{issue.title}</AppText><AppText style={[styles.issueDetail, { color: colors.secondary }]}>{issue.detail}</AppText></View>
    </View>
  );
}

function FieldLabel({ children }: { children: string }) {
  const colors = useT3Theme();
  return <AppText style={[styles.fieldLabel, { color: colors.muted }]}>{children}</AppText>;
}

function SuccessRow({ icon, label }: { icon: SFSymbol; label: string }) {
  const colors = useT3Theme();
  return <View style={styles.successRow}><SymbolView name={icon} size={17} tintColor={colors.success} /><AppText style={[styles.successLabel, { color: colors.secondary }]}>{label}</AppText></View>;
}

function progressIndex(progress: ProgressStage) {
  if (progress === 'preparing' || progress === 'claiming') return 0;
  if (progress === 'checking_companion') return 1;
  if (progress === 'checking_hermes') return 2;
  return 3;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scrollScreen: { flex: 1 },
  content: { alignSelf: 'center', gap: T3Spacing.lg, maxWidth: 620, padding: T3Spacing.xl, paddingBottom: T3Spacing.huge, width: '100%' },
  headerAction: { alignItems: 'center', justifyContent: 'center', minHeight: 40, paddingHorizontal: T3Spacing.sm },
  headerIcon: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  intro: { alignItems: 'center', gap: T3Spacing.sm, paddingBottom: T3Spacing.sm, paddingHorizontal: T3Spacing.md, paddingTop: T3Spacing.xs },
  title: { fontFamily: T3Typography.bold, fontSize: 23, letterSpacing: -0.4, lineHeight: 29, textAlign: 'center' },
  detail: { fontSize: 14, lineHeight: 20, maxWidth: 430, textAlign: 'center' },
  inlineCode: { fontFamily: T3Typography.mono, fontSize: 13 },
  heroIcon: { alignItems: 'center', borderRadius: T3Radius.medium, height: 52, justifyContent: 'center', marginBottom: T3Spacing.xs, width: 52 },
  stepCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
  command: { alignItems: 'center', borderRadius: T3Radius.small, flexDirection: 'row', minHeight: 50, paddingLeft: T3Spacing.md },
  commandText: { flex: 1, fontFamily: T3Typography.mono, fontSize: 13, lineHeight: 18 },
  copyButton: { alignItems: 'center', height: 48, justifyContent: 'center', width: 48 },
  helpToggle: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 36, paddingHorizontal: T3Spacing.xs },
  helpToggleLabel: { fontFamily: T3Typography.medium, fontSize: 13, lineHeight: 18 },
  helpBox: { borderRadius: T3Radius.medium, gap: T3Spacing.md, padding: T3Spacing.md },
  helpText: { fontSize: 12, lineHeight: 17 },
  downloadLink: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 36 },
  downloadLabel: { fontFamily: T3Typography.medium, fontSize: 12, lineHeight: 17 },
  agentHelpAction: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.sm, minHeight: 36 },
  agentHelpLabel: { fontFamily: T3Typography.medium, fontSize: 12, lineHeight: 17 },
  guideActions: { gap: T3Spacing.md },
  manualLink: { alignItems: 'center', justifyContent: 'center', minHeight: 42 },
  manualLinkLabel: { fontFamily: T3Typography.medium, fontSize: 13, lineHeight: 18 },
  formCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
  payloadInput: { minHeight: 132 },
  fieldLabel: { fontFamily: T3Typography.bold, fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' },
  fieldHint: { fontSize: 12, lineHeight: 17, marginTop: -T3Spacing.xs },
  labelRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: T3Spacing.xs },
  revealCode: { fontFamily: T3Typography.medium, fontSize: 12, paddingHorizontal: T3Spacing.xs, paddingVertical: T3Spacing.xs },
  centerNote: { fontSize: 12, lineHeight: 17, paddingHorizontal: T3Spacing.md, textAlign: 'center' },
  issue: { borderRadius: T3Radius.medium, flexDirection: 'row', gap: T3Spacing.md, padding: T3Spacing.md },
  issueCopy: { flex: 1, gap: 2 },
  issueTitle: { fontFamily: T3Typography.bold, fontSize: 13, lineHeight: 18 },
  issueDetail: { fontSize: 13, lineHeight: 18 },
  scannerScreen: { alignSelf: 'center', flexGrow: 1, gap: T3Spacing.lg, maxWidth: 620, padding: T3Spacing.xl, width: '100%' },
  scannerCopy: { gap: T3Spacing.xs },
  scannerTitle: { fontFamily: T3Typography.bold, fontSize: 18, lineHeight: 24, textAlign: 'center' },
  scannerDetail: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  scanner: { aspectRatio: 1, borderRadius: T3Radius.large, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', width: '100%' },
  camera: { flex: 1 },
  scanFrame: { alignItems: 'center', bottom: 0, justifyContent: 'center', left: 0, position: 'absolute', right: 0, top: 0 },
  scanTarget: { borderColor: '#ffffff', borderRadius: T3Radius.medium, borderWidth: 3, height: '62%', opacity: 0.92, width: '62%' },
  torchButton: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: T3Radius.pill, bottom: T3Spacing.lg, height: 44, justifyContent: 'center', position: 'absolute', right: T3Spacing.lg, width: 44 },
  centerScreen: { alignItems: 'center', flexGrow: 1, gap: T3Spacing.lg, justifyContent: 'center', padding: T3Spacing.huge },
  largeIcon: { alignItems: 'center', borderRadius: T3Radius.large, height: 70, justifyContent: 'center', width: 70 },
  statusTitle: { fontFamily: T3Typography.bold, fontSize: 23, letterSpacing: -0.4, lineHeight: 29, textAlign: 'center' },
  statusDetail: { fontSize: 14, lineHeight: 20, maxWidth: 430, textAlign: 'center' },
  fullWidthActions: { alignSelf: 'stretch', gap: T3Spacing.md, maxWidth: 430, width: '100%' },
  progressScreen: { alignItems: 'center', flexGrow: 1, gap: T3Spacing.xl, justifyContent: 'center', padding: T3Spacing.huge },
  progressCopy: { alignItems: 'center', gap: T3Spacing.xs },
  progressCard: { alignSelf: 'stretch', gap: T3Spacing.lg, maxWidth: 430, padding: T3Spacing.lg, width: '100%' },
  progressRow: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.md },
  progressDot: { alignItems: 'center', borderRadius: 9, height: 18, justifyContent: 'center', width: 18 },
  progressLabel: { flex: 1, fontFamily: T3Typography.medium, fontSize: 13, lineHeight: 18 },
  failureContent: { flexGrow: 1, justifyContent: 'center' },
  checklistCard: { alignSelf: 'stretch', gap: T3Spacing.md, maxWidth: 430, padding: T3Spacing.lg, width: '100%' },
  checkRow: { alignItems: 'flex-start', flexDirection: 'row', gap: T3Spacing.md },
  checkBullet: { borderRadius: 6, borderWidth: 1.5, height: 12, marginTop: 4, width: 12 },
  checkText: { flex: 1, fontSize: 13, lineHeight: 19 },
  successCard: { alignSelf: 'stretch', gap: T3Spacing.md, maxWidth: 430, padding: T3Spacing.lg, width: '100%' },
  successRow: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.md },
  successLabel: { fontSize: 13, lineHeight: 18 },
  continueButton: { alignSelf: 'stretch', maxWidth: 430, width: '100%' },
});
