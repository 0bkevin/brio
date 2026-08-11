import { useMutation, useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DashboardCard, SectionLabel, StatusBadge } from '@/components/dashboard';
import { Collapsible } from '@/components/ui/collapsible';
import {
  claimRelayPairing,
  connectionFromPairingPayload,
  createRelayDevice,
  createRelayEnrollment,
  extractPairingPayload,
  getHealth,
  listRelayAgents,
  recoverRelayAgent,
  sendResponse,
  type AgentConnection,
  type RelayAgent,
  type RelayEnrollmentResponse,
} from '@/lib/brio';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useConnectionStore } from '@/state/connection-store';
import { useRelaySessionStore, type RelaySession } from '@/state/relay-session-store';

const HERMES_CONNECT_PROMPT = `I want to connect the Brio app to this Hermes machine.

Please look up this machine's Brio Companion connection details.
1. First try: brio companion pair
2. If that fails, try: brio companion status

Reply with only one of these:
- the pairing payload from brio companion pair
- or:
URL: <url>
Token: <token>

If Brio Companion is not ready, reply:
NOT READY: <one short reason>

Do not add markdown fences or extra explanation.`;

async function finalizeConnection(connection: AgentConnection) {
  let nextConnection = connection;

  if (connection.transport === 'relay') {
    const session = await createRelayDevice(connection.url);
    if (!connection.pairingCode) {
      throw new Error('Relay pairing payload is missing a code');
    }
    const claim = await claimRelayPairing(connection.url, session.token, connection.pairingCode);
    nextConnection = {
      ...connection,
      id: claim.agent.id,
      name: claim.agent.name,
      status: claim.agent.status,
      relayToken: session.token,
      token: '',
    };
  }

  const health = await getHealth(nextConnection);
  return {
    ...nextConnection,
    status: health.hermes_ok ? 'online' : 'error',
  } satisfies AgentConnection;
}

async function copyToClipboard(value: string) {
  await Clipboard.setStringAsync(value);
}

export default function ChatScreen() {
  const connectionHydrated = useConnectionStore((state) => state.hydrated);
  const connection = useConnectionStore((state) => state.connection);
  const relayHydrated = useRelaySessionStore((state) => state.hydrated);
  const relaySession = useRelaySessionStore((state) => state.session);

  if (!connectionHydrated || !relayHydrated) {
    return <CenteredStatus label="Loading Brio" />;
  }

  if (connection) {
    return <ConnectedChat connection={connection} />;
  }

  if (relaySession) {
    return <ControlPlaneHome session={relaySession} />;
  }

  return <ConnectionOnboarding />;
}

function ConnectionOnboarding() {
  return (
    <Screen>
      <ThemedView style={styles.header}>
        <SectionLabel>Hermes Agent</SectionLabel>
        <ThemedText type="title">Brio</ThemedText>
        <ThemedText themeColor="textSecondary">
          Connect in two steps: ask Hermes for the bridge details, then paste the reply here.
        </ThemedText>
      </ThemedView>

      <AskAgentCard />
      <OtherConnectionOptions />
    </Screen>
  );
}

function AskAgentCard() {
  const theme = useTheme();
  const saveConnection = useConnectionStore((state) => state.saveConnection);
  const [copyLabel, setCopyLabel] = useState('Copy message');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);

  async function copyMessage() {
    try {
      await copyToClipboard(HERMES_CONNECT_PROMPT);
      setCopyLabel('Copied');
    } catch (err) {
      setCopyLabel('Copy failed');
      setError(err instanceof Error ? err.message : 'Could not copy message');
    }
  }

  async function connectFromReply() {
    setConnecting(true);
    setError('');
    try {
      const payload = extractPairingPayload(reply);
      const connection = connectionFromPairingPayload(payload);
      await saveConnection(await finalizeConnection(connection));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <DashboardCard style={styles.featureCard}>
      <View style={styles.featureHeader}>
        <View style={styles.featureCopy}>
          <SectionLabel>Simple Connect</SectionLabel>
          <ThemedText type="subtitle">Ask your agent</ThemedText>
          <ThemedText themeColor="textSecondary">
            This mirrors Atomic&apos;s lightweight handoff: Brio gives you a ready-made message, Hermes
            sends back the bridge details, and the app connects.
          </ThemedText>
        </View>
        <StatusBadge tone="success">2 steps</StatusBadge>
      </View>

      <ThemedView
        style={[
          styles.calloutBlock,
          {
            backgroundColor: theme.backgroundSelected,
            borderColor: theme.border,
          },
        ]}>
        <ThemedText type="smallBold">1. Copy this message to Hermes</ThemedText>
        <ThemedText selectable style={styles.promptText}>
          {HERMES_CONNECT_PROMPT}
        </ThemedText>
        <SecondaryButton label={copyLabel} onPress={() => void copyMessage()} />
      </ThemedView>

      <ThemedText type="smallBold">2. Paste Hermes&apos;s reply</ThemedText>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        onChangeText={setReply}
        placeholder="Paste the pairing payload or URL / Token reply"
        placeholderTextColor={theme.textSecondary}
        style={[styles.replyInput, { color: theme.text, borderColor: theme.backgroundSelected }]}
        textAlignVertical="top"
        value={reply}
      />

      {error ? <ThemedText themeColor="textSecondary">{error}</ThemedText> : null}

      <PrimaryButton
        disabled={connecting || !reply.trim()}
        label={connecting ? 'Connecting' : 'Connect From Hermes Reply'}
        onPress={() => void connectFromReply()}
      />
    </DashboardCard>
  );
}

