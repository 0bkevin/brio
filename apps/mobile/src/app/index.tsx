import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth, useClerk, useUser } from '@clerk/expo';
import * as Clipboard from 'expo-clipboard';
import * as Device from 'expo-device';
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { ChatWorkspace } from '@/components/chat-workspace';
import { CloudAuthView } from '@/components/cloud-auth-view';
import { Collapsible } from '@/components/ui/collapsible';
import {
  claimRelayPairing,
  connectionFromPairingPayload,
  createRelayDevice,
  createRelayEnrollment,
  disconnectRelayClients,
  extractPairingPayload,
  getHealth,
  isAgentHealthy,
  listRelayAgents,
  recoverRelayAgent,
  revokeRelayDevice,
  type AgentConnection,
  type RelayAgent,
  type RelayEnrollmentResponse,
} from '@/lib/brio';
import {
  cloudAuthConfigured,
  configuredRelayURL,
  developmentAuthEnabled,
  relayTokenOptions,
} from '@/lib/cloud-auth';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useConnectionStore } from '@/state/connection-store';
import { useRelaySessionStore, type RelaySession } from '@/state/relay-session-store';

const HERMES_CONNECT_PROMPT = `I want to connect the Brio app to this machine directly.

Read the Hermes API server settings from ~/.hermes/.env and reply with only:

URL: http://<this-machine-host>:<API_SERVER_PORT>
Token: <API_SERVER_KEY>

If the API server is not enabled (API_SERVER_ENABLED is not true), reply:
NOT READY: <one short reason>

Do not add markdown fences or extra explanation.`;

const INSTALL_SCRIPT_URL = 'https://github.com/0bkevin/brio/releases/latest/download/install.sh';

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function setupInstallCommand(enrollment: RelayEnrollmentResponse, relayURL: string) {
  return `curl -fsSL ${INSTALL_SCRIPT_URL} \\
  | BRIO_RELAY_URL=${shellQuote(relayURL)} \\
    BRIO_ENROLL_CODE=${shellQuote(enrollment.code)} \\
    BRIO_AGENT_NAME=${shellQuote(enrollment.name || 'Brio Agent')} \\
    sh`;
}

function recoveryCommand(relayURL: string, agentID: string, deviceToken: string) {
  return `brio recover \\
  --relay-url ${shellQuote(relayURL)} \\
  --agent-id ${shellQuote(agentID)} \\
  --device-token ${shellQuote(deviceToken)} \\
  --restart`;
}

function findSetupAgent(enrollment: RelayEnrollmentResponse | undefined, agents: RelayAgent[] | undefined) {
  if (!enrollment || !agents?.length) {
    return undefined;
  }
  const setupStarted = Date.parse(enrollment.created_at);
  return agents.find((agent) => {
    if (agent.name !== enrollment.name) {
      return false;
    }
    if (!agent.created_at || Number.isNaN(setupStarted)) {
      return true;
    }
    return Date.parse(agent.created_at) >= setupStarted - 5000;
  });
}

