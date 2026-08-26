import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Button, Card, EmptyState, StatusDot } from '@/components/t3-ui';
import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  getSessionMessages,
  listJobRuns,
  listJobs,
  listSessions,
  type AgentConnection,
  type HermesJob,
  type HermesSession,
} from '@/lib/brio';
import {
  DEFAULT_PROFILE_NAME,
  environmentId,
  listProfiles,
  profileName,
} from '@/lib/profiles';
import { useProfileStore } from '@/state/profile-store';

type AutomationView = 'jobs' | 'heartbeats';
type AutomationResponse = {
  id: string;
  content: string;
  timestamp: number;
};

export function HermesAutomationScreen({ connection }: { connection: AgentConnection }) {
  const colors = useT3Theme();
  const [view, setView] = useState<AutomationView>('jobs');
  const [selectedJob, setSelectedJob] = useState<HermesJob | null>(null);
  const agentId = environmentId(connection);
  const storedProfiles = useProfileStore((state) => state.activeProfiles);
  const profilesQuery = useQuery({
    queryKey: ['profiles', connection.url, agentId],
    queryFn: () => listProfiles(connection),
    staleTime: 30_000,
    retry: false,
  });
  const requestedProfile = storedProfiles[agentId];
  const activeProfile = profilesQuery.data?.profiles.some((profile) => profile.name === requestedProfile)
    ? profileName(requestedProfile)
    : profilesQuery.data
      ? profileName(profilesQuery.data.active)
      : DEFAULT_PROFILE_NAME;

  const jobs = useQuery({
    queryKey: ['automation-jobs', connection.id, connection.url, activeProfile],
    queryFn: async () => {
      const result = await listJobs(connection, activeProfile);
      return Array.isArray(result) ? result : (result.jobs ?? []);
    },
    refetchInterval: 15_000,
  });
  const heartbeatSessions = useQuery({
    queryKey: ['automation-heartbeats', connection.id, connection.url, activeProfile],
    queryFn: () => listSessions(connection, 50, activeProfile, { source: 'heartbeat', order: 'recent' }),
    refetchInterval: 15_000,
  });

  if (selectedJob) {
    return (
      <JobResponses
        connection={connection}
        job={selectedJob}
        onBack={() => setSelectedJob(null)}
        profile={activeProfile}
      />
    );
  }

  const heartbeatCount = heartbeatSessions.data?.sessions.reduce(
    (total, session) => total + Math.max(0, Math.floor(session.message_count / 2)),
    0,
  ) ?? 0;

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.screen }]}>
      <View style={[styles.segmented, { backgroundColor: colors.subtleStrong }]}>
        <Segment label={`Scheduled jobs (${jobs.data?.length ?? 0})`} active={view === 'jobs'} onPress={() => setView('jobs')} />
        <Segment label={`Heartbeats (${heartbeatCount})`} active={view === 'heartbeats'} onPress={() => setView('heartbeats')} />
      </View>
      {view === 'jobs' ? (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={jobs.isRefetching} onRefresh={() => void jobs.refetch()} />}>
          <View style={styles.intro}>
            <AppText style={styles.title}>Scheduled responses</AppText>
            <AppText style={[styles.detail, { color: colors.muted }]}>
              Hermes runs each job in an isolated session. Brio groups those runs by job and shows the responses here instead of mixing them into chat history.
            </AppText>
          </View>
          {jobs.isLoading ? <EmptyState detail="Loading scheduled jobs from Hermes." loading title="Opening automation" /> : null}
          {jobs.isError ? <Failure error={jobs.error} onRetry={() => void jobs.refetch()} /> : null}
          {(jobs.data ?? []).map((job, index) => (
            <JobCard job={job} key={jobID(job) || String(index)} onPress={() => setSelectedJob(job)} />
          ))}
          {!jobs.isLoading && !jobs.isError && jobs.data?.length === 0 ? (
            <EmptyState detail="Create a cron job in Settings or ask Hermes to schedule one." title="No scheduled jobs" />
          ) : null}
        </ScrollView>
      ) : (
        <ResponseFeed
          detail="Recurring heartbeat prompts run in a separate automation session. Only Hermes’ responses appear here."
          emptyDetail="Heartbeat responses will appear here after a configured heartbeat fires."
          emptyTitle="No heartbeat responses"
          profile={activeProfile}
          connection={connection}
          sessions={heartbeatSessions.data?.sessions ?? []}
          sessionsError={heartbeatSessions.error}
          sessionsLoading={heartbeatSessions.isLoading}
          title="Heartbeat responses"
          onRefresh={() => void heartbeatSessions.refetch()}
          refreshing={heartbeatSessions.isRefetching}
        />
      )}
    </SafeAreaView>
  );
}