function OtherConnectionOptions() {
  return (
    <DashboardCard inset="compact">
      <SectionLabel>Other Paths</SectionLabel>
      <Collapsible title="Use the Brio relay and enroll a machine">
        <RelaySignInCard embedded />
      </Collapsible>
      <Collapsible title="Paste raw credentials manually">
        <ManualConnectionCard embedded />
      </Collapsible>
    </DashboardCard>
  );
}

function RelaySignInCard({ embedded = false }: { embedded?: boolean }) {
  const theme = useTheme();
  const saveSession = useRelaySessionStore((state) => state.saveSession);
  const [relayURL, setRelayURL] = useState('http://127.0.0.1:8082');
  const [email, setEmail] = useState('dev@brio.local');
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
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    },
  });

  const content = (
    <>
      <ThemedText type="smallBold">Brio relay sign-in</ThemedText>
      <ThemedText themeColor="textSecondary">
        This creates or reuses an owner account and device session in the control plane.
      </ThemedText>

      <ThemedText type="smallBold">Relay URL</ThemedText>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        inputMode="url"
        onChangeText={setRelayURL}
        placeholder="https://relay.example.com"
        placeholderTextColor={theme.textSecondary}
        style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
        value={relayURL}
      />

      <ThemedText type="smallBold">Email</ThemedText>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        onChangeText={setEmail}
        placeholder="owner@example.com"
        placeholderTextColor={theme.textSecondary}
        style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
        value={email}
      />

      <ThemedText type="smallBold">Device name</ThemedText>
      <TextInput
        autoCapitalize="words"
        autoCorrect={false}
        onChangeText={setDeviceName}
        placeholder="My phone"
        placeholderTextColor={theme.textSecondary}
        style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
        value={deviceName}
      />

      {error ? <ThemedText themeColor="textSecondary">{error}</ThemedText> : null}

      <PrimaryButton
        disabled={signIn.isPending || !relayURL.trim() || !email.trim() || !deviceName.trim()}
        label={signIn.isPending ? 'Signing In' : 'Sign In To Relay'}
        onPress={() => {
          setError('');
          signIn.mutate();
        }}
      />
    </>
  );

  if (embedded) {
    return <View style={styles.embeddedCardContent}>{content}</View>;
  }

  return <DashboardCard>{content}</DashboardCard>;
}

