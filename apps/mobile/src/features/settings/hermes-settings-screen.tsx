import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Platform, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, Button, Divider, EmptyState, Row, Section, StatusDot } from '@/components/t3-ui';
import { T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  deleteJob,
  getCapabilities,
  getGatewayStatus,
  getHealth,
  getLogs,
  getMemory,
  getRawConfig,
  getToolsets,
  listJobs,
  listSkills,
  restartGateway,
  runJobAction,
  updateMemory,
  updateRawConfig,
  updateToolset,
  type AgentConnection,
  type HermesJob,
} from '@/lib/brio';
import { useConnectionStore } from '@/state/connection-store';

type Panel = 'memory' | 'config' | 'skills' | 'toolsets' | 'jobs' | 'logs' | null;

export function HermesSettingsScreen({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const router = useRouter();
  const clearConnection = useConnectionStore((state) => state.clearConnection);
  const connections = useConnectionStore((state) => state.connections);
  const [panel, setPanel] = useState<Panel>(null);
  const health = useQuery({ queryKey: ['health', connection.id, connection.url], queryFn: () => getHealth(connection) });
  const capabilities = useQuery({
    queryKey: ['capabilities', connection.id, connection.url],
    queryFn: () => getCapabilities(connection),
  });
  const gateway = useQuery({
    queryKey: ['gateway', connection.id, connection.url],
    queryFn: () => getGatewayStatus(connection),
  });
  const restart = useMutation({
    mutationFn: () => restartGateway(connection),
    onSuccess: () => setTimeout(() => void gateway.refetch(), 1_000),
  });

  const connectorFeatures = Object.entries(capabilities.data?.companion ?? {}).filter(([, value]) => value)
    .length;

  const disconnect = () => {
    const perform = () => {
      void clearConnection()
        .then(() => router.dismissTo('/'))
        .catch((reason: unknown) => {
          const message = reason instanceof Error ? reason.message : 'The environment could not be removed.';
          if (Platform.OS === 'web') globalThis.alert?.(message);
          else Alert.alert('Could not remove environment', message);
        });
    };
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.('Remove this environment from Brio?')) perform();
    } else {
      Alert.alert('Remove environment?', 'Its saved connection will be removed from this device. You can pair it again later.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: perform },
      ]);
    }
  };

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.sheet }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Section title="Environment">
          <Row
            accessory={<StatusDot status={health.data?.hermes_ok ? 'online' : health.isError ? 'error' : 'busy'} />}
            detail={connection.url}
            label={connection.name || 'Hermes'}
            onPress={() => router.push('/environments')}
          />
          <Divider />
          <Row
            accessory={<AppText style={{ color: colors.muted }}>{health.data?.hermes_ok ? 'Connected' : 'Unavailable'}</AppText>}
            label="Hermes Agent"
          />
          <Divider />
          <Row
            accessory={<AppText style={{ color: colors.muted }}>{connectorFeatures || '—'}</AppText>}
            label="Connector features"
          />
        </Section>

        <Section title="Hermes">
          <Row label="Memory" onPress={() => setPanel('memory')} />
          <Divider />
          <Row label="Configuration" onPress={() => setPanel('config')} />
          <Divider />
          <Row label="Skills" onPress={() => setPanel('skills')} />
          <Divider />
          <Row label="Toolsets" onPress={() => setPanel('toolsets')} />
        </Section>

        <Section title="Automation">
          <Row label="Scheduled jobs" onPress={() => setPanel('jobs')} />
          <Divider />
          <Row label="Logs" onPress={() => setPanel('logs')} />
          <Divider />
          <Row
            accessory={<StatusDot status={gateway.data?.running ? 'online' : 'offline'} />}
            detail={gateway.data?.running ? 'Running' : 'Stopped'}
            label="Gateway"
          />
          <Divider />
          <View style={styles.actionRow}>
            <Button loading={restart.isPending} onPress={() => restart.mutate()} tone="secondary">
              Restart gateway
            </Button>
            {restart.isError ? (
              <AppText style={[styles.inlineError, { color: colors.danger }]}>{errorMessage(restart.error)}</AppText>
            ) : null}
          </View>
        </Section>

        <Section title="Connection">
          <Row
            accessory={<AppText style={{ color: colors.muted }}>{connections.length}</AppText>}
            label="Saved environments"
            onPress={() => router.push('/environments')}
          />
          <Divider />
          <View style={styles.actionRow}>
            <Button onPress={() => router.push('/relay')} tone="secondary">Add environment</Button>
          </View>
          <Divider />
          <View style={styles.actionRow}>
            <Button onPress={() => void health.refetch()} tone="secondary">Check connection</Button>
          </View>
          <Divider />
          <View style={styles.actionRow}>
            <Button onPress={disconnect} tone="danger">Remove current environment</Button>
          </View>
        </Section>

        <AppText style={[styles.footer, { color: colors.tertiary }]}>Hermes mobile control</AppText>
      </ScrollView>

      {panel ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.sheet }]}>
          <PanelHeader title={panelTitle(panel)} onClose={() => setPanel(null)} />
          {panel === 'memory' ? <MemoryPanel connection={connection} /> : null}
          {panel === 'config' ? <ConfigPanel connection={connection} /> : null}
          {panel === 'skills' ? <SkillsPanel connection={connection} /> : null}
          {panel === 'toolsets' ? <ToolsetsPanel connection={connection} /> : null}
          {panel === 'jobs' ? <JobsPanel connection={connection} /> : null}
          {panel === 'logs' ? <LogsPanel connection={connection} /> : null}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const colors = useT3Theme();
  return (
    <View style={[styles.panelHeader, { borderBottomColor: colors.border }]}>
      <Button onPress={onClose} tone="plain">Back</Button>
      <AppText style={styles.panelTitle}>{title}</AppText>
      <View style={styles.headerSpacer} />
    </View>
  );
}