function JobResponses({
  connection,
  job,
  onBack,
  profile,
}: {
  connection: AgentConnection;
  job: HermesJob;
  onBack: () => void;
  profile: string;
}) {
  const colors = useT3Theme();
  const id = jobID(job);
  const runs = useQuery({
    queryKey: ['automation-job-runs', connection.id, connection.url, profile, id],
    queryFn: () => listJobRuns(connection, id, 20, profile),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.screen }]}>
      <View style={[styles.detailHeader, { borderBottomColor: colors.border }]}>
        <Button onPress={onBack} tone="plain">Back</Button>
        <View style={styles.detailHeaderCopy}>
          <AppText numberOfLines={1} style={styles.detailTitle}>{jobName(job)}</AppText>
          <AppText numberOfLines={1} style={[styles.meta, { color: colors.muted }]}>{jobSchedule(job)}</AppText>
        </View>
      </View>
      <ResponseFeed
        connection={connection}
        detail="Each card is Hermes’ final response from one isolated run. The cron request itself stays hidden."
        emptyDetail="Run this job once and its response will appear here."
        emptyTitle="No responses yet"
        profile={profile}
        sessions={runs.data?.runs ?? []}
        sessionsError={runs.error}
        sessionsLoading={runs.isLoading}
        title="Run responses"
        onRefresh={() => void runs.refetch()}
        refreshing={runs.isRefetching}
        oneResponsePerSession
      />
    </SafeAreaView>
  );
}

function ResponseFeed({
  connection,
  detail,
  emptyDetail,
  emptyTitle,
  onRefresh,
  oneResponsePerSession = false,
  profile,
  refreshing,
  sessions,
  sessionsError,
  sessionsLoading,
  title,
}: {
  connection: AgentConnection;
  detail: string;
  emptyDetail: string;
  emptyTitle: string;
  onRefresh: () => void;
  oneResponsePerSession?: boolean;
  profile: string;
  refreshing: boolean;
  sessions: HermesSession[];
  sessionsError: unknown;
  sessionsLoading: boolean;
  title: string;
}) {
  const colors = useT3Theme();
  const sessionKey = sessions.map((session) => session.id).join(',');
  const responses = useQuery({
    queryKey: ['automation-responses', connection.id, connection.url, profile, sessionKey, oneResponsePerSession],
    enabled: sessions.length > 0,
    queryFn: async () => {
      const messageSets = await Promise.all(
        sessions.map((session) => getSessionMessages(connection, session.id, profile)),
      );
      return collectResponses(sessions, messageSets.map((set) => set.messages), oneResponsePerSession);
    },
    refetchInterval: 15_000,
  });
  const refreshAll = () => {
    onRefresh();
    void responses.refetch();
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing || responses.isRefetching} onRefresh={refreshAll} />}>
      <View style={styles.intro}>
        <AppText style={styles.title}>{title}</AppText>
        <AppText style={[styles.detail, { color: colors.muted }]}>{detail}</AppText>
      </View>
      {sessionsLoading || (sessions.length > 0 && responses.isLoading) ? (
        <EmptyState detail="Loading automation responses from Hermes." loading title="Collecting responses" />
      ) : null}
      {sessionsError || responses.isError ? <Failure error={sessionsError ?? responses.error} onRetry={refreshAll} /> : null}
      {(responses.data ?? []).map((response) => <ResponseCard key={response.id} response={response} />)}
      {!sessionsLoading && !sessionsError && !responses.isLoading && !responses.isError && (responses.data?.length ?? 0) === 0 ? (
        <EmptyState detail={emptyDetail} title={emptyTitle} />
      ) : null}
    </ScrollView>
  );
}

function JobCard({ job, onPress }: { job: HermesJob; onPress: () => void }) {
  const colors = useT3Theme();
  const paused = job.paused === true || job.enabled === false || job.state === 'paused';
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      <Card style={styles.jobCard}>
        <View style={styles.jobTitleRow}>
          <StatusDot status={paused ? 'offline' : job.last_status === 'failed' ? 'error' : 'online'} />
          <AppText numberOfLines={1} style={styles.jobTitle}>{jobName(job)}</AppText>
          <AppText style={{ color: colors.tertiary }}>›</AppText>
        </View>
        <AppText numberOfLines={2} style={[styles.jobPrompt, { color: colors.secondary }]}>{job.prompt || 'Script-only scheduled job'}</AppText>
        <AppText style={[styles.meta, { color: colors.muted }]}>
          {jobSchedule(job)}{job.last_run_at ? ` · Last response ${formatTime(job.last_run_at)}` : ''}
        </AppText>
      </Card>
    </Pressable>
  );
}

