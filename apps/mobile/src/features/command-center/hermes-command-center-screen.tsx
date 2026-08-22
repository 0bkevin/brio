import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, Button, Card, EmptyState, StatusDot } from '@/components/t3-ui';
import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  aggregateRootAgentUsage,
  controlRPC,
  executeControlCommand,
  getCommandCenterSnapshot,
  listControlSessions,
  startBackgroundTask,
  type AgentConnection,
  type HermesBackgroundProcess,
  type HermesBackgroundTask,
  type HermesCommandCenterSnapshot,
  type HermesControlEvent,
  type HermesSubagent,
} from '@/lib/brio';

export function HermesCommandCenterScreen({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const environments = [connection];
  const [environmentId, setEnvironmentId] = useState(connection.id);
  const activeConnection =
    environments.find((item) => item.id === environmentId) ?? connection;
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [goalText, setGoalText] = useState('');
  const [subgoalText, setSubgoalText] = useState('');
  const [heartbeatInterval, setHeartbeatInterval] = useState('10m');
  const [heartbeatPrompt, setHeartbeatPrompt] = useState('');
  const [backgroundPrompt, setBackgroundPrompt] = useState('');
  const [steerTarget, setSteerTarget] = useState('');
  const [steerText, setSteerText] = useState('');

  const sessions = useQuery({
    queryKey: ['control-sessions', activeConnection.id, activeConnection.url],
    queryFn: () => listControlSessions(activeConnection),
    refetchInterval: 15_000,
  });
  const sessionId = sessions.data?.sessions.some((session) => session.id === selectedSessionId)
    ? selectedSessionId
    : sessions.data?.sessions[0]?.id ?? '';

  const snapshot = useQuery({
    queryKey: ['command-center', activeConnection.id, activeConnection.url, sessionId],
    queryFn: () => getCommandCenterSnapshot(activeConnection, sessionId),
    enabled: Boolean(sessionId),
    refetchInterval: 5_000,
  });
  const refresh = async () => {
    await Promise.all([sessions.refetch(), snapshot.refetch()]);
  };
  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['command-center', activeConnection.id, activeConnection.url, sessionId],
    });
  };

  const command = useMutation({
    mutationFn: (value: { command: string; confirm?: boolean }) =>
      executeControlCommand(activeConnection, sessionId, value.command, value.confirm),
    onSuccess: invalidate,
  });
  const rpc = useMutation({
    mutationFn: (value: { method: string; params?: Record<string, unknown>; confirm?: boolean }) =>
      controlRPC(activeConnection, value.method, value.params ?? {}, value.confirm),
    onSuccess: invalidate,
  });
  const background = useMutation({
    mutationFn: (text: string) => startBackgroundTask(activeConnection, sessionId, text),
    onSuccess: async () => {
      setBackgroundPrompt('');
      await invalidate();
    },
  });

  const allAgents = useMemo(() => mergeAgents(snapshot.data), [snapshot.data]);
  const agentRoots = useMemo(() => buildAgentTree(allAgents), [allAgents]);
  const usage = useMemo(() => aggregateRootAgentUsage(allAgents), [allAgents]);
  const notifications = useMemo(
    () => notificationEvents(snapshot.data?.events ?? []),
    [snapshot.data?.events],
  );
  const mutationError = command.error ?? rpc.error ?? background.error;

  if (sessions.isLoading) {
    return <EmptyState detail="Loading sessions from the Hermes control plane." loading title="Opening Command Center" />;
  }
  if (sessions.isError) {
    return (
      <EmptyState
        action={<Button onPress={() => void sessions.refetch()}>Try again</Button>}
        detail={`${errorMessage(sessions.error)} Start “hermes serve” and configure its session token in Brio Companion.`}
        title="Hermes control plane unavailable"
      />
    );
  }
  if (!sessions.data?.sessions.length) {
    return <EmptyState detail="Create a Hermes conversation before opening its controls." title="No sessions" />;
  }

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={[styles.safe, { backgroundColor: colors.screen }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <View style={styles.heroTitle}>
            <StatusDot status={snapshot.isError ? 'error' : snapshot.isFetching ? 'busy' : 'online'} />
            <View style={styles.flex}>
              <AppText style={styles.title}>Command Center</AppText>
              <AppText style={[styles.caption, { color: colors.muted }]}>{activeConnection.name} · backend-owned state</AppText>
            </View>
            <Pressable
              accessibilityLabel="Refresh Command Center"
              onPress={() => void refresh()}
              style={({ pressed }) => [styles.iconButton, { backgroundColor: colors.subtleStrong, opacity: pressed ? 0.55 : 1 }]}>
              <SymbolView name="arrow.clockwise" size={17} tintColor={colors.foreground} />
            </Pressable>
          </View>
          {environments.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.chips}>
                {environments.map((environment) => (
                  <Pressable
                    key={environment.id}
                    onPress={() => setEnvironmentId(environment.id)}
                    style={({ pressed }) => [
                      styles.environmentChip,
                      {
                        borderColor: environment.id === activeConnection.id ? colors.foreground : colors.border,
                        opacity: pressed ? 0.65 : 1,
                      },
                    ]}>
                    <StatusDot status={environment.status === 'online' ? 'online' : environment.status === 'error' ? 'error' : 'offline'} />
                    <AppText numberOfLines={1} style={styles.chipText}>{environment.name}</AppText>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          ) : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.chips}>
              {sessions.data.sessions.map((session) => (
                <Pressable
                  accessibilityRole="button"
                  key={session.id}
                  onPress={() => setSelectedSessionId(session.id)}
                  style={({ pressed }) => [
                    styles.chip,
                    {
                      backgroundColor: session.id === sessionId ? colors.primary : colors.subtleStrong,
                      opacity: pressed ? 0.65 : 1,
                    },
                  ]}>
                  <AppText
                    numberOfLines={1}
                    style={[
                      styles.chipText,
                      { color: session.id === sessionId ? colors.primaryForeground : colors.foreground },
                    ]}>
                    {session.title?.trim() || session.preview?.trim() || shortID(session.id)}
                  </AppText>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>

        {snapshot.isLoading ? (
          <Card style={styles.loadingCard}>
            <EmptyState detail="Attaching to the selected Hermes session." loading title="Hydrating controls" />
          </Card>
        ) : snapshot.isError ? (
          <Card style={styles.errorCard}>
            <AppText style={styles.cardTitle}>Could not attach this session</AppText>
            <AppText style={[styles.caption, { color: colors.muted }]}>{errorMessage(snapshot.error)}</AppText>
            <Button onPress={() => void snapshot.refetch()} tone="secondary">Retry</Button>
          </Card>
        ) : snapshot.data ? (
          <>
            <OverviewCard snapshot={snapshot.data} usage={usage} />

            <Panel title="Standing goal" detail="Persistent objective and quality state">
              {snapshot.data.goal ? (
                <>
                  <View style={styles.statusRow}>
                    <StatusPill label={snapshot.data.goal.status} />
                    {snapshot.data.goal.turnsUsed !== undefined ? (
                      <AppText style={[styles.caption, { color: colors.muted }]}>
                        Turn {snapshot.data.goal.turnsUsed}/{snapshot.data.goal.maxTurns}
                      </AppText>
                    ) : null}
                  </View>
                  <AppText style={styles.objective}>{snapshot.data.goal.objective}</AppText>
                  <AppText style={[styles.caption, { color: colors.muted }]}>
                    {snapshot.data.goal.hasContract ? 'Completion contract attached' : 'No structured contract reported'} · {snapshot.data.goal.subgoalCount} subgoals · {snapshot.data.goal.gateCount} gates
                  </AppText>
                  {snapshot.data.goal.hasContract || snapshot.data.goal.gateCount ? (
                    <AppText style={[styles.caption, { color: colors.muted }]}>Hermes enforces the contract and gates; this control contract reports their presence and count.</AppText>
                  ) : null}
                  {snapshot.data.goal.pausedReason ? (
                    <AppText style={[styles.caption, { color: snapshot.data.goal.status === 'blocked' ? colors.danger : colors.muted }]}>
                      {snapshot.data.goal.status === 'blocked' ? 'Blocked' : 'Paused'}: {snapshot.data.goal.pausedReason}
                    </AppText>
                  ) : null}
                  {snapshot.data.goal.subgoals.map((subgoal, index) => (
                    <View style={styles.listRow} key={`${index}-${subgoal}`}>
                      <AppText style={[styles.caption, { color: colors.muted }]}>{index + 1}</AppText>
                      <AppText style={styles.flex}>{subgoal}</AppText>
                      <Button loading={command.isPending} onPress={() => command.mutate({ command: `subgoal remove ${index + 1}` })} tone="plain">Remove</Button>
                    </View>
                  ))}
                  <View style={styles.inlineInputs}>
                    <AppTextInput
                      accessibilityLabel="Additional goal criterion"
                      onChangeText={setSubgoalText}
                      placeholder="Add a completion criterion"
                      style={styles.flex}
                      value={subgoalText}
                    />
                    <Button
                      disabled={!subgoalText.trim()}
                      loading={command.isPending}
                      onPress={() => {
                        command.mutate({ command: `subgoal ${subgoalText.trim()}` });
                        setSubgoalText('');
                      }}>
                      Add
                    </Button>
                  </View>
                  <View style={styles.actions}>
                    {snapshot.data.goal.status === 'paused' || snapshot.data.goal.status === 'blocked' ? (
                      <Button loading={command.isPending} onPress={() => command.mutate({ command: 'goal resume' })} tone="secondary">Resume</Button>
                    ) : (
                      <Button loading={command.isPending} onPress={() => command.mutate({ command: 'goal pause' })} tone="secondary">Pause</Button>
                    )}
                    <Button
                      loading={command.isPending}
                      onPress={() => confirmAction('Clear standing goal?', snapshot.data?.goal?.objective ?? '', () => command.mutate({ command: 'goal clear', confirm: true }))}
                      tone="danger">Clear</Button>
                    {snapshot.data.goal.subgoalCount ? (
                      <Button
                        loading={command.isPending}
                        onPress={() => confirmAction('Clear all completion criteria?', snapshot.data?.goal?.objective ?? '', () => command.mutate({ command: 'subgoal clear', confirm: true }))}
                        tone="plain">Clear criteria</Button>
                    ) : null}
                  </View>
                </>
              ) : (
                <AppText style={[styles.caption, { color: colors.muted }]}>No goal is active for this session.</AppText>
              )}
              <AppTextInput
                accessibilityLabel="Goal objective"
                multiline
                onChangeText={setGoalText}
                placeholder="Set or replace the standing goal"
                value={goalText}
              />
              <Button
                disabled={!goalText.trim()}
                loading={command.isPending}
                onPress={() => {
                  const submit = () => {
                    command.mutate({
                      command: `goal ${goalText.trim()}`,
                      confirm: Boolean(snapshot.data?.goal),
                    });
                    setGoalText('');
                  };
                  if (snapshot.data?.goal) {
                    confirmAction('Replace the standing goal?', snapshot.data.goal.objective, submit);
                  } else {
                    submit();
                  }
                }}>
                {snapshot.data.goal ? 'Replace goal' : 'Set goal'}
              </Button>
            </Panel>

            <Panel title="Heartbeat" detail="Per-session recurring prompt driven by Companion while it is running">
              {snapshot.data.heartbeat ? (
                <>
                  <View style={styles.statusRow}>
                    <StatusPill label={snapshot.data.heartbeat.status} />
                    <AppText style={[styles.caption, { color: colors.muted }]}>Every {snapshot.data.heartbeat.interval}</AppText>
                    {snapshot.data.heartbeat.nextInSeconds !== undefined ? (
                      <AppText style={[styles.caption, { color: colors.muted }]}>Next in ~{snapshot.data.heartbeat.nextInSeconds}s</AppText>
                    ) : null}
                  </View>
                  <AppText>{snapshot.data.heartbeat.prompt}</AppText>
                  {snapshot.data.heartbeat.lastError ? (
                    <AppText style={[styles.caption, { color: colors.danger }]}>
                      Last delivery attempt: {snapshot.data.heartbeat.lastError}
                    </AppText>
                  ) : null}
                  <View style={styles.actions}>
                    <Button
                      loading={command.isPending}
                      onPress={() => command.mutate({ command: `heartbeat ${snapshot.data?.heartbeat?.status === 'paused' ? 'resume' : 'pause'}` })}
                      tone="secondary">
                      {snapshot.data.heartbeat.status === 'paused' ? 'Resume' : 'Pause'}
                    </Button>
                    <Button
                      loading={command.isPending}
                      onPress={() => confirmAction('Clear this heartbeat?', snapshot.data?.heartbeat?.prompt ?? '', () => command.mutate({ command: 'heartbeat clear', confirm: true }))}
                      tone="danger">Clear</Button>
                  </View>
                </>
              ) : null}
              <View style={styles.inlineInputs}>
                <AppTextInput
                  accessibilityLabel="Heartbeat interval"
                  autoCapitalize="none"
                  onChangeText={setHeartbeatInterval}
                  placeholder="10m"
                  style={styles.intervalInput}
                  value={heartbeatInterval}
                />
                <AppTextInput
                  accessibilityLabel="Heartbeat prompt"
                  onChangeText={setHeartbeatPrompt}
                  placeholder="Check the deployment"
                  style={styles.flex}
                  value={heartbeatPrompt}
                />
              </View>
              <Button
                disabled={!heartbeatInterval.trim() || !heartbeatPrompt.trim()}
                loading={command.isPending}
                onPress={() => {
                  const submit = () => {
                    command.mutate({
                      command: `heartbeat every ${heartbeatInterval.trim()} ${heartbeatPrompt.trim()}`,
                      confirm: Boolean(snapshot.data?.heartbeat),
                    });
                    setHeartbeatPrompt('');
                  };
                  if (snapshot.data?.heartbeat) {
                    confirmAction('Replace this heartbeat?', snapshot.data.heartbeat.prompt, submit);
                  } else {
                    submit();
                  }
                }}>
                {snapshot.data.heartbeat ? 'Replace heartbeat' : 'Set heartbeat'}
              </Button>
            </Panel>

            <Panel title="Background tasks" detail="Detached prompts and session-owned processes">
              <AppTextInput
                accessibilityLabel="Background task prompt"
                multiline
                onChangeText={setBackgroundPrompt}
                placeholder="Run a task without blocking this session"
                value={backgroundPrompt}
              />
              <Button
                disabled={!backgroundPrompt.trim()}
                loading={background.isPending}
                onPress={() => background.mutate(backgroundPrompt.trim())}>
                Start background task
              </Button>
              {snapshot.data.backgroundTasks
                .filter((task) => task.session_id === sessionId)
                .map((task) => <BackgroundTaskRow key={task.task_id} task={task} />)}
              {snapshot.data.processes.length ? (
                snapshot.data.processes.map((process, index) => (
                  <ProcessRow
                    key={processID(process, index)}
                    process={process}
                    onKill={() =>
                      confirmAction('Kill this process?', processLabel(process), () =>
                        rpc.mutate({
                          method: 'process.kill',
                          params: { session_id: snapshot.data?.runtimeSessionId, process_id: processID(process, index) },
                          confirm: true,
                        }),
                      )
                    }
                  />
                ))
              ) : (
                <AppText style={[styles.caption, { color: colors.muted }]}>No registered processes for this session.</AppText>
              )}
            </Panel>

            <Panel title="Agents" detail="Session-owned tree · Hermes-wide spawn policy">
              <View style={styles.statusRow}>
                <StatusPill label={snapshot.data.spawningPaused ? 'spawning paused' : 'spawning enabled'} />
                <AppText style={[styles.caption, { color: colors.muted }]}>
                  {snapshot.data.maxConcurrentChildren ?? '–'} max children · depth {snapshot.data.maxSpawnDepth ?? '–'}
                </AppText>
              </View>
              <Button
                loading={rpc.isPending}
                onPress={() => rpc.mutate({ method: 'delegation.pause', params: { paused: !snapshot.data?.spawningPaused } })}
                tone="secondary">
                {snapshot.data.spawningPaused ? 'Resume new agents' : 'Pause new agents'}
              </Button>
              {agentRoots.length ? (
                agentRoots.map((agent) => (
                  <AgentRow
                    agent={agent}
                    key={agent.subagent_id}
                    onJump={(childSessionId) => router.push(`/thread/${encodeURIComponent(childSessionId)}`)}
                    onStop={(target) =>
                      confirmAction('Stop this agent?', `${target.goal || 'Agent'} · ${target.subagent_id}`, () =>
                        rpc.mutate({ method: 'subagent.interrupt', params: { session_id: target.owner_session_id ?? snapshot.data?.runtimeSessionId, subagent_id: target.subagent_id }, confirm: true }),
                      )
                    }
                    onSteer={(target) => setSteerTarget(target.subagent_id)}
                  />
                ))
              ) : (
                <AppText style={[styles.caption, { color: colors.muted }]}>No live or recently observed agents.</AppText>
              )}
              {steerTarget ? (
                <View style={styles.steerBox}>
                  <AppText style={styles.rowTitle}>Steer {shortID(steerTarget)}</AppText>
                  <AppTextInput onChangeText={setSteerText} placeholder="Direction for the next tool boundary" value={steerText} />
                  <View style={styles.actions}>
                    <Button
                      disabled={!steerText.trim()}
                      loading={rpc.isPending}
                      onPress={() => {
                        const target = allAgents.find((agent) => agent.subagent_id === steerTarget);
                        rpc.mutate({ method: 'subagent.steer', params: { session_id: target?.owner_session_id ?? snapshot.data?.runtimeSessionId, subagent_id: steerTarget, text: steerText.trim() } });
                        setSteerText('');
                        setSteerTarget('');
                      }}>
                      Send direction
                    </Button>
                    <Button onPress={() => setSteerTarget('')} tone="plain">Cancel</Button>
                  </View>
                </View>
              ) : null}
            </Panel>

            <Panel title="Notifications" detail="Completion, failure, and approval events only">
              {notifications.length ? notifications.map((event) => <NotificationRow event={event} key={event.sequence} />) : (
                <AppText style={[styles.caption, { color: colors.muted }]}>No recent control-plane notifications.</AppText>
              )}
            </Panel>
          </>
        ) : null}

        {mutationError ? (
          <Card style={[styles.errorCard, { borderColor: colors.danger }]}>
            <AppText style={{ color: colors.danger }}>{errorMessage(mutationError)}</AppText>
          </Card>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Panel({ children, detail, title }: { children: ReactNode; detail: string; title: string }) {
  const colors = useT3Theme();
  return (
    <Card style={styles.panel}>
      <View>
        <AppText style={styles.cardTitle}>{title}</AppText>
        <AppText style={[styles.caption, { color: colors.muted }]}>{detail}</AppText>
      </View>
      {children}
    </Card>
  );
}

function OverviewCard({ snapshot, usage }: { snapshot: HermesCommandCenterSnapshot; usage: ReturnType<typeof aggregateRootAgentUsage> }) {
  return (
    <Card style={styles.overview}>
      <Metric label="Goal" value={snapshot.goal?.status ?? 'none'} />
      <Metric label="Agents" value={String(snapshot.agents.length)} />
      <Metric label="Background" value={String(snapshot.processes.length + snapshot.backgroundTasks.filter((task) => task.status === 'running').length)} />
      <Metric label="Agent tokens" value={compactNumber(usage.inputTokens + usage.outputTokens)} />
      <Metric label="Agent cost" value={usage.costUsd ? `$${usage.costUsd.toFixed(3)}` : '–'} />
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const colors = useT3Theme();
  return (
    <View style={styles.metric}>
      <AppText style={styles.metricValue}>{value}</AppText>
      <AppText style={[styles.caption, { color: colors.muted }]}>{label}</AppText>
    </View>
  );
}

function StatusPill({ label }: { label: string }) {
  const colors = useT3Theme();
  return (
    <View style={[styles.pill, { backgroundColor: colors.subtleStrong }]}>
      <AppText style={styles.pillText}>{label}</AppText>
    </View>
  );
}

type AgentNode = HermesSubagent & { children: AgentNode[] };

function AgentRow({ agent, onJump, onSteer, onStop }: {
  agent: AgentNode;
  onJump: (sessionId: string) => void;
  onSteer: (agent: HermesSubagent) => void;
  onStop: (agent: HermesSubagent) => void;
}) {
  const colors = useT3Theme();
  const active = agent.status === 'running' || agent.status === 'queued';
  return (
    <View style={[styles.agentRow, { borderLeftColor: active ? colors.success : colors.tertiary, marginLeft: Math.min(agent.depth ?? 0, 4) * 14 }]}>
      <View style={styles.rowHeader}>
        <View style={styles.flex}>
          <AppText numberOfLines={2} style={styles.rowTitle}>{agent.goal || 'Subagent'}</AppText>
          <AppText style={[styles.caption, { color: colors.muted }]}>
            {agent.model || 'default model'} · {agent.status || 'running'} · {agent.tool_count ?? 0} tools
          </AppText>
          {agent.input_tokens || agent.output_tokens || agent.cost_usd ? (
            <AppText style={[styles.caption, { color: colors.muted }]}>
              {compactNumber((agent.input_tokens ?? 0) + (agent.output_tokens ?? 0))} tokens
              {agent.cost_usd ? ` · $${agent.cost_usd.toFixed(3)}` : ''}
              {agent.files_read?.length ? ` · ${agent.files_read.length} read` : ''}
              {agent.files_written?.length ? ` · ${agent.files_written.length} written` : ''}
            </AppText>
          ) : null}
          {agent.summary ? (
            <AppText numberOfLines={3} style={[styles.caption, { color: colors.muted }]}>{agent.summary}</AppText>
          ) : null}
          {agent.last_event ? (
            <AppText style={[styles.caption, { color: colors.tertiary }]}>Last event: {agent.last_event.replaceAll('.', ' ')}</AppText>
          ) : null}
        </View>
        <AppText style={[styles.caption, { color: colors.tertiary }]}>{shortID(agent.subagent_id)}</AppText>
      </View>
      <View style={styles.actions}>
        {active ? <Button onPress={() => onSteer(agent)} tone="secondary">Steer</Button> : null}
        {agent.child_session_id ? <Button onPress={() => onJump(agent.child_session_id!)} tone="plain">Open session</Button> : null}
        {active ? <Button onPress={() => onStop(agent)} tone="danger">Stop</Button> : null}
      </View>
      {agent.children.map((child) => <AgentRow agent={child} key={child.subagent_id} onJump={onJump} onSteer={onSteer} onStop={onStop} />)}
    </View>
  );
}

function ProcessRow({ onKill, process }: { onKill: () => void; process: HermesBackgroundProcess }) {
  const colors = useT3Theme();
  const running = process.running === true || process.status === 'running';
  return (
    <View style={styles.listRow}>
      <View style={styles.flex}>
        <AppText numberOfLines={2} style={styles.rowTitle}>{processLabel(process)}</AppText>
        <AppText style={[styles.caption, { color: colors.muted }]}>
          {running ? 'running' : process.exit_code === 0 ? 'completed' : process.status || 'stopped'}
          {process.pid ? ` · pid ${process.pid}` : ''}
        </AppText>
      </View>
      {running ? <Button onPress={onKill} tone="danger">Kill</Button> : null}
    </View>
  );
}

function BackgroundTaskRow({ task }: { task: HermesBackgroundTask }) {
  const colors = useT3Theme();
  return (
    <View style={styles.listRow}>
      <StatusDot status={task.status === 'running' ? 'busy' : task.status === 'failed' ? 'error' : task.status === 'unknown' ? 'offline' : 'online'} />
      <View style={styles.flex}>
        <AppText numberOfLines={2} style={styles.rowTitle}>{task.prompt}</AppText>
        <AppText style={[styles.caption, { color: colors.muted }]}>{task.status} · {shortID(task.task_id)}</AppText>
        {task.output ? <AppText numberOfLines={3} style={[styles.caption, { color: colors.muted }]}>{task.output}</AppText> : null}
      </View>
    </View>
  );
}

function NotificationRow({ event }: { event: HermesControlEvent }) {
  const colors = useT3Theme();
  const payload = event.payload ?? {};
  const text = String(payload.text ?? payload.message ?? payload.summary ?? event.type);
  return (
    <View style={styles.listRow}>
      <StatusDot status={/fail|error/i.test(text) ? 'error' : /approval/i.test(event.type) ? 'busy' : 'online'} />
      <View style={styles.flex}>
        <AppText style={styles.rowTitle}>{event.type.replaceAll('.', ' ')}</AppText>
        <AppText numberOfLines={3} style={[styles.caption, { color: colors.muted }]}>{text}</AppText>
      </View>
    </View>
  );
}

function mergeAgents(snapshot?: HermesCommandCenterSnapshot): HermesSubagent[] {
  const byID = new Map<string, HermesSubagent>();
  for (const agent of snapshot?.agents ?? []) byID.set(agent.subagent_id, agent);
  for (const event of snapshot?.events ?? []) {
    if (!event.type.startsWith('subagent.') || !event.payload) continue;
    const id = typeof event.payload.subagent_id === 'string' ? event.payload.subagent_id : '';
    if (!id) continue;
    const previous = byID.get(id);
    const next = {
      ...previous,
      ...event.payload,
      subagent_id: id,
      last_event: event.type,
      ...(event.session_id ? { owner_session_id: event.session_id } : {}),
    } as HermesSubagent;
    if (event.type === 'subagent.complete' && !next.status) next.status = 'completed';
    byID.set(id, next);
  }
  return [...byID.values()];
}

function buildAgentTree(agents: HermesSubagent[]): AgentNode[] {
  const nodes = new Map(agents.map((agent) => [agent.subagent_id, { ...agent, children: [] as AgentNode[] }]));
  const roots: AgentNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items: AgentNode[]) => items.sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0)).forEach((item) => sort(item.children));
  sort(roots);
  return roots;
}

function notificationEvents(events: HermesControlEvent[]) {
  return events
    .filter((event) => event.type === 'background.complete' || event.type.startsWith('approval.') || event.type === 'notification.show' || event.type === 'subagent.complete')
    .slice(-8)
    .reverse();
}

function processID(process: HermesBackgroundProcess, fallback: number) {
  return String(process.process_id ?? process.session_id ?? process.pid ?? fallback);
}

function processLabel(process: HermesBackgroundProcess) {
  return String(process.command ?? process.process_id ?? process.session_id ?? `Process ${process.pid ?? ''}`).trim();
}

function confirmAction(title: string, message: string, action: () => void) {
  Alert.alert(title, message, [
    { style: 'cancel', text: 'Cancel' },
    { onPress: action, style: 'destructive', text: 'Confirm' },
  ]);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The request failed.';
}

function shortID(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function compactNumber(value: number) {
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { alignSelf: 'center', gap: T3Spacing.lg, maxWidth: 920, padding: T3Spacing.xl, paddingBottom: 56, width: '100%' },
  hero: { gap: T3Spacing.md },
  heroTitle: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.md },
  title: { fontFamily: T3Typography.bold, fontSize: 26, lineHeight: 32 },
  caption: { fontSize: 13, lineHeight: 18 },
  iconButton: { alignItems: 'center', borderRadius: T3Radius.medium, height: 42, justifyContent: 'center', width: 42 },
  chips: { flexDirection: 'row', gap: T3Spacing.sm },
  chip: { borderRadius: T3Radius.pill, maxWidth: 240, paddingHorizontal: T3Spacing.lg, paddingVertical: 9 },
  environmentChip: { alignItems: 'center', borderRadius: T3Radius.pill, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: T3Spacing.sm, maxWidth: 220, paddingHorizontal: T3Spacing.md, paddingVertical: 8 },
  chipText: { fontFamily: T3Typography.medium, fontSize: 13, lineHeight: 18 },
  panel: { gap: T3Spacing.md, padding: T3Spacing.lg },
  cardTitle: { fontFamily: T3Typography.bold, fontSize: 18, lineHeight: 23 },
  objective: { fontFamily: T3Typography.medium, fontSize: 17, lineHeight: 23 },
  statusRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: T3Spacing.sm },
  actions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: T3Spacing.sm },
  inlineInputs: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.sm },
  intervalInput: { width: 92 },
  overview: { flexDirection: 'row', flexWrap: 'wrap', padding: T3Spacing.md },
  metric: { minWidth: 120, padding: T3Spacing.sm },
  metricValue: { fontFamily: T3Typography.bold, fontSize: 20, lineHeight: 25 },
  pill: { borderRadius: T3Radius.pill, paddingHorizontal: T3Spacing.md, paddingVertical: T3Spacing.xs },
  pillText: { fontFamily: T3Typography.medium, fontSize: 12, lineHeight: 16, textTransform: 'capitalize' },
  agentRow: { borderLeftWidth: 2, gap: T3Spacing.sm, paddingLeft: T3Spacing.md, paddingVertical: T3Spacing.sm },
  rowHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: T3Spacing.md },
  rowTitle: { fontFamily: T3Typography.medium, fontSize: 14, lineHeight: 19 },
  listRow: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.md, minHeight: 48 },
  steerBox: { gap: T3Spacing.sm },
  flex: { flex: 1 },
  loadingCard: { minHeight: 220 },
  errorCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
});