function ControlPlaneHome({ session }: { session: RelaySession }) {
  const clearSession = useRelaySessionStore((state) => state.clearSession);
  const clearConnection = useConnectionStore((state) => state.clearConnection);
  const saveConnection = useConnectionStore((state) => state.saveConnection);
  const theme = useTheme();
  const [agentName, setAgentName] = useState('Hermes');
  const [recoveryAgentID, setRecoveryAgentID] = useState('');
  const [recoveryResult, setRecoveryResult] = useState<Record<string, string> | null>(null);

  const agents = useQuery({
    queryKey: ['relay-agents', session.relayURL, session.userID],
    queryFn: () => listRelayAgents(session.relayURL, session.token),
    refetchInterval: 10000,
  });

  const enrollment = useMutation({
    mutationFn: () => createRelayEnrollment(session.relayURL, session.token, agentName.trim() || 'Hermes'),
    onSuccess: () => {
      void agents.refetch();
    },
  });

  const recovery = useMutation({
    mutationFn: () => recoverRelayAgent(session.relayURL, session.token, recoveryAgentID.trim()),
    onSuccess: (result) => {
      setRecoveryResult({
        agent_id: result.agent_id,
        relay_token: result.agent_token,
        code: result.code,
        expires_at: result.expires_at,
      });
      void agents.refetch();
    },
  });

  async function connectAgent(agent: RelayAgent) {
    await saveConnection({
      id: agent.id,
      name: agent.name,
      mode: agent.mode,
      transport: 'relay',
      status: agent.status,
      capabilities: {},
      url: session.relayURL,
      token: '',
      relayToken: session.token,
      agentId: agent.id,
    });
  }

  return (
    <Screen>
      <ThemedView style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <SectionLabel>Control plane</SectionLabel>
          <ThemedText type="subtitle">{session.email}</ThemedText>
          <ThemedText themeColor="textSecondary">{session.relayURL}</ThemedText>
        </View>
        <Pressable
          onPress={() => {
            setRecoveryResult(null);
            void clearConnection();
            void clearSession();
          }}
          style={styles.textButton}>
          <ThemedText type="link">Sign out</ThemedText>
        </Pressable>
      </ThemedView>

      <DashboardCard>
        <ThemedText type="smallBold">My agents</ThemedText>
        {agents.isLoading ? <ActivityIndicator /> : null}
        {agents.error ? (
          <ThemedText themeColor="textSecondary">
            {agents.error instanceof Error ? agents.error.message : 'Could not load agents'}
          </ThemedText>
        ) : null}
        {agents.data?.length ? (
          agents.data.map((agent) => (
            <View key={agent.id} style={styles.agentRow}>
              <View style={styles.agentCopy}>
                <ThemedText type="smallBold">{agent.name}</ThemedText>
                <ThemedText themeColor="textSecondary">{agent.id}</ThemedText>
              </View>
              <StatusBadge tone={agent.status === 'online' ? 'success' : 'warning'}>
                {agent.status}
              </StatusBadge>
              <PrimaryButton label="Connect" onPress={() => void connectAgent(agent)} />
            </View>
          ))
        ) : (
          <ThemedText themeColor="textSecondary">No enrolled agents yet.</ThemedText>
        )}
      </DashboardCard>

      <DashboardCard>
        <ThemedText type="smallBold">Enroll a new Hermes machine</ThemedText>
        <ThemedText themeColor="textSecondary">
          Generate a short code, then run the enrollment command on the Hermes machine.
        </ThemedText>

        <ThemedText type="smallBold">Agent name</ThemedText>
        <TextInput
          autoCapitalize="words"
          autoCorrect={false}
          onChangeText={setAgentName}
          placeholder="Hermes"
          placeholderTextColor={theme.textSecondary}
          style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
          value={agentName}
        />

        <PrimaryButton
          disabled={enrollment.isPending}
          label={enrollment.isPending ? 'Generating Code' : 'Generate Enrollment Code'}
          onPress={() => enrollment.mutate()}
        />

        {enrollment.error ? (
          <ThemedText themeColor="textSecondary">
            {enrollment.error instanceof Error ? enrollment.error.message : 'Could not create enrollment'}
          </ThemedText>
        ) : null}
        {enrollment.data ? <EnrollmentOutput enrollment={enrollment.data} relayURL={session.relayURL} /> : null}
      </DashboardCard>

      <DashboardCard>
        <ThemedText type="smallBold">Recover an enrolled agent</ThemedText>
        <ThemedText themeColor="textSecondary">
          If a Hermes machine lost its local relay state, recover a fresh relay token for that agent.
        </ThemedText>

        <ThemedText type="smallBold">Agent ID</ThemedText>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setRecoveryAgentID}
          placeholder="agent_..."
          placeholderTextColor={theme.textSecondary}
          style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
          value={recoveryAgentID}
        />

        <PrimaryButton
          disabled={recovery.isPending || !recoveryAgentID.trim()}
          label={recovery.isPending ? 'Recovering' : 'Recover Agent'}
          onPress={() => {
            setRecoveryResult(null);
            recovery.mutate();
          }}
        />

        {recovery.error ? (
          <ThemedText themeColor="textSecondary">
            {recovery.error instanceof Error ? recovery.error.message : 'Could not recover agent'}
          </ThemedText>
        ) : null}
        {recoveryResult ? (
          <ThemedText type="code" style={styles.jsonBlock}>
            {JSON.stringify(recoveryResult, null, 2)}
          </ThemedText>
        ) : null}
      </DashboardCard>

      <ManualConnectionCard />
    </Screen>
  );
}