function ResponseCard({ response }: { response: AutomationResponse }) {
  const colors = useT3Theme();
  return (
    <Card style={styles.responseCard}>
      <View style={styles.responseHeader}>
        <AppText style={styles.responseLabel}>Hermes</AppText>
        <AppText style={[styles.meta, { color: colors.tertiary }]}>{formatTime(response.timestamp)}</AppText>
      </View>
      <AppText selectable style={styles.responseText}>{response.content}</AppText>
    </Card>
  );
}

function Segment({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  const colors = useT3Theme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.segment, active && { backgroundColor: colors.card }]}>
      <AppText style={[styles.segmentLabel, { color: active ? colors.foreground : colors.muted }]}>{label}</AppText>
    </Pressable>
  );
}

function Failure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <EmptyState
      action={<Button onPress={onRetry}>Try again</Button>}
      detail={error instanceof Error ? error.message : 'The automation response request failed.'}
      title="Automation unavailable"
    />
  );
}

function collectResponses(
  sessions: HermesSession[],
  messageSets: { role: string; content: string; timestamp: number }[][],
  oneResponsePerSession: boolean,
) {
  const responses: AutomationResponse[] = [];
  messageSets.forEach((messages, sessionIndex) => {
    const assistant = messages.filter((message) => message.role === 'assistant' && message.content.trim());
    const visible = oneResponsePerSession ? assistant.slice(-1) : assistant;
    visible.forEach((message, messageIndex) => {
      responses.push({
        id: `${sessions[sessionIndex]?.id ?? sessionIndex}:${message.timestamp}:${messageIndex}`,
        content: message.content.trim(),
        timestamp: message.timestamp || sessions[sessionIndex]?.started_at || 0,
      });
    });
  });
  return responses.sort((left, right) => right.timestamp - left.timestamp);
}

function jobID(job: HermesJob) {
  const id = job.id ?? job.job_id;
  return typeof id === 'string' ? id : '';
}

function jobName(job: HermesJob) {
  return String(job.name || jobID(job) || 'Scheduled job');
}

function jobSchedule(job: HermesJob) {
  if (job.schedule_display) return job.schedule_display;
  if (typeof job.schedule === 'string') return job.schedule;
  return job.schedule?.display || job.schedule?.expr || job.schedule?.run_at || 'Scheduled';
}

function formatTime(value: string | number) {
  const numeric = typeof value === 'number' ? value : Date.parse(value);
  const milliseconds = typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : numeric;
  if (!Number.isFinite(milliseconds)) return '';
  return new Date(milliseconds).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  segmented: { alignSelf: 'center', borderRadius: T3Radius.medium, flexDirection: 'row', margin: T3Spacing.lg, maxWidth: 680, padding: 3, width: '90%' },
  segment: { alignItems: 'center', borderRadius: T3Radius.small, flex: 1, minHeight: 40, justifyContent: 'center', paddingHorizontal: T3Spacing.sm },
  segmentLabel: { fontFamily: T3Typography.medium, fontSize: 13, lineHeight: 17 },
  content: { alignSelf: 'center', flexGrow: 1, gap: T3Spacing.md, maxWidth: 720, padding: T3Spacing.xl, paddingBottom: T3Spacing.huge, width: '100%' },
  intro: { gap: T3Spacing.xs, marginBottom: T3Spacing.sm },
  title: { fontFamily: T3Typography.bold, fontSize: 24, lineHeight: 30 },
  detail: { fontSize: 14, lineHeight: 20 },
  jobCard: { gap: T3Spacing.sm, padding: T3Spacing.lg },
  jobTitleRow: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.sm },
  jobTitle: { flex: 1, fontFamily: T3Typography.bold, fontSize: 16, lineHeight: 21 },
  jobPrompt: { fontSize: 14, lineHeight: 19 },
  meta: { fontSize: 12, lineHeight: 16 },
  detailHeader: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 58, paddingHorizontal: T3Spacing.sm },
  detailHeaderCopy: { flex: 1, paddingRight: 70 },
  detailTitle: { fontFamily: T3Typography.bold, fontSize: 17, lineHeight: 22, textAlign: 'center' },
  responseCard: { gap: T3Spacing.md, padding: T3Spacing.lg },
  responseHeader: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  responseLabel: { fontFamily: T3Typography.bold, fontSize: 13, lineHeight: 17 },
  responseText: { fontSize: 15, lineHeight: 22 },
});