function MemoryPanel({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const memory = useQuery({ queryKey: ['memory', connection.id, connection.url], queryFn: () => getMemory(connection) });
  if (memory.isError) {
    return <QueryFailure error={memory.error} onRetry={() => void memory.refetch()} title="Memory unavailable" />;
  }
  if (!memory.data) {
    return <AppText style={[styles.loadingCopy, { color: colors.muted }]}>Loading memory…</AppText>;
  }
  return <MemoryForm connection={connection} initialMemory={memory.data.memory} initialUser={memory.data.user} />;
}

function MemoryForm({
  connection,
  initialMemory,
  initialUser,
}: {
  connection: AgentConnection;
  initialMemory: string;
  initialUser: string;
}) {
  const colors = useT3Theme();
  const [memoryText, setMemoryText] = useState(initialMemory);
  const [userText, setUserText] = useState(initialUser);
  const save = useMutation({
    mutationFn: () => updateMemory(connection, { memory: memoryText, user: userText }),
  });
  return (
    <ScrollView contentContainerStyle={styles.panelContent}>
      <EditorField label="MEMORY.md" onChangeText={setMemoryText} value={memoryText} />
      <EditorField label="USER.md" onChangeText={setUserText} value={userText} />
      {save.isError ? <AppText style={{ color: colors.danger }}>{errorMessage(save.error)}</AppText> : null}
      <Button loading={save.isPending} onPress={() => save.mutate()}>{save.isSuccess ? 'Saved' : 'Save memory'}</Button>
    </ScrollView>
  );
}

function ConfigPanel({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const config = useQuery({ queryKey: ['config', connection.id, connection.url], queryFn: () => getRawConfig(connection) });
  if (config.isError) {
    return <QueryFailure error={config.error} onRetry={() => void config.refetch()} title="Configuration unavailable" />;
  }
  if (!config.data) {
    return <AppText style={[styles.loadingCopy, { color: colors.muted }]}>Loading configuration…</AppText>;
  }
  return <ConfigForm connection={connection} initialYaml={config.data.yaml} />;
}

function ConfigForm({ connection, initialYaml }: { connection: AgentConnection; initialYaml: string }) {
  const colors = useT3Theme();
  const [yaml, setYaml] = useState(initialYaml);
  const save = useMutation({ mutationFn: () => updateRawConfig(connection, yaml) });
  return (
    <View style={styles.editorPanel}>
      <AppTextInput
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        onChangeText={setYaml}
        placeholder="Loading config.yaml…"
        spellCheck={false}
        style={[styles.fullEditor, { backgroundColor: colors.screen, borderColor: 'transparent' }]}
        textAlignVertical="top"
        value={yaml}
      />
      {save.isError ? <AppText style={{ color: colors.danger }}>{errorMessage(save.error)}</AppText> : null}
      <Button loading={save.isPending} onPress={() => save.mutate()}>{save.isSuccess ? 'Saved' : 'Save configuration'}</Button>
    </View>
  );
}

function SkillsPanel({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const skills = useQuery({ queryKey: ['skills', connection.id, connection.url], queryFn: () => listSkills(connection) });
  if (skills.isError) {
    return <QueryFailure error={skills.error} onRetry={() => void skills.refetch()} title="Skills unavailable" />;
  }
  return (
    <ScrollView contentContainerStyle={styles.panelContent}>
      <Section title={`${skills.data?.skills.length ?? 0} installed`}>
        {(skills.data?.skills ?? []).map((skill, index) => (
          <View key={skill.path}>
            {index > 0 ? <Divider /> : null}
            <Row
              accessory={<StatusDot status={skill.enabled ? 'online' : 'offline'} />}
              detail={skill.description || skill.category || skill.path}
              label={skill.name}
            />
          </View>
        ))}
        {skills.isLoading ? <AppText style={[styles.loadingCopy, { color: colors.muted }]}>Loading skills…</AppText> : null}
      </Section>
    </ScrollView>
  );
}

function ToolsetsPanel({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const queryClient = useQueryClient();
  const toolsets = useQuery({ queryKey: ['toolsets', connection.id, connection.url], queryFn: () => getToolsets(connection) });
  const cli = useMemo(() => toolsets.data?.toolsets?.cli ?? [], [toolsets.data?.toolsets?.cli]);
  const known = useMemo(
    () =>
      Array.from(
        new Set([
          ...cli,
          'browser',
          'clarify',
          'computer_use',
          'cronjob',
          'delegation',
          'file',
          'image_gen',
          'memory',
          'search',
          'session_search',
          'skills',
          'terminal',
          'todo',
          'vision',
          'web',
        ]),
      ).sort(),
    [cli],
  );
  const toggle = useMutation({
    mutationFn: ({ enabled, name }: { enabled: boolean; name: string }) =>
      updateToolset(connection, name, enabled),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['toolsets', connection.id, connection.url] }),
  });
  if (toolsets.isError) {
    return <QueryFailure error={toolsets.error} onRetry={() => void toolsets.refetch()} title="Toolsets unavailable" />;
  }
  return (
    <ScrollView contentContainerStyle={styles.panelContent}>
      <Section title="CLI toolsets">
        {known.map((name, index) => (
          <View key={name}>
            {index > 0 ? <Divider /> : null}
            <Row
              accessory={
                <Switch
                  disabled={toggle.isPending}
                  onValueChange={(enabled) => toggle.mutate({ enabled, name })}
                  trackColor={{ true: colors.success }}
                  value={cli.includes(name)}
                />
              }
              label={name}
            />
          </View>
        ))}
      </Section>
    </ScrollView>
  );
}

function JobsPanel({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const queryClient = useQueryClient();
  const jobsQuery = useQuery({ queryKey: ['jobs', connection.id, connection.url], queryFn: () => listJobs(connection) });
  const jobs = Array.isArray(jobsQuery.data) ? jobsQuery.data : (jobsQuery.data?.jobs ?? []);
  const action = useMutation({
    mutationFn: ({ action: nextAction, id }: { action: 'pause' | 'resume' | 'trigger' | 'delete'; id: string }) =>
      nextAction === 'delete' ? deleteJob(connection, id) : runJobAction(connection, id, nextAction),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['jobs', connection.id, connection.url] }),
  });
  if (jobsQuery.isError) {
    return <QueryFailure error={jobsQuery.error} onRetry={() => void jobsQuery.refetch()} title="Scheduled jobs unavailable" />;
  }
  return (
    <ScrollView contentContainerStyle={styles.panelContent}>
      {jobs.length === 0 ? (
        <AppText style={[styles.loadingCopy, { color: colors.muted }]}>
          {jobsQuery.isLoading ? 'Loading scheduled jobs…' : 'No scheduled jobs.'}
        </AppText>
      ) : (
        jobs.map((job, index) => {
          const id = jobId(job);
          const paused = job.paused === true || job.enabled === false;
          return (
            <Section key={id || String(index)} title={String(job.schedule ?? 'Scheduled job')}>
              <Row detail={job.prompt} label={String(job.name ?? id ?? `Job ${index + 1}`)} />
              {id ? (
                <View style={styles.jobActions}>
                  <Button onPress={() => action.mutate({ action: 'trigger', id })} tone="secondary">Run now</Button>
                  <Button onPress={() => action.mutate({ action: paused ? 'resume' : 'pause', id })} tone="secondary">
                    {paused ? 'Resume' : 'Pause'}
                  </Button>
                  <Button onPress={() => action.mutate({ action: 'delete', id })} tone="danger">Delete</Button>
                </View>
              ) : null}
            </Section>
          );
        })
      )}
      {action.isError ? <AppText style={[styles.inlineError, { color: colors.danger }]}>{errorMessage(action.error)}</AppText> : null}
    </ScrollView>
  );
}

function LogsPanel({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const [file, setFile] = useState<'agent' | 'errors' | 'gateway'>('agent');
  const logs = useQuery({
    queryKey: ['logs', connection.id, connection.url, file],
    queryFn: () => getLogs(connection, file, 500),
  });
  if (logs.isError) {
    return <QueryFailure error={logs.error} onRetry={() => void logs.refetch()} title="Logs unavailable" />;
  }
  return (
    <View style={styles.logsPanel}>
      <View style={styles.logTabs}>
        {(['agent', 'errors', 'gateway'] as const).map((name) => (
          <Button key={name} onPress={() => setFile(name)} tone={file === name ? 'primary' : 'secondary'}>
            {name}
          </Button>
        ))}
      </View>
      <ScrollView style={[styles.logs, { backgroundColor: colors.screen }]}>
        <AppText selectable style={[styles.logText, { color: colors.secondary }]}>
          {(logs.data?.lines ?? []).join('\n') || (logs.isLoading ? 'Loading logs…' : 'No log entries.')}
        </AppText>
      </ScrollView>
    </View>
  );
}

function QueryFailure({ error, onRetry, title }: { error: unknown; onRetry: () => void; title: string }) {
  return (
    <EmptyState
      action={<Button onPress={onRetry}>Try again</Button>}
      detail={errorMessage(error)}
      title={title}
    />
  );
}

function EditorField({ label, onChangeText, value }: { label: string; onChangeText: (value: string) => void; value: string }) {
  const colors = useT3Theme();
  return (
    <View style={styles.editorField}>
      <AppText style={[styles.editorLabel, { color: colors.muted }]}>{label}</AppText>
      <AppTextInput multiline onChangeText={onChangeText} style={styles.memoryEditor} textAlignVertical="top" value={value} />
    </View>
  );
}

function panelTitle(panel: Exclude<Panel, null>) {
  return panel.charAt(0).toUpperCase() + panel.slice(1);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The request failed.';
}

function jobId(job: HermesJob) {
  const value = job.id ?? job.job_id;
  return typeof value === 'string' ? value : '';
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    alignSelf: 'center',
    gap: T3Spacing.xxl,
    maxWidth: 720,
    padding: T3Spacing.xl,
    width: '100%',
  },
  actionRow: { paddingVertical: T3Spacing.md },
  inlineError: { fontSize: 13, lineHeight: 18, paddingTop: T3Spacing.sm },
  footer: { fontSize: 12, lineHeight: 16, paddingBottom: T3Spacing.huge, textAlign: 'center' },
  panelHeader: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 58,
    paddingHorizontal: T3Spacing.sm,
  },
  panelTitle: { flex: 1, fontFamily: T3Typography.bold, fontSize: 17, textAlign: 'center' },
  headerSpacer: { width: 70 },
  panelContent: {
    alignSelf: 'center',
    gap: T3Spacing.xxl,
    maxWidth: 720,
    padding: T3Spacing.xl,
    width: '100%',
  },
  editorPanel: { flex: 1, gap: T3Spacing.md, padding: T3Spacing.lg },
  editorField: { gap: T3Spacing.sm },
  editorLabel: { fontFamily: T3Typography.medium, fontSize: 12, textTransform: 'uppercase' },
  memoryEditor: { fontFamily: T3Typography.mono, minHeight: 180 },
  fullEditor: { flex: 1, fontFamily: T3Typography.mono, fontSize: 13, lineHeight: 20 },
  loadingCopy: { paddingVertical: T3Spacing.xl, textAlign: 'center' },
  jobActions: { flexDirection: 'row', flexWrap: 'wrap', gap: T3Spacing.sm, paddingVertical: T3Spacing.md },
  logsPanel: { flex: 1, gap: T3Spacing.md, padding: T3Spacing.lg },
  logTabs: { flexDirection: 'row', gap: T3Spacing.sm },
  logs: { flex: 1, padding: T3Spacing.md },
  logText: { fontFamily: T3Typography.mono, fontSize: 11, lineHeight: 17 },
});