function EnrollmentOutput({
  enrollment,
  relayURL,
}: {
  enrollment: RelayEnrollmentResponse;
  relayURL: string;
}) {
  return (
    <ThemedView style={styles.outputBlock}>
      <ThemedText type="smallBold">Enrollment code</ThemedText>
      <ThemedText type="title">{enrollment.code}</ThemedText>
      <ThemedText themeColor="textSecondary">
        Run this on the Hermes machine:
      </ThemedText>
      <ThemedText type="code" style={styles.jsonBlock}>
        {`brio companion enroll --relay-url ${relayURL} --code ${enrollment.code} --run`}
      </ThemedText>
    </ThemedView>
  );
}

function ManualConnectionCard({ embedded = false }: { embedded?: boolean }) {
  const theme = useTheme();
  const saveConnection = useConnectionStore((state) => state.saveConnection);
  const [url, setURL] = useState('http://127.0.0.1:8787');
  const [token, setToken] = useState('');
  const [pairingPayload, setPairingPayload] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);

  async function connect() {
    setTesting(true);
    setError('');
    try {
      const connection = pairingPayload.trim()
        ? connectionFromPairingPayload(extractPairingPayload(pairingPayload))
        : ({
            id: 'self-hosted-local',
            name: 'Hermes',
            mode: 'self_hosted',
            transport: 'direct',
            status: 'connecting',
            capabilities: {},
            url: url.trim(),
            token: token.trim(),
          } as AgentConnection);
      await saveConnection(await finalizeConnection(connection));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setTesting(false);
    }
  }

  const content = (
    <>
      <ThemedText type="smallBold">Advanced manual connect</ThemedText>
      <ThemedText themeColor="textSecondary">
        Legacy fallback for direct local access or manual relay pairing payloads.
      </ThemedText>

      <ThemedText type="smallBold">Pairing payload</ThemedText>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        onChangeText={setPairingPayload}
        placeholder="Paste a pairing payload"
        placeholderTextColor={theme.textSecondary}
        style={[styles.pairingInput, { color: theme.text, borderColor: theme.backgroundSelected }]}
        value={pairingPayload}
      />

      <ThemedText type="smallBold">Server URL</ThemedText>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        inputMode="url"
        onChangeText={setURL}
        placeholder="http://127.0.0.1:8787"
        placeholderTextColor={theme.textSecondary}
        style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
        value={url}
      />

      <ThemedText type="smallBold">Token</ThemedText>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setToken}
        placeholder="Paste direct companion token"
        placeholderTextColor={theme.textSecondary}
        secureTextEntry
        style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
        value={token}
      />

      {error ? <ThemedText themeColor="textSecondary">{error}</ThemedText> : null}

      <PrimaryButton
        disabled={testing || (!pairingPayload.trim() && (!url.trim() || !token.trim()))}
        label={testing ? 'Connecting' : 'Connect Manually'}
        onPress={connect}
      />
    </>
  );

  if (embedded) {
    return <View style={styles.embeddedCardContent}>{content}</View>;
  }

  return <DashboardCard>{content}</DashboardCard>;
}