async function finalizeConnection(connection: AgentConnection) {
  let nextConnection = connection;

  if (connection.transport === 'relay') {
    const storedSession = useRelaySessionStore.getState().session;
    const sameRelay =
      storedSession?.relayURL.trim().replace(/\/+$/, '') === connection.url.trim().replace(/\/+$/, '');
    const session = sameRelay
      ? {
          token: storedSession.token,
          user: { id: storedSession.userID, email: storedSession.email },
          device: {
            id: storedSession.deviceID,
            user_id: storedSession.userID,
            name: storedSession.deviceName,
          },
        }
      : await createRelayDevice(connection.url);
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
    status: isAgentHealthy(health) ? 'online' : 'error',
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

  if (cloudAuthConfigured()) {
    return <CloudControlPlaneEntry />;
  }

  if (relaySession) {
    return <ControlPlaneHome session={relaySession} />;
  }

  return <ConnectionOnboarding />;
}

function CloudControlPlaneEntry() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { signOut } = useClerk();
  const session = useRelaySessionStore((state) => state.session);
  const saveSession = useRelaySessionStore((state) => state.saveSession);
  const clearSession = useRelaySessionStore((state) => state.clearSession);
  const clearConnection = useConnectionStore((state) => state.clearConnection);
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
    if (!isLoaded || !isSignedIn || !userId || !user) return;
    if (session?.identitySubject && session.identitySubject !== userId) return;
    if (sessionMatches) return;
    if (registering.current) return;
    registering.current = userId;
    void (async () => {
      try {
        const identityToken = await getToken(relayTokenOptions());
        if (!identityToken) throw new Error('Clerk did not issue a Brio relay token');
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
        setError('');
      } catch (cause) {
        if (mounted.current && currentIdentity.current === userId) {
          setError(cause instanceof Error ? cause.message : 'Could not register this device');
        }
      } finally {
        if (registering.current === userId) {
          registering.current = '';
          if (mounted.current && currentIdentity.current && currentIdentity.current !== userId) {
            setAttempt((value) => value + 1);
          }
        }
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

  if (!isLoaded) return <CenteredStatus label="Loading Brio Connect" />;
  if (!isSignedIn || !userId) return <ConnectionOnboarding />;
  if (!sessionMatches || !session) {
    if (error) {
      return (
        <Screen>
          <ThemedText type="subtitle">Could not activate Brio Connect</ThemedText>
          <ThemedText themeColor="textSecondary">{error}</ThemedText>
          <PrimaryButton label="Retry" onPress={() => setAttempt((value) => value + 1)} />
        </Screen>
      );
    }
    return <CenteredStatus label="Securing this device" />;
  }
  return (
    <ControlPlaneHome
      onSignOut={async () => {
        disconnectRelayClients(session.token);
        const results = await Promise.allSettled([
          revokeRelayDevice(session.relayURL, session.token, session.deviceID),
          clearConnection(),
          clearSession(),
          signOut(),
        ]);
        const signOutResult = results[3];
        if (signOutResult?.status === 'rejected') throw signOutResult.reason;
      }}
      session={session}
    />
  );
}

function ConnectionOnboarding() {
  return (
    <Screen>
      <ThemedView style={styles.header}>
        <SectionLabel>Your private AI</SectionLabel>
        <ThemedText type="title">Brio</ThemedText>
        <ThemedText themeColor="textSecondary">
          Bring your personal agent with you—private, connected, and ready whenever you are.
        </ThemedText>
      </ThemedView>

      <DashboardCard style={styles.featureCard}>
        <View style={styles.featureHeader}>
          <View style={styles.featureCopy}>
            <SectionLabel>Connect your agent</SectionLabel>
            <ThemedText type="subtitle">Meet Brio</ThemedText>
            <ThemedText themeColor="textSecondary">
              Sign in once, then Brio gives you one command to securely connect your agent.
            </ThemedText>
          </View>
          <StatusBadge tone="success">1 command</StatusBadge>
        </View>
        <RelaySignInCard embedded />
      </DashboardCard>
      <OtherConnectionOptions />
    </Screen>
  );
}

function AskAgentCard({ embedded = false }: { embedded?: boolean }) {
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

  const content = (
    <>
      <View style={styles.featureHeader}>
        <View style={styles.featureCopy}>
          <ThemedText type="smallBold">Ask your agent for pairing details</ThemedText>
          <ThemedText themeColor="textSecondary">
            Fallback for a Hermes machine reachable on this network: the agent
            reads its API server URL and key from ~/.hermes/.env.
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
        <ThemedText type="smallBold">1. Copy this message to your agent</ThemedText>
        <ThemedText selectable style={styles.promptText}>
          {HERMES_CONNECT_PROMPT}
        </ThemedText>
        <SecondaryButton label={copyLabel} onPress={() => void copyMessage()} />
      </ThemedView>

      <ThemedText type="smallBold">2. Paste your agent&apos;s reply</ThemedText>
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
        label={connecting ? 'Connecting' : 'Connect From Agent Reply'}
        onPress={() => void connectFromReply()}
      />
    </>
  );

  if (embedded) {
    return <View style={styles.embeddedCardContent}>{content}</View>;
  }

  return (
    <DashboardCard style={styles.featureCard}>
      <SectionLabel>Direct pairing</SectionLabel>
      {content}
    </DashboardCard>
  );
}

function OtherConnectionOptions() {
  return (
    <DashboardCard inset="compact">
      <SectionLabel>Advanced</SectionLabel>
      <Collapsible title="Ask your agent for pairing payload">
        <AskAgentCard embedded />
      </Collapsible>
      <Collapsible title="Paste raw credentials manually">
        <ManualConnectionCard embedded />
      </Collapsible>
    </DashboardCard>
  );
}

function RelaySignInCard({ embedded = false }: { embedded?: boolean }) {
  if (cloudAuthConfigured()) return <CloudRelaySignInCard embedded={embedded} />;
  if (!developmentAuthEnabled()) {
    return (
      <View style={embedded ? styles.embeddedCardContent : undefined}>
        <ThemedText type="smallBold">Brio Connect is not configured</ThemedText>
        <ThemedText themeColor="textSecondary">
          Configure the Clerk publishable key, JWT template, and hosted relay URL in the build
          environment.
        </ThemedText>
      </View>
    );
  }
  return <DevelopmentRelaySignInCard embedded={embedded} />;
}

function CloudRelaySignInCard({ embedded = false }: { embedded?: boolean }) {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const content = (
    <>
      <ThemedText type="smallBold">Brio Connect account</ThemedText>
      <ThemedText themeColor="textSecondary">
        Your account is verified before this device receives separate relay credentials.
      </ThemedText>
      {isLoaded ? (
        isSignedIn ? (
          <ThemedText>Signed in. Securing this device…</ThemedText>
        ) : (
          <CloudAuthView />
        )
      ) : (
        <ActivityIndicator />
      )}
    </>
  );
  if (embedded) return <View style={styles.embeddedCardContent}>{content}</View>;
  return <DashboardCard>{content}</DashboardCard>;
}

function DevelopmentRelaySignInCard({ embedded = false }: { embedded?: boolean }) {
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
      <ThemedText type="smallBold">Development relay identity</ThemedText>
      <ThemedText themeColor="textSecondary">
        Unverified email mode is for an explicitly insecure local relay only.
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

function ControlPlaneHome({
  session,
  onSignOut,
}: {
  session: RelaySession;
  onSignOut?: () => Promise<void>;
}) {
  const clearSession = useRelaySessionStore((state) => state.clearSession);
  const saveSession = useRelaySessionStore((state) => state.saveSession);
  const clearConnection = useConnectionStore((state) => state.clearConnection);
  const saveConnection = useConnectionStore((state) => state.saveConnection);
  const theme = useTheme();
  const [agentName, setAgentName] = useState('Brio Agent');
  const [recoveryAgentID, setRecoveryAgentID] = useState('');
  const [recoveryResult, setRecoveryResult] = useState('');
  const [activeEnrollment, setActiveEnrollment] = useState(session.activeEnrollment);
  const [now, setNow] = useState(() => Date.now());
  const enrollmentExpired = Boolean(
    activeEnrollment && Date.parse(activeEnrollment.expires_at) <= now,
  );

  const agents = useQuery({
    queryKey: ['relay-agents', session.relayURL, session.userID],
    queryFn: () => listRelayAgents(session.relayURL, session.token),
    refetchInterval: (query) =>
      activeEnrollment &&
      !enrollmentExpired &&
      !findSetupAgent(activeEnrollment, query.state.data as RelayAgent[] | undefined)
        ? 2000
        : 10000,
  });

  const enrollment = useMutation({
    mutationFn: () => createRelayEnrollment(session.relayURL, session.token, agentName.trim() || 'Brio Agent'),
    onSuccess: (result) => {
      setActiveEnrollment(result);
      setNow(Date.now());
      void saveSession({ ...session, activeEnrollment: result });
      void agents.refetch();
    },
  });

  const recovery = useMutation({
    mutationFn: () => recoverRelayAgent(session.relayURL, session.token, recoveryAgentID.trim()),
    onSuccess: (result) => {
      setRecoveryResult(recoveryCommand(session.relayURL, result.agent_id, session.token));
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

  const setupConnectedAgent = findSetupAgent(activeEnrollment, agents.data);

  useEffect(() => {
    if (!activeEnrollment) return;
    const expiresIn = Date.parse(activeEnrollment.expires_at) - Date.now();
    if (expiresIn <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), expiresIn);
    return () => clearTimeout(timer);
  }, [activeEnrollment]);

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
            setRecoveryResult('');
            if (onSignOut) {
              void onSignOut();
            } else {
              disconnectRelayClients(session.token);
              void Promise.allSettled([
                revokeRelayDevice(session.relayURL, session.token, session.deviceID),
                clearConnection(),
                clearSession(),
              ]);
            }
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
        {activeEnrollment && !setupConnectedAgent ? (
          <View style={styles.agentRow}>
            <View style={styles.agentCopy}>
              <ThemedText type="smallBold">{activeEnrollment.name}</ThemedText>
              <ThemedText themeColor="textSecondary">
                {enrollmentExpired
                  ? 'Setup code expired—generate a new command'
                  : 'Run setup on your agent machine'}
              </ThemedText>
            </View>
            <StatusBadge tone="neutral">waiting</StatusBadge>
          </View>
        ) : null}
        {agents.data?.map((agent) => (
          <View key={agent.id} style={styles.agentRow}>
            <View style={styles.agentCopy}>
              <ThemedText type="smallBold">{agent.name}</ThemedText>
              <ThemedText themeColor="textSecondary">{agent.id}</ThemedText>
            </View>
            <StatusBadge tone={agent.status === 'online' ? 'success' : 'warning'}>
              {agent.status}
            </StatusBadge>
            <PrimaryButton
              label="Connect"
              onPress={() => void connectAgent(agent)}
            />
          </View>
        ))}
        {!agents.data?.length && !activeEnrollment ? (
          <ThemedText themeColor="textSecondary">No enrolled agents yet.</ThemedText>
        ) : null}
      </DashboardCard>

      <DashboardCard>
        <ThemedText type="smallBold">Connect an agent</ThemedText>
        <ThemedText themeColor="textSecondary">
          Generate one setup command, then run it on the machine hosting your agent.
        </ThemedText>

        <ThemedText type="smallBold">Agent name</ThemedText>
        <TextInput
          autoCapitalize="words"
          autoCorrect={false}
          onChangeText={setAgentName}
          placeholder="Brio Agent"
          placeholderTextColor={theme.textSecondary}
          style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
          value={agentName}
        />

        <PrimaryButton
          disabled={enrollment.isPending}
          label={enrollment.isPending ? 'Generating Command' : 'Generate Setup Command'}
          onPress={() => enrollment.mutate()}
        />

        {enrollment.error ? (
          <ThemedText themeColor="textSecondary">
            {enrollment.error instanceof Error ? enrollment.error.message : 'Could not create enrollment'}
          </ThemedText>
        ) : null}
        {activeEnrollment ? (
          <EnrollmentOutput
            connectedAgent={setupConnectedAgent}
            enrollment={activeEnrollment}
            expired={enrollmentExpired}
            relayURL={session.relayURL}
          />
        ) : null}
      </DashboardCard>

      <DashboardCard inset="compact">
        <SectionLabel>Advanced</SectionLabel>
        <Collapsible title="Recover an enrolled agent">
          <View style={styles.embeddedCardContent}>
            <ThemedText type="smallBold">Recover an enrolled agent</ThemedText>
            <ThemedText themeColor="textSecondary">
              If an agent machine lost its local relay state, recover a fresh relay token for it.
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
              label={recovery.isPending ? 'Generating Recovery' : 'Generate Recovery Command'}
              onPress={() => {
                setRecoveryResult('');
                recovery.mutate();
              }}
            />

            {recovery.error ? (
              <ThemedText themeColor="textSecondary">
                {recovery.error instanceof Error ? recovery.error.message : 'Could not recover agent'}
              </ThemedText>
            ) : null}
            {recoveryResult ? (
              <>
                <ThemedText themeColor="textSecondary" type="small">
                  This one-time command contains a private replacement relay token. Run it only on the
                  matching agent machine.
                </ThemedText>
                <ThemedText selectable type="code" style={styles.jsonBlock}>
                  {recoveryResult}
                </ThemedText>
                <SecondaryButton
                  label="Copy recovery command"
                  onPress={() => void copyToClipboard(recoveryResult)}
                />
              </>
            ) : null}
          </View>
        </Collapsible>
        <Collapsible title="Ask your agent for pairing payload">
          <AskAgentCard embedded />
        </Collapsible>
        <Collapsible title="Paste raw credentials manually">
          <ManualConnectionCard embedded />
        </Collapsible>
      </DashboardCard>
    </Screen>
  );
}

function EnrollmentOutput({
  connectedAgent,
  enrollment,
  expired,
  relayURL,
}: {
  connectedAgent?: RelayAgent;
  enrollment: RelayEnrollmentResponse;
  expired: boolean;
  relayURL: string;
}) {
  const theme = useTheme();
  const [copyLabel, setCopyLabel] = useState('Copy setup command');
  const command = setupInstallCommand(enrollment, relayURL);

  async function copyCommand() {
    try {
      await copyToClipboard(command);
      setCopyLabel('Copied');
    } catch {
      setCopyLabel('Copy failed');
    }
  }

  return (
    <ThemedView style={styles.outputBlock}>
      <View style={styles.statusRow}>
        <StatusBadge tone={connectedAgent?.status === 'online' ? 'success' : connectedAgent ? 'warning' : 'neutral'}>
          {connectedAgent ? (connectedAgent.status === 'online' ? 'connected' : 'enrolled offline') : 'waiting for setup'}
        </StatusBadge>
        <StatusBadge tone={expired ? 'danger' : 'warning'}>{expired ? 'expired' : 'expires soon'}</StatusBadge>
      </View>
      <ThemedText type="smallBold">Run this on your agent machine</ThemedText>
      <ThemedView
        style={[
          styles.commandBlock,
          {
            backgroundColor: theme.backgroundSelected,
            borderColor: theme.border,
          },
        ]}>
        <ThemedText selectable type="code" style={styles.jsonBlock}>
          {command}
        </ThemedText>
      </ThemedView>
      {expired ? (
        <ThemedText themeColor="textSecondary">Generate a new setup command before continuing.</ThemedText>
      ) : (
        <SecondaryButton label={copyLabel} onPress={() => void copyCommand()} />
      )}
    </ThemedView>
  );
}

function ManualConnectionCard({ embedded = false }: { embedded?: boolean }) {
  const theme = useTheme();
  const saveConnection = useConnectionStore((state) => state.saveConnection);
  const [url, setURL] = useState('http://127.0.0.1:8642');
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
            name: 'Brio Agent',
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
        placeholder="http://127.0.0.1:8642"
        placeholderTextColor={theme.textSecondary}
        style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
        value={url}
      />

      <ThemedText type="smallBold">Token</ThemedText>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setToken}
        placeholder="Hermes API key (API_SERVER_KEY)"
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
  const clearConnection = useConnectionStore((state) => state.clearConnection);

  const health = useQuery({
    queryKey: ['health', connection.url, connection.agentId ?? connection.id],
    queryFn: () => getHealth(connection),
    refetchInterval: 10000,
  });

  return (
    <ChatWorkspace
      connection={connection}
      health={health.data}
      healthError={health.isError}
      healthLoading={health.isLoading}
      onDisconnect={() => void clearConnection()}
    />
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
  commandBlock: {
    borderRadius: Spacing.two,
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
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
