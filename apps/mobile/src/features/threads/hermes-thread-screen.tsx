import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useId, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, AppTextInput, Button, Card, EmptyState } from '@/components/t3-ui';
import { CHAT_CONTENT_MAX_WIDTH, T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  approveRun,
  getRun,
  getSessionMessages,
  startRun,
  stopRun,
  type AgentConnection,
  type HermesMessage,
} from '@/lib/brio';
import { EMPTY_PROMPT_QUEUE, type QueuedPrompt } from '@/state/composer-store-model';
import { useComposerStore } from '@/state/composer-store';
import { useRunStore } from '@/state/run-store';

type FeedItem = HermesMessage & { id: string };

export function HermesThreadScreen({
  connection,
  routeSessionId,
}: {
  connection: AgentConnection;
  routeSessionId: string;
}) {
  const colors = useT3Theme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<FeedItem>>(null);
  const generatedSessionId = `brio_new_${useId().replace(/[^a-z0-9_-]/gi, '')}`;
  const sessionId = routeSessionId === 'new' ? generatedSessionId : routeSessionId;
  const runKey = `${connection.id}:${sessionId}`;
  const composerKey = `${connection.id}:${routeSessionId}`;
  const runId = useRunStore((state) => state.activeRuns[runKey] ?? null);
  const setActiveRun = useRunStore((state) => state.setActiveRun);
  const composerHydrated = useComposerStore((state) => state.hydrated);
  const draft = useComposerStore((state) => state.drafts[composerKey] ?? '');
  const queue = useComposerStore(
    (state) => state.queues[composerKey] ?? EMPTY_PROMPT_QUEUE,
  );
  const queuePaused = useComposerStore((state) => Boolean(state.paused[composerKey]));
  const setDraft = useComposerStore((state) => state.setDraft);
  const enqueueDraft = useComposerStore((state) => state.enqueueDraft);
  const claimNext = useComposerStore((state) => state.claimNext);
  const acknowledgePrompt = useComposerStore((state) => state.acknowledge);
  const failPrompt = useComposerStore((state) => state.fail);
  const retryPrompt = useComposerStore((state) => state.retry);
  const removePrompt = useComposerStore((state) => state.remove);
  const movePrompt = useComposerStore((state) => state.move);
  const setQueuePaused = useComposerStore((state) => state.setPaused);
  const moveComposerThread = useComposerStore((state) => state.moveThread);
  const [optimisticPrompt, setOptimisticPrompt] = useState<{
    content: string;
    timestamp: number;
  } | null>(null);

  const messages = useQuery({
    queryKey: ['session-messages', connection.id, connection.url, sessionId],
    queryFn: () => getSessionMessages(connection, sessionId),
    enabled: routeSessionId !== 'new' || Boolean(runId),
  });
  const run = useQuery({
    queryKey: ['run', connection.id, connection.url, runId],
    queryFn: () => getRun(connection, runId!),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ['completed', 'failed', 'cancelled'].includes(status) ? false : 900;
    },
  });
  const terminal = run.data && ['completed', 'failed', 'cancelled'].includes(run.data.status);
  const active = Boolean(runId && !terminal);

  useEffect(() => {
    if (!terminal) return;
    void queryClient.invalidateQueries({
      queryKey: ['session-messages', connection.id, connection.url, sessionId],
    });
    void queryClient.invalidateQueries({ queryKey: ['sessions', connection.id, connection.url] });
  }, [connection.id, connection.url, queryClient, sessionId, terminal]);

  const submit = useMutation({
    mutationFn: async (prompt: QueuedPrompt) => {
      const currentMessages = await getSessionMessages(connection, sessionId);
      const result = await startRun(connection, prompt.text, {
        sessionId,
        conversationHistory: currentMessages.messages
          .filter((message) =>
            (message.role === 'user' || message.role === 'assistant') && Boolean(message.content),
          )
          .map((message) => ({ role: message.role, content: message.content })),
      });
      return result;
    },
    onMutate: (prompt) => {
      setOptimisticPrompt({ content: prompt.text, timestamp: Date.now() / 1000 });
    },
    onSuccess: async (result, prompt) => {
      await setActiveRun(runKey, result.run_id);
      await acknowledgePrompt(composerKey, prompt.id);
      if (routeSessionId === 'new') {
        await moveComposerThread(composerKey, runKey);
        router.replace(`/thread/${encodeURIComponent(sessionId)}`);
      }
    },
    onError: async (reason, prompt) => {
      setOptimisticPrompt(null);
      const message = reason instanceof Error ? reason.message : 'Delivery was not confirmed';
      await failPrompt(composerKey, prompt.id, message);
    },
  });
  const approval = useMutation({
    mutationFn: (choice: 'once' | 'session' | 'always' | 'deny') =>
      approveRun(connection, runId!, choice),
    onSuccess: () => void run.refetch(),
  });

  useEffect(() => {
    if (!composerHydrated || active || submit.isPending || queuePaused) return;
    void claimNext(composerKey).then((prompt) => {
      if (prompt) submit.mutate(prompt);
    });
  }, [active, claimNext, composerHydrated, composerKey, queue, queuePaused, submit]);
  const stop = useMutation({
    mutationFn: () => stopRun(connection, runId!),
    onSuccess: () => void run.refetch(),
  });

  const feed: FeedItem[] = (messages.data?.messages ?? []).map((message, index) => ({
    ...message,
    id: `stored-${index}-${message.timestamp}`,
  }));
  const latestStored = feed.length > 0 ? feed[feed.length - 1]?.content : undefined;
  if (optimisticPrompt && latestStored !== optimisticPrompt.content) {
    feed.push({
      id: 'optimistic-user',
      role: 'user',
      content: optimisticPrompt.content,
      timestamp: optimisticPrompt.timestamp,
    });
  }
  if (run.data?.output && !feed.some((message) => message.content === run.data?.output)) {
    feed.push({
      id: 'current-output',
      role: 'assistant',
      content: run.data.output,
      timestamp: run.data.updated_at ?? 0,
    });
  }

  const send = () => {
    if (!draft.trim() || !composerHydrated) return;
    void enqueueDraft(composerKey, draft);
  };

  const editQueuedPrompt = (prompt: QueuedPrompt) => {
    if (draft.trim()) return;
    setDraft(composerKey, prompt.text);
    void removePrompt(composerKey, prompt.id);
  };

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: colors.screen }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
        style={styles.safe}>
        {messages.isLoading && feed.length === 0 ? (
          <EmptyState detail="Loading the conversation history." loading title="Opening conversation" />
        ) : messages.isError && feed.length === 0 ? (
          <EmptyState
            detail={messages.error instanceof Error ? messages.error.message : 'The conversation could not be loaded.'}
            title="Conversation unavailable"
          />
        ) : (
          <FlatList
            ref={listRef}
            contentContainerStyle={[styles.feed, feed.length === 0 && styles.emptyFeed]}
            data={feed}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={
              <EmptyState
                detail="Describe the work you want Hermes to handle. You can leave this screen while it runs."
                title="What should Hermes work on?"
              />
            }
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            renderItem={({ item }) => <MessageBubble message={item} />}
          />
        )}

        {run.data?.status === 'waiting_for_approval' ? (
          <ApprovalCard
            loading={approval.isPending}
            onChoose={(choice) => approval.mutate(choice)}
          />
        ) : null}

        {active && run.data?.status !== 'waiting_for_approval' ? (
          <View style={[styles.runStrip, { borderTopColor: colors.border }]}>
            <View style={[styles.pulse, { backgroundColor: colors.warning }]} />
            <AppText numberOfLines={1} style={[styles.runLabel, { color: colors.muted }]}>
              {run.data?.last_event ? humanizeEvent(run.data.last_event) : 'Hermes is working'}
            </AppText>
            <Pressable disabled={stop.isPending} onPress={() => stop.mutate()}>
              <AppText style={[styles.stopLabel, { color: colors.danger }]}>Stop</AppText>
            </Pressable>
          </View>
        ) : null}

        {run.data?.status === 'failed' ? (
          <View style={[styles.errorStrip, { backgroundColor: colors.dangerSurface }]}>
            <AppText style={{ color: colors.danger }}>{run.data.error ?? 'The run failed.'}</AppText>
          </View>
        ) : null}

        {queue.length > 0 ? (
          <PromptQueue
            activePromptId={submit.isPending ? submit.variables?.id : undefined}
            draftOccupied={Boolean(draft.trim())}
            onEdit={editQueuedPrompt}
            onMove={(promptId, offset) => void movePrompt(composerKey, promptId, offset)}
            onPause={() => void setQueuePaused(composerKey, !queuePaused)}
            onRemove={(promptId) => void removePrompt(composerKey, promptId)}
            onRetry={(promptId) => void retryPrompt(composerKey, promptId)}
            paused={queuePaused}
            prompts={queue}
          />
        ) : null}

        <View
          style={[
            styles.composerShell,
            { backgroundColor: colors.sheet, borderTopColor: colors.border },
          ]}>
          <View style={styles.composer}>
            <AppTextInput
              accessibilityLabel="Message Hermes"
              multiline
              onChangeText={(text) => setDraft(composerKey, text)}
              onSubmitEditing={send}
              placeholder={active ? 'Queue a follow-up' : 'Message Hermes'}
              style={styles.composerInput}
              value={draft}
            />
            <Pressable
              accessibilityLabel="Send message"
              disabled={!draft.trim() || !composerHydrated}
              onPress={send}
              style={({ pressed }) => [
                styles.send,
                {
                  backgroundColor: colors.primary,
                  opacity: !draft.trim() || !composerHydrated ? 0.3 : pressed ? 0.65 : 1,
                },
              ]}>
              <SymbolView name="arrow.up" size={18} tintColor={colors.primaryForeground} />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function PromptQueue({
  activePromptId,
  draftOccupied,
  onEdit,
  onMove,
  onPause,
  onRemove,
  onRetry,
  paused,
  prompts,
}: {
  activePromptId?: string;
  draftOccupied: boolean;
  onEdit: (prompt: QueuedPrompt) => void;
  onMove: (promptId: string, offset: -1 | 1) => void;
  onPause: () => void;
  onRemove: (promptId: string) => void;
  onRetry: (promptId: string) => void;
  paused: boolean;
  prompts: QueuedPrompt[];
}) {
  const colors = useT3Theme();
  return (
    <View
      style={[
        styles.queueShell,
        { backgroundColor: colors.sheet, borderTopColor: colors.border },
      ]}>
      <View style={styles.queueHeader}>
        <AppText style={styles.queueTitle}>
          {prompts.length} queued {prompts.length === 1 ? 'prompt' : 'prompts'}
        </AppText>
        <Pressable accessibilityRole="button" onPress={onPause}>
          <AppText style={[styles.queueHeaderAction, { color: colors.primary }]}>
            {paused ? 'Resume' : 'Pause'}
          </AppText>
        </Pressable>
      </View>
      <ScrollView style={styles.queueList}>
        {prompts.map((prompt, index) => {
          const sending = activePromptId === prompt.id;
          const uncertain = prompt.state === 'sending' && !sending;
          const canEdit = prompt.state !== 'sending' && !draftOccupied;
          const status = sending
            ? 'Sending…'
            : uncertain
              ? 'Delivery unconfirmed — check the transcript before retrying.'
              : prompt.state === 'failed'
                ? `Not confirmed${prompt.error ? `: ${prompt.error}` : ''}`
                : paused
                  ? 'Paused'
                  : `Queued ${index + 1}`;
          return (
            <View
              key={prompt.id}
              style={[styles.queueItem, { borderTopColor: colors.separator }]}>
              <View style={styles.queueCopy}>
                <AppText numberOfLines={2} style={styles.queuePromptText}>
                  {prompt.text}
                </AppText>
                <AppText
                  numberOfLines={2}
                  style={[styles.queueStatus, { color: colors.muted }]}>
                  {status}
                </AppText>
              </View>
              {!sending ? (
                <View style={styles.queueActions}>
                  {prompt.state !== 'pending' ? (
                    <QueueAction label="Retry" onPress={() => onRetry(prompt.id)} />
                  ) : (
                    <>
                      <QueueAction
                        disabled={index === 0}
                        label="↑"
                        onPress={() => onMove(prompt.id, -1)}
                      />
                      <QueueAction
                        disabled={index === prompts.length - 1}
                        label="↓"
                        onPress={() => onMove(prompt.id, 1)}
                      />
                    </>
                  )}
                  {prompt.state !== 'sending' ? (
                    <QueueAction
                      disabled={!canEdit}
                      label="Edit"
                      onPress={() => onEdit(prompt)}
                    />
                  ) : null}
                  <QueueAction label="Delete" onPress={() => onRemove(prompt.id)} tone="danger" />
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function QueueAction({
  disabled,
  label,
  onPress,
  tone = 'normal',
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  tone?: 'normal' | 'danger';
}) {
  const colors = useT3Theme();
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}>
      <AppText
        style={[
          styles.queueAction,
          { color: tone === 'danger' ? colors.danger : colors.primary, opacity: disabled ? 0.3 : 1 },
        ]}>
        {label}
      </AppText>
    </Pressable>
  );
}

function MessageBubble({ message }: { message: HermesMessage }) {
  const colors = useT3Theme();
  const user = message.role === 'user';
  const tool = Boolean(message.tool_name) || message.role === 'tool';
  return (
    <View style={[styles.messageRow, user && styles.userMessageRow]}>
      <View
        style={[
          styles.bubble,
          user
            ? { backgroundColor: colors.userBubble }
            : tool
              ? { backgroundColor: colors.code, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth }
              : { backgroundColor: 'transparent' },
          user && styles.userBubble,
        ]}>
        {message.tool_name ? (
          <AppText style={[styles.toolName, { color: user ? colors.userBubbleForeground : colors.muted }]}>
            {message.tool_name}
          </AppText>
        ) : null}
        <AppText
          selectable
          style={[
            styles.messageText,
            { color: user ? colors.userBubbleForeground : colors.foreground },
            tool && { fontFamily: T3Typography.mono, fontSize: 13, lineHeight: 19 },
          ]}>
          {message.content || (tool ? 'Tool completed' : '')}
        </AppText>
      </View>
    </View>
  );
}

function ApprovalCard({
  loading,
  onChoose,
}: {
  loading: boolean;
  onChoose: (choice: 'once' | 'session' | 'always' | 'deny') => void;
}) {
  const colors = useT3Theme();
  return (
    <Card style={[styles.approvalCard, { borderColor: colors.warning }]}>
      <AppText style={styles.approvalTitle}>Hermes needs approval</AppText>
      <AppText style={[styles.approvalDetail, { color: colors.muted }]}>
        A protected action is waiting for your decision. Approve only if you trust the current task.
      </AppText>
      <View style={styles.approvalActions}>
        <Button disabled={loading} onPress={() => onChoose('once')} style={styles.approvalButton}>
          Allow once
        </Button>
        <Button disabled={loading} onPress={() => onChoose('session')} style={styles.approvalButton} tone="secondary">
          This session
        </Button>
        <Button disabled={loading} onPress={() => onChoose('deny')} style={styles.approvalButton} tone="danger">
          Deny
        </Button>
      </View>
    </Card>
  );
}

function humanizeEvent(event: string) {
  return event
    .replaceAll('.', ' ')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  feed: {
    alignSelf: 'center',
    gap: T3Spacing.lg,
    maxWidth: CHAT_CONTENT_MAX_WIDTH,
    paddingBottom: T3Spacing.xxl,
    paddingHorizontal: T3Spacing.xl,
    paddingTop: T3Spacing.xxl,
    width: '100%',
  },
  emptyFeed: { flexGrow: 1 },
  messageRow: { alignItems: 'flex-start', width: '100%' },
  userMessageRow: { alignItems: 'flex-end' },
  bubble: { borderRadius: T3Radius.medium, maxWidth: '88%', paddingHorizontal: 0, paddingVertical: 2 },
  userBubble: { borderBottomRightRadius: 5, paddingHorizontal: 14, paddingVertical: 10 },
  messageText: { fontSize: 15, lineHeight: 23 },
  toolName: { fontFamily: T3Typography.bold, fontSize: 11, lineHeight: 15, textTransform: 'uppercase' },
  queueShell: {
    alignSelf: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    maxWidth: CHAT_CONTENT_MAX_WIDTH,
    paddingHorizontal: T3Spacing.lg,
    paddingTop: T3Spacing.sm,
    width: '100%',
  },
  queueHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: T3Spacing.xs,
  },
  queueTitle: { fontFamily: T3Typography.bold, fontSize: 13, lineHeight: 18 },
  queueHeaderAction: { fontFamily: T3Typography.bold, fontSize: 13, lineHeight: 18 },
  queueList: { maxHeight: 210 },
  queueItem: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: T3Spacing.md,
    minHeight: 58,
    paddingVertical: T3Spacing.sm,
  },
  queueCopy: { flex: 1 },
  queuePromptText: { fontSize: 13, lineHeight: 18 },
  queueStatus: { fontSize: 11, lineHeight: 15 },
  queueActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: T3Spacing.sm,
    justifyContent: 'flex-end',
    maxWidth: 150,
  },
  queueAction: { fontFamily: T3Typography.bold, fontSize: 12, lineHeight: 17 },
  composerShell: { borderTopWidth: StyleSheet.hairlineWidth, padding: T3Spacing.md },
  composer: {
    alignItems: 'flex-end',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: T3Spacing.sm,
    maxWidth: CHAT_CONTENT_MAX_WIDTH,
    width: '100%',
  },
  composerInput: { flex: 1, maxHeight: 160, minHeight: 48, paddingVertical: 11 },
  send: {
    alignItems: 'center',
    borderRadius: T3Radius.pill,
    height: 42,
    justifyContent: 'center',
    marginBottom: 3,
    width: 42,
  },
  runStrip: {
    alignItems: 'center',
    alignSelf: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: T3Spacing.sm,
    maxWidth: CHAT_CONTENT_MAX_WIDTH,
    paddingHorizontal: T3Spacing.xl,
    paddingVertical: T3Spacing.sm,
    width: '100%',
  },
  pulse: { borderRadius: 4, height: 7, width: 7 },
  runLabel: { flex: 1, fontSize: 13, lineHeight: 17 },
  stopLabel: { fontFamily: T3Typography.bold, fontSize: 13 },
  errorStrip: { alignSelf: 'center', maxWidth: CHAT_CONTENT_MAX_WIDTH, padding: T3Spacing.md, width: '100%' },
  approvalCard: {
    alignSelf: 'center',
    gap: T3Spacing.sm,
    margin: T3Spacing.md,
    maxWidth: CHAT_CONTENT_MAX_WIDTH,
    padding: T3Spacing.lg,
    width: '92%',
  },
  approvalTitle: { fontFamily: T3Typography.bold },
  approvalDetail: { fontSize: 13, lineHeight: 18 },
  approvalActions: { flexDirection: 'row', flexWrap: 'wrap', gap: T3Spacing.sm },
  approvalButton: { flexGrow: 1, minWidth: 110 },
});
