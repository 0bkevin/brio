import { useMutation, useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, Button, Card, Divider, StatusDot } from '@/components/t3-ui';
import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  createRelayEnrollment,
  getHealth,
  listRelayAgents,
  recoverRelayAgent,
  type AgentConnection,
  type RelayAgent,
} from '@/lib/brio';
import { useConnectionStore } from '@/state/connection-store';
import { useRelaySessionStore, type RelaySession } from '@/state/relay-session-store';

export function RelayEnvironmentsScreen({ session }: { session: RelaySession }) {
  const colors = useT3Theme();
  const clearSession = useRelaySessionStore((state) => state.clearSession);
  const removeRelayConnections = useConnectionStore((state) => state.removeRelayConnections);
  const saveConnection = useConnectionStore((state) => state.saveConnection);
  const [agentName, setAgentName] = useState('Hermes');
  const [recoveryAgentID, setRecoveryAgentID] = useState('');
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [copied, setCopied] = useState('');

  const agents = useQuery({
    queryKey: ['relay-agents', session.relayURL, session.userID],
    queryFn: () => listRelayAgents(session.relayURL, session.token),
    refetchInterval: 10_000,
  });
  const enrollment = useMutation({
    mutationFn: () =>
      createRelayEnrollment(session.relayURL, session.token, agentName.trim() || 'Hermes'),
    onSuccess: () => void agents.refetch(),
  });
  const recovery = useMutation({
    mutationFn: () => recoverRelayAgent(session.relayURL, session.token, recoveryAgentID.trim()),
    onSuccess: () => void agents.refetch(),
  });

  const connectAgent = async (agent: RelayAgent) => {
    if (connectingId) return;
    setConnectingId(agent.id);
    setConnectionError('');
    const connection: AgentConnection = {
      id: agent.id,
      name: agent.name,
      mode: agent.mode,
      transport: 'relay',
      status: 'connecting',
      capabilities: {},
      url: session.relayURL,
      token: '',
      relayToken: session.token,
      agentId: agent.id,
    };
    try {
      const health = await getHealth(connection);
      if (!health.ok || !(health.agent_ok ?? health.hermes_ok)) {
        throw new Error('The Brio bridge is online, but the connected agent is not ready yet.');
      }
      await saveConnection({ ...connection, status: 'online' });
    } catch (reason) {
      setConnectionError(
        reason instanceof Error
          ? reason.message
          : 'This environment could not be reached through Relay.',
      );
    } finally {
      setConnectingId(null);
    }
  };

  const disconnectRelay = async () => {
    setConnectionError('');
    try {
      await removeRelayConnections(session.relayURL);
      await clearSession();
    } catch (reason) {
      setConnectionError(reason instanceof Error ? reason.message : 'Could not disconnect Relay.');
    }
  };

  const copy = async (label: string, value: string) => {
    try {
      await Clipboard.setStringAsync(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setConnectionError('Could not copy to the clipboard. Select the text and copy it manually.');
    }
  };

  const enrollmentCommand = enrollment.data
    ? `brio companion enroll --relay-url ${shellQuote(session.relayURL)} --code ${shellQuote(enrollment.data.code)} --run`
    : '';

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.screen }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={agents.isRefetching}
            onRefresh={() => void agents.refetch()}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <AppText style={styles.title}>Development Relay</AppText>
            <AppText style={[styles.subtitle, { color: colors.muted }]}>{session.email}</AppText>
            <AppText numberOfLines={1} style={[styles.relayURL, { color: colors.tertiary }]}>
              {session.relayURL}
            </AppText>
          </View>
          <Button onPress={() => void disconnectRelay()} tone="plain">
            Disconnect
          </Button>
        </View>

        {connectionError ? (
          <View style={[styles.error, { backgroundColor: colors.dangerSurface }]}>
            <AppText style={[styles.errorTitle, { color: colors.danger }]}>
              Couldn’t connect
            </AppText>
            <AppText style={[styles.errorDetail, { color: colors.secondary }]}>
              {connectionError}
            </AppText>
          </View>
        ) : null}

        <View style={styles.section}>
          <AppText style={[styles.sectionLabel, { color: colors.muted }]}>Environments</AppText>
          {agents.isLoading ? (
            <Card style={styles.messageCard}>
              <AppText style={[styles.message, { color: colors.muted }]}>
                Loading environments…
              </AppText>
            </Card>
          ) : agents.isError ? (
            <Card style={styles.messageCard}>
              <AppText style={styles.messageTitle}>Relay unavailable</AppText>
              <AppText style={[styles.message, { color: colors.muted }]}>
                {agents.error instanceof Error
                  ? agents.error.message
                  : 'Could not load environments.'}
              </AppText>
              <Button onPress={() => void agents.refetch()} tone="secondary">
                Try again
              </Button>
            </Card>
          ) : agents.data?.length ? (
            <Card>
              {agents.data.map((agent, index) => (
                <View key={agent.id}>
                  {index ? <Divider /> : null}
                  <View style={styles.agentRow}>
                    <StatusDot status={agent.status === 'online' ? 'online' : 'offline'} />
                    <View style={styles.agentCopy}>
                      <AppText numberOfLines={1} style={styles.agentName}>
                        {agent.name}
                      </AppText>
                      <AppText
                        numberOfLines={1}
                        style={[styles.agentMeta, { color: colors.muted }]}
                      >
                        {agent.status === 'online' ? 'Ready to connect' : 'Companion is offline'}
                      </AppText>
                    </View>
                    <Button
                      disabled={agent.status !== 'online' || Boolean(connectingId)}
                      loading={connectingId === agent.id}
                      onPress={() => void connectAgent(agent)}
                      tone="secondary"
                    >
                      Connect
                    </Button>
                  </View>
                </View>
              ))}
            </Card>
          ) : (
            <Card style={styles.messageCard}>
              <View style={[styles.emptyIcon, { backgroundColor: colors.subtle }]}>
                <SymbolView
                  name="externaldrive.connected.to.line.below"
                  size={21}
                  tintColor={colors.secondary}
                />
              </View>
              <AppText style={styles.messageTitle}>No Relay environments yet</AppText>
              <AppText style={[styles.message, { color: colors.muted }]}>
                Generate an enrollment code below to attach a Hermes machine.
              </AppText>
            </Card>
          )}
        </View>

        <View style={styles.section}>
          <AppText style={[styles.sectionLabel, { color: colors.muted }]}>Add environment</AppText>
          <Card style={styles.formCard}>
            <AppText style={styles.cardTitle}>Enroll a Hermes machine</AppText>
            <AppText style={[styles.cardDetail, { color: colors.muted }]}>
              Create a short-lived code, then run the generated command on that machine.
            </AppText>
            <FieldLabel>Environment name</FieldLabel>
            <AppTextInput
              autoCapitalize="words"
              autoCorrect={false}
              onChangeText={setAgentName}
              placeholder="My MacBook"
              value={agentName}
            />
            <Button loading={enrollment.isPending} onPress={() => enrollment.mutate()}>
              Generate enrollment code
            </Button>
            {enrollment.isError ? (
              <AppText style={[styles.inlineError, { color: colors.danger }]}>
                {enrollment.error instanceof Error
                  ? enrollment.error.message
                  : 'Could not create a code.'}
              </AppText>
            ) : null}
            {enrollment.data ? (
              <View style={[styles.output, { backgroundColor: colors.code }]}>
                <AppText style={[styles.codeLabel, { color: colors.muted }]}>
                  Enrollment code
                </AppText>
                <AppText selectable style={styles.code}>
                  {enrollment.data.code}
                </AppText>
                <AppText selectable style={[styles.command, { color: colors.secondary }]}>
                  {enrollmentCommand}
                </AppText>
                <Button onPress={() => void copy('enrollment', enrollmentCommand)} tone="secondary">
                  {copied === 'enrollment' ? 'Command copied' : 'Copy command'}
                </Button>
              </View>
            ) : null}
          </Card>
        </View>

        <View style={styles.section}>
          <AppText style={[styles.sectionLabel, { color: colors.muted }]}>Recovery</AppText>
          <Card style={styles.formCard}>
            <AppText style={styles.cardTitle}>Recover an enrolled machine</AppText>
            <AppText style={[styles.cardDetail, { color: colors.muted }]}>
              Use this only if a Companion lost its local Relay credentials.
            </AppText>
            <FieldLabel>Agent ID</FieldLabel>
            <AppTextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setRecoveryAgentID}
              placeholder="agent_…"
              value={recoveryAgentID}
            />
            <Button
              disabled={!recoveryAgentID.trim()}
              loading={recovery.isPending}
              onPress={() => recovery.mutate()}
              tone="secondary"
            >
              Generate recovery details
            </Button>
            {recovery.isError ? (
              <AppText style={[styles.inlineError, { color: colors.danger }]}>
                {recovery.error instanceof Error
                  ? recovery.error.message
                  : 'Could not recover this machine.'}
              </AppText>
            ) : null}
            {recovery.data ? (
              <View style={[styles.output, { backgroundColor: colors.code }]}>
                <AppText selectable style={[styles.command, { color: colors.secondary }]}>
                  {JSON.stringify(
                    {
                      agent_id: recovery.data.agent_id,
                      relay_token: recovery.data.agent_token,
                      code: recovery.data.code,
                      expires_at: recovery.data.expires_at,
                    },
                    null,
                    2,
                  )}
                </AppText>
                <Button
                  onPress={() =>
                    void copy(
                      'recovery',
                      JSON.stringify({
                        agent_id: recovery.data.agent_id,
                        relay_token: recovery.data.agent_token,
                        code: recovery.data.code,
                        expires_at: recovery.data.expires_at,
                      }),
                    )
                  }
                  tone="secondary"
                >
                  {copied === 'recovery' ? 'Details copied' : 'Copy recovery details'}
                </Button>
              </View>
            ) : null}
          </Card>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function FieldLabel({ children }: { children: string }) {
  const colors = useT3Theme();
  return <AppText style={[styles.fieldLabel, { color: colors.muted }]}>{children}</AppText>;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    alignSelf: 'center',
    gap: T3Spacing.xxl,
    maxWidth: 720,
    padding: T3Spacing.xl,
    paddingBottom: T3Spacing.huge,
    width: '100%',
  },
  header: { alignItems: 'flex-start', flexDirection: 'row', gap: T3Spacing.md },
  headerCopy: { flex: 1 },
  title: { fontFamily: T3Typography.bold, fontSize: 26, lineHeight: 32 },
  subtitle: { fontSize: 14, lineHeight: 19 },
  relayURL: { fontSize: 11, lineHeight: 16 },
  section: { gap: T3Spacing.sm },
  sectionLabel: {
    fontFamily: T3Typography.bold,
    fontSize: 11,
    letterSpacing: 0.8,
    paddingHorizontal: T3Spacing.xs,
    textTransform: 'uppercase',
  },
  agentRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: T3Spacing.md,
    minHeight: 72,
    padding: T3Spacing.lg,
  },
  agentCopy: { flex: 1 },
  agentName: { fontFamily: T3Typography.bold, fontSize: 15, lineHeight: 20 },
  agentMeta: { fontSize: 12, lineHeight: 17 },
  messageCard: { alignItems: 'center', gap: T3Spacing.md, padding: T3Spacing.xxl },
  messageTitle: { fontFamily: T3Typography.bold, fontSize: 16, textAlign: 'center' },
  message: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  emptyIcon: {
    alignItems: 'center',
    borderRadius: T3Radius.medium,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  formCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
  cardTitle: { fontFamily: T3Typography.bold, fontSize: 16, lineHeight: 21 },
  cardDetail: { fontSize: 13, lineHeight: 19 },
  fieldLabel: {
    fontFamily: T3Typography.bold,
    fontSize: 11,
    letterSpacing: 0.8,
    marginBottom: -4,
    textTransform: 'uppercase',
  },
  output: { borderRadius: T3Radius.medium, gap: T3Spacing.md, padding: T3Spacing.md },
  codeLabel: { fontFamily: T3Typography.bold, fontSize: 11, textTransform: 'uppercase' },
  code: { fontFamily: T3Typography.bold, fontSize: 24, letterSpacing: 2, textAlign: 'center' },
  command: { fontFamily: T3Typography.mono, fontSize: 11, lineHeight: 17 },
  error: { borderRadius: T3Radius.medium, gap: 2, padding: T3Spacing.md },
  errorTitle: { fontFamily: T3Typography.bold, fontSize: 13 },
  errorDetail: { fontSize: 13, lineHeight: 18 },
  inlineError: { fontSize: 13, lineHeight: 18 },
});
