import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import Markdown from 'react-native-markdown-display';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Button, Card, EmptyState, StatusDot } from '@/components/t3-ui';
import { T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  getSessionMessages,
  listAutomationSessionsPage,
  listJobRunsPage,
  listJobs,
  type AgentConnection,
  type HermesJob,
  type HermesSessionPage,
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
  sessionId: string;
  content: string;
  timestamp: number;
  startedAt: number;
  endedAt?: number | null;
  messageCount: number;
  model?: string;
};

const INITIAL_AUTOMATION_RESPONSE_LIMIT = 5;
const MAX_AUTOMATION_PAGES = 20;

type AutomationPageLoader = (cursor?: string) => Promise<HermesSessionPage>;

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

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.screen }]}>
      <View style={[styles.segmented, { backgroundColor: colors.subtleStrong }]}>
        <Segment label={`Scheduled jobs (${jobs.data?.length ?? 0})`} active={view === 'jobs'} onPress={() => setView('jobs')} />
        <Segment label="Heartbeats" active={view === 'heartbeats'} onPress={() => setView('heartbeats')} />
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
        detail="Recurring heartbeat prompts run in isolated automation sessions seeded from the source chat. Only Hermes’ responses appear here."
        emptyDetail="Heartbeat responses will appear here after a configured heartbeat fires."
        emptyTitle="No heartbeat responses"
        profile={activeProfile}
        connection={connection}
        title="Heartbeat responses"
        queryKey={['automation-heartbeats', connection.id, connection.url, activeProfile]}
        loadPage={(cursor) => listAutomationSessionsPage(
          connection,
          INITIAL_AUTOMATION_RESPONSE_LIMIT,
          activeProfile,
          { source: 'heartbeat', order: 'recent' },
          cursor,
        )}
        oneResponsePerSession
        requestPrefix="[Heartbeat — recurring instruction"
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
        title="Run responses"
        queryKey={['automation-job-runs', connection.id, connection.url, profile, id]}
        enabled={Boolean(id)}
        loadPage={(cursor) => listJobRunsPage(
          connection,
          id,
          INITIAL_AUTOMATION_RESPONSE_LIMIT,
          profile,
          cursor,
        )}
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
  loadPage,
  enabled = true,
  oneResponsePerSession = false,
  profile,
  queryKey,
  requestPrefix,
  title,
}: {
  connection: AgentConnection;
  detail: string;
  emptyDetail: string;
  emptyTitle: string;
  loadPage: AutomationPageLoader;
  enabled?: boolean;
  oneResponsePerSession?: boolean;
  profile: string;
  queryKey: readonly unknown[];
  requestPrefix?: string;
  title: string;
}) {
  const colors = useT3Theme();
  const [selectedResponse, setSelectedResponse] = useState<AutomationResponse | null>(null);
  const sessionQuery = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => loadPage(typeof pageParam === 'string' ? pageParam : undefined),
    initialPageParam: null as string | null,
    enabled,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore || !lastPage.nextCursor) return undefined;
      if (allPages.length >= MAX_AUTOMATION_PAGES) return undefined;
      const previousCursors = new Set(allPages.slice(0, -1).map((page) => page.nextCursor));
      if (previousCursors.has(lastPage.nextCursor)) return undefined;
      const previousIds = new Set(allPages.slice(0, -1).flatMap((page) => page.sessions.map((session) => session.id)));
      const hasNewSession = lastPage.sessions.some((session) => !previousIds.has(session.id));
      if (!hasNewSession && !lastPage.continueWhenEmpty) return undefined;
      return lastPage.nextCursor;
    },
    refetchInterval: 15_000,
    retry: false,
  });
  const sessions = dedupeSessions(sessionQuery.data?.pages.flatMap((page) => page.sessions) ?? []);
  const responseQueries = useQueries({
    queries: sessions.map((session) => ({
      queryKey: ['automation-response', connection.id, connection.url, profile, session.id, session.message_count],
      enabled: enabled && sessions.length > 0,
      queryFn: () => getSessionMessages(connection, session.id, profile),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const successfulSessions: HermesSession[] = [];
  const successfulMessages: { role: string; content: string; timestamp: number }[][] = [];
  responseQueries.forEach((query, index) => {
    if (!query.data) return;
    successfulSessions.push(sessions[index]);
    successfulMessages.push(query.data.messages);
  });
  const responses = collectResponses(successfulSessions, successfulMessages, oneResponsePerSession, requestPrefix);
  const sessionsLoading = sessionQuery.isLoading;
  const responsesLoading = sessions.length > 0 && responseQueries.some((query) => query.isLoading);
  const responsesRefetching = responseQueries.some((query) => query.isRefetching);
  const loadingMoreResponses = sessionQuery.data?.pages.length
    ? sessionQuery.data.pages.length > 1 && responseQueries.some((query) => query.isLoading)
    : false;
  const loadMoreLoading = sessionQuery.isFetchingNextPage || loadingMoreResponses;
  const responseError = responseQueries.find((query) => query.error)?.error;
  const refreshAll = () => {
    void sessionQuery.refetch();
    responseQueries.forEach((query) => void query.refetch());
  };
  const refreshing = sessionQuery.isRefetching && !sessionQuery.isFetchingNextPage;
  const historyCapped = (sessionQuery.data?.pages.length ?? 0) >= MAX_AUTOMATION_PAGES;
  const historyExhausted = (historyCapped || !sessionQuery.hasNextPage) && !sessionQuery.isFetching && !sessionQuery.error;
  const historyWarning = sessionQuery.data?.pages.find((page) => page.warning)?.warning;
  const initialResponsesLoading = (sessionQuery.data?.pages.length ?? 0) <= 1 && responsesLoading;

  if (selectedResponse) {
    return (
      <RunDetail
        response={selectedResponse}
        onBack={() => setSelectedResponse(null)}
      />
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing || responsesRefetching} onRefresh={refreshAll} />}>
      <View style={styles.intro}>
        <AppText style={styles.title}>{title}</AppText>
        <AppText style={[styles.detail, { color: colors.muted }]}>{detail}</AppText>
      </View>
      {sessionsLoading || initialResponsesLoading ? (
        <EmptyState detail="Loading automation responses from Hermes." loading title="Collecting responses" />
      ) : null}
      {sessionQuery.error || responseError ? <Failure error={sessionQuery.error ?? responseError} onRetry={refreshAll} /> : null}
      {responses.map((response) => (
        <ResponseCard
          key={response.id}
          onPress={() => setSelectedResponse(response)}
          response={response}
        />
      ))}
      {historyWarning ? (
        <AppText style={[styles.historyStatus, { color: colors.tertiary }]}>{historyWarning}</AppText>
      ) : null}
      {(sessionQuery.hasNextPage || loadMoreLoading) ? (
        <View style={styles.loadMore}>
          <Button
            disabled={responsesLoading || loadMoreLoading}
            loading={loadMoreLoading}
            onPress={() => void sessionQuery.fetchNextPage()}
            tone="secondary">
            {loadMoreLoading ? 'Loading older responses…' : 'Load older responses'}
          </Button>
        </View>
      ) : null}
      {historyExhausted && sessions.length > 0 ? (
        <AppText style={[styles.historyStatus, { color: colors.muted }]}>
          {historyCapped ? 'Response history limit reached.' : 'No older responses available.'}
        </AppText>
      ) : null}
      {!sessionsLoading && !sessionQuery.error && !responsesLoading && !responseError && responses.length === 0 ? (
        <EmptyState detail={emptyDetail} title={emptyTitle} />
      ) : null}
    </ScrollView>
  );
}

function RunDetail({ response, onBack }: { response: AutomationResponse; onBack: () => void }) {
  const colors = useT3Theme();
  const status = response.endedAt === null ? 'Running' : 'Completed';
  return (
    <View style={styles.runDetail}>
      <View style={[styles.detailHeader, { borderBottomColor: colors.border }]}>
        <Button onPress={onBack} tone="plain">Back</Button>
        <View style={styles.detailHeaderCopy}>
          <AppText style={styles.detailTitle}>Run details</AppText>
          <AppText numberOfLines={1} style={[styles.meta, { color: colors.muted }]}>{formatTime(response.timestamp)}</AppText>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.runDetailContent}>
        <Card style={styles.runSummary}>
          <View style={styles.runSummaryHeader}>
            <View style={styles.runSummaryTitle}>
              <StatusDot status={status === 'Running' ? 'busy' : 'online'} />
              <AppText style={styles.responseLabel}>{status} run</AppText>
            </View>
            <AppText style={[styles.meta, { color: colors.tertiary }]}>Hermes</AppText>
          </View>
          <View style={styles.runMetaGrid}>
            <RunMeta label="Started" value={formatTime(response.startedAt)} />
            <RunMeta label="Finished" value={response.endedAt ? formatTime(response.endedAt) : 'In progress'} />
            <RunMeta label="Messages" value={String(response.messageCount)} />
            <RunMeta label="Model" value={response.model || 'Default'} />
          </View>
          <AppText selectable style={[styles.runID, { color: colors.muted }]}>Run ID: {response.sessionId}</AppText>
        </Card>
        <Card style={styles.markdownCard}>
          <Markdown
            style={{
              body: { color: colors.foreground, fontFamily: T3Typography.regular, fontSize: 15, lineHeight: 23 },
              blockquote: { backgroundColor: colors.subtle, borderLeftColor: colors.primary, borderLeftWidth: 3, color: colors.secondary, paddingHorizontal: 12 },
              bullet_list: { marginBottom: 10 },
              code_block: { backgroundColor: colors.code, borderColor: colors.border, borderRadius: T3Radius.small, borderWidth: StyleSheet.hairlineWidth, color: colors.foreground, fontFamily: T3Typography.mono, padding: 12 },
              code_inline: { backgroundColor: colors.code, borderRadius: 4, color: colors.foreground, fontFamily: T3Typography.mono, paddingHorizontal: 3 },
              fence: { backgroundColor: colors.code, borderColor: colors.border, borderRadius: T3Radius.small, borderWidth: StyleSheet.hairlineWidth, color: colors.foreground, fontFamily: T3Typography.mono, padding: 12 },
              heading1: { color: colors.foreground, fontFamily: T3Typography.bold, fontSize: 24, lineHeight: 30, marginBottom: 10, marginTop: 8 },
              heading2: { color: colors.foreground, fontFamily: T3Typography.bold, fontSize: 20, lineHeight: 26, marginBottom: 8, marginTop: 8 },
              heading3: { color: colors.foreground, fontFamily: T3Typography.bold, fontSize: 17, lineHeight: 23, marginBottom: 6, marginTop: 8 },
              link: { color: colors.primary },
              list_item: { marginBottom: 4 },
              ordered_list: { marginBottom: 10 },
              paragraph: { marginBottom: 10 },
            }}>
            {response.content}
          </Markdown>
        </Card>
      </ScrollView>
    </View>
  );
}

function RunMeta({ label, value }: { label: string; value: string }) {
  const colors = useT3Theme();
  return (
    <View style={styles.runMetaItem}>
      <AppText style={[styles.meta, { color: colors.muted }]}>{label}</AppText>
      <AppText numberOfLines={1} style={styles.runMetaValue}>{value}</AppText>
    </View>
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

function ResponseCard({ response, onPress }: { response: AutomationResponse; onPress: () => void }) {
  const colors = useT3Theme();
  const status = response.endedAt === null ? 'Running' : 'Completed';
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1 })}>
      <Card style={styles.responseCard}>
        <View style={styles.responseHeader}>
          <View style={styles.responseTitle}>
            <StatusDot status={status === 'Running' ? 'busy' : 'online'} />
            <AppText style={styles.responseLabel}>{status} run</AppText>
          </View>
          <AppText style={[styles.meta, { color: colors.tertiary }]}>{formatTime(response.timestamp)}</AppText>
        </View>
        <AppText numberOfLines={3} style={styles.responsePreview}>{previewText(response.content)}</AppText>
        <View style={styles.responseFooter}>
          <AppText style={[styles.meta, { color: colors.muted }]}>
            {response.model || 'Default model'} · {response.messageCount} messages
          </AppText>
          <AppText style={[styles.meta, { color: colors.primary }]}>View details ›</AppText>
        </View>
      </Card>
    </Pressable>
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

function dedupeSessions(sessions: HermesSession[]) {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}

function collectResponses(
  sessions: HermesSession[],
  messageSets: { role: string; content: string; timestamp: number }[][],
  oneResponsePerSession: boolean,
  requestPrefix?: string,
) {
  const responses: AutomationResponse[] = [];
  messageSets.forEach((messages, sessionIndex) => {
    let requestIndex = -1;
    if (requestPrefix) {
      messages.forEach((message, index) => {
        if (message.role === 'user' && message.content.trimStart().startsWith(requestPrefix)) {
          requestIndex = index;
        }
      });
    }
    if (requestPrefix && requestIndex < 0) return;
    const assistant = messages
      .slice(requestIndex + 1)
      .filter((message) => message.role === 'assistant' && message.content.trim());
    const visible = oneResponsePerSession ? assistant.slice(-1) : assistant;
    visible.forEach((message, messageIndex) => {
      responses.push({
        id: `${sessions[sessionIndex]?.id ?? sessionIndex}:${message.timestamp}:${messageIndex}`,
        sessionId: sessions[sessionIndex]?.id ?? String(sessionIndex),
        content: message.content.trim(),
        timestamp: message.timestamp || sessions[sessionIndex]?.started_at || 0,
        startedAt: sessions[sessionIndex]?.started_at || 0,
        endedAt: sessions[sessionIndex]?.ended_at,
        messageCount: sessions[sessionIndex]?.message_count || messages.length,
        model: sessions[sessionIndex]?.model,
      });
    });
  });
  return responses.sort((left, right) => right.timestamp - left.timestamp);
}

function previewText(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, 'Code block')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
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
  responseFooter: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.sm, justifyContent: 'space-between' },
  responseHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  responseLabel: { fontFamily: T3Typography.bold, fontSize: 13, lineHeight: 17 },
  responsePreview: { fontSize: 15, lineHeight: 21 },
  responseTitle: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.sm },
  runDetail: { flex: 1 },
  runDetailContent: { alignSelf: 'center', gap: T3Spacing.md, maxWidth: 720, padding: T3Spacing.xl, paddingBottom: T3Spacing.huge, width: '100%' },
  runID: { fontFamily: T3Typography.mono, fontSize: 11, lineHeight: 16 },
  runMetaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: T3Spacing.lg, marginTop: T3Spacing.sm },
  runMetaItem: { flexGrow: 1, gap: T3Spacing.xs, minWidth: '42%' },
  runMetaValue: { fontSize: 14, lineHeight: 19 },
  runSummary: { gap: T3Spacing.md, padding: T3Spacing.lg },
  runSummaryHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  runSummaryTitle: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.sm },
  markdownCard: { padding: T3Spacing.lg },
  loadMore: { alignItems: 'center', paddingVertical: T3Spacing.sm },
  historyStatus: { fontSize: 12, lineHeight: 16, textAlign: 'center' },
});