function ConnectedChat({ connection }: { connection: AgentConnection }) {
  const theme = useTheme();
  const clearConnection = useConnectionStore((state) => state.clearConnection);
  const [prompt, setPrompt] = useState('');
  const [lastResponse, setLastResponse] = useState<Record<string, unknown> | null>(null);

  const health = useQuery({
    queryKey: ['health', connection.url, connection.agentId ?? connection.id],
    queryFn: () => getHealth(connection),
    refetchInterval: 10000,
  });

  const chat = useMutation({
    mutationFn: (message: string) => sendResponse(connection, message),
    onSuccess: (data) => setLastResponse(data),
  });

  return (
    <Screen>
      <ThemedView style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <SectionLabel>Active companion</SectionLabel>
          <ThemedText type="subtitle">{connection.name}</ThemedText>
          <StatusBadge tone={health.data?.hermes_ok ? 'success' : 'warning'}>
            Hermes {health.data?.hermes_ok ? 'online' : 'not reachable'}
          </StatusBadge>
        </View>
        <Pressable onPress={() => void clearConnection()} style={styles.textButton}>
          <ThemedText type="link">Back</ThemedText>
        </Pressable>
      </ThemedView>

      <DashboardCard>
        <TextInput
          multiline
          onChangeText={setPrompt}
          placeholder="Send a message to Hermes"
          placeholderTextColor={theme.textSecondary}
          style={[
            styles.messageInput,
            { color: theme.text, borderColor: theme.backgroundSelected },
          ]}
          value={prompt}
        />
        {chat.error ? (
          <ThemedText themeColor="textSecondary">
            {chat.error instanceof Error ? chat.error.message : 'Request failed'}
          </ThemedText>
        ) : null}
        <PrimaryButton
          disabled={chat.isPending || !prompt.trim()}
          label={chat.isPending ? 'Sending' : 'Send'}
          onPress={() => {
            const message = prompt.trim();
            setPrompt('');
            chat.mutate(message);
          }}
        />
      </DashboardCard>

      <DashboardCard>
        <ThemedText type="smallBold">Latest response</ThemedText>
        {chat.isPending ? <ActivityIndicator /> : null}
        <ThemedText type="code" style={styles.jsonBlock}>
          {lastResponse ? JSON.stringify(lastResponse, null, 2) : 'No response yet.'}
        </ThemedText>
      </DashboardCard>
    </Screen>
  );
}

function Screen({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <ScrollView style={[styles.scroll, { backgroundColor: theme.background }]}>
      <SafeAreaView style={styles.safeArea}>{children}</SafeAreaView>
    </ScrollView>
  );
}

function CenteredStatus({ label }: { label: string }) {
  return (
    <ThemedView style={styles.centered}>
      <ActivityIndicator />
      <ThemedText>{label}</ThemedText>
    </ThemedView>
  );
}

function PrimaryButton({
  disabled,
  label,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.primaryButton,
        { backgroundColor: disabled ? theme.backgroundSelected : theme.accent },
      ]}>
      <ThemedText style={{ color: disabled ? theme.textDisabled : theme.accentText }} type="smallBold">
        {label}
      </ThemedText>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.secondaryButton,
        {
          backgroundColor: theme.backgroundSelected,
          borderColor: theme.border,
        },
      ]}>
      <ThemedText type="smallBold">{label}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  safeArea: {
    alignSelf: 'center',
    gap: Spacing.three,
    maxWidth: MaxContentWidth,
    paddingBottom: BottomTabInset + Spacing.four,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    width: '100%',
  },
  header: {
    gap: Spacing.one,
    paddingVertical: Spacing.two,
  },
  featureCard: {
    gap: Spacing.three,
  },
  featureHeader: {
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
  },
  featureCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  calloutBlock: {
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    padding: Spacing.three,
  },
  promptText: {
    lineHeight: 23,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  headerCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  input: {
    backgroundColor: 'rgba(0,0,0,0.12)',
    borderRadius: Spacing.two,
    borderWidth: 1,
    minHeight: 48,
    paddingHorizontal: Spacing.three,
  },
  messageInput: {
    backgroundColor: 'rgba(0,0,0,0.12)',
    borderRadius: Spacing.two,
    borderWidth: 1,
    minHeight: 132,
    padding: Spacing.three,
    textAlignVertical: 'top',
  },
  pairingInput: {
    backgroundColor: 'rgba(0,0,0,0.12)',
    borderRadius: Spacing.two,
    borderWidth: 1,
    minHeight: 92,
    padding: Spacing.three,
    textAlignVertical: 'top',
  },
  replyInput: {
    backgroundColor: 'rgba(0,0,0,0.12)',
    borderRadius: Spacing.two,
    borderWidth: 1,
    minHeight: 148,
    padding: Spacing.three,
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: Spacing.three,
  },
  secondaryButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: Spacing.three,
  },
  textButton: {
    padding: Spacing.two,
  },
  jsonBlock: {
    lineHeight: 18,
  },
  centered: {
    alignItems: 'center',
    flex: 1,
    gap: Spacing.three,
    justifyContent: 'center',
  },
  agentRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  agentCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  outputBlock: {
    gap: Spacing.one,
  },
  embeddedCardContent: {
    gap: Spacing.two,
  },
});
