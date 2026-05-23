import { useMutation, useQuery } from '@tanstack/react-query';
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

import {
  claimRelayPairing,
  connectionFromPairingPayload,
  createRelayDevice,
  decodePairingPayload,
  getHealth,
  sendResponse,
  type AgentConnection,
} from '@/lib/brio';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useConnectionStore } from '@/state/connection-store';

export default function ChatScreen() {
  const hydrated = useConnectionStore((state) => state.hydrated);
  const connection = useConnectionStore((state) => state.connection);

  if (!hydrated) {
    return <CenteredStatus label="Loading connection" />;
  }

  if (!connection) {
    return <ConnectionForm />;
  }

  return <ConnectedChat connection={connection} />;
}

function ConnectionForm() {
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
        ? connectionFromPairingPayload(decodePairingPayload(pairingPayload))
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
        };
      }
      const health = await getHealth(nextConnection);
      await saveConnection({
        ...nextConnection,
        status: health.hermes_ok ? 'online' : 'error',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <Screen>
      <ThemedView style={styles.header}>
        <ThemedText type="title">Brio</ThemedText>
        <ThemedText themeColor="textSecondary">Connect your Hermes companion.</ThemedText>
      </ThemedView>

      <ThemedView type="backgroundElement" style={styles.panel}>
        <ThemedText type="smallBold">Pairing payload</ThemedText>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          onChangeText={setPairingPayload}
          placeholder="Paste payload from brio connect"
          placeholderTextColor={theme.textSecondary}
          style={[styles.pairingInput, { color: theme.text, borderColor: theme.backgroundSelected }]}
          value={pairingPayload}
        />

        <ThemedText themeColor="textSecondary">Or connect directly for development.</ThemedText>

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
          placeholder="Paste token from brio connect"
          placeholderTextColor={theme.textSecondary}
          secureTextEntry
          style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
          value={token}
        />

        {error ? <ThemedText themeColor="textSecondary">{error}</ThemedText> : null}

        <PrimaryButton
          disabled={testing || (!pairingPayload.trim() && (!url || !token))}
          label="Connect"
          onPress={connect}
        />
      </ThemedView>
    </Screen>
  );
}

function ConnectedChat({ connection }: { connection: AgentConnection }) {
  const theme = useTheme();
  const clearConnection = useConnectionStore((state) => state.clearConnection);
  const [prompt, setPrompt] = useState('');
  const [lastResponse, setLastResponse] = useState<Record<string, unknown> | null>(null);

  const health = useQuery({
    queryKey: ['health', connection.url],
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
        <View>
          <ThemedText type="subtitle">{connection.name}</ThemedText>
          <ThemedText themeColor="textSecondary">
            Hermes {health.data?.hermes_ok ? 'online' : 'not reachable'}
          </ThemedText>
        </View>
        <Pressable onPress={() => void clearConnection()} style={styles.textButton}>
          <ThemedText type="link">Disconnect</ThemedText>
        </Pressable>
      </ThemedView>

      <ThemedView type="backgroundElement" style={styles.panel}>
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
      </ThemedView>

      <ThemedView type="backgroundElement" style={styles.panel}>
        <ThemedText type="smallBold">Latest response</ThemedText>
        {chat.isPending ? <ActivityIndicator /> : null}
        <ThemedText type="code" style={styles.jsonBlock}>
          {lastResponse ? JSON.stringify(lastResponse, null, 2) : 'No response yet.'}
        </ThemedText>
      </ThemedView>
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
        { backgroundColor: disabled ? theme.backgroundSelected : theme.text },
      ]}>
      <ThemedText style={{ color: theme.background }} type="smallBold">
        {label}
      </ThemedText>
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
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  panel: {
    borderRadius: Spacing.two,
    gap: Spacing.three,
    padding: Spacing.three,
  },
  input: {
    borderRadius: Spacing.two,
    borderWidth: 1,
    minHeight: 48,
    paddingHorizontal: Spacing.three,
  },
  messageInput: {
    borderRadius: Spacing.two,
    borderWidth: 1,
    minHeight: 132,
    padding: Spacing.three,
    textAlignVertical: 'top',
  },
  pairingInput: {
    borderRadius: Spacing.two,
    borderWidth: 1,
    minHeight: 92,
    padding: Spacing.three,
    textAlignVertical: 'top',
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    minHeight: 48,
    justifyContent: 'center',
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
});
