import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useId, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ComposerControls } from '@/components/composer-controls';
import { AppText, Button, Card, EmptyState } from '@/components/t3-ui';
import { SessionModelControls } from '@/components/session-model-controls';
import { CHAT_CONTENT_MAX_WIDTH, T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  approveRun,
  deleteAttachmentUpload,
  dispatchComposerCommand,
  getRun,
  getModelOptions,
  getSessionContextBreakdown,
  getSessionMessages,
  getSessionUsage,
  listModelSessions,
  hermesResponseText,
  interruptComposerSession,
  prepareComposerPrompt,
  sendComposerResponse,
  setSessionModel,
  startRun,
  stopRun,
  type AgentConnection,
  type HermesMessage,
} from '@/lib/brio';
import { isNamedProfile } from '@/lib/profiles';
import { buildRuntimeModelOptions } from '@/lib/session-runtime';
import { useRunStore } from '@/state/run-store';
import { useComposerStore } from '@/state/composer-store';
import { EMPTY_PROMPT_QUEUE, type QueuedPrompt } from '@/state/composer-store-model';
import type { ChatModelOverride, ChatThread } from '@/state/chat-thread-model';

type FeedItem = HermesMessage & { id: string };

export function HermesThreadScreen({
  connection,
  profile,
  routeSessionId,
}: {
  connection: AgentConnection;
  profile: string;
  routeSessionId: string;
}) {
  const colors = useT3Theme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<FeedItem>>(null);
  const generatedSessionId = `brio_new_${useId().replace(/[^a-z0-9_-]/gi, '')}`;
  const sessionId = routeSessionId === 'new' ? generatedSessionId : routeSessionId;
  const runKey = `${connection.id}:${profile}:${sessionId}`;
  const composerKey = `${connection.id}:${profile}:${routeSessionId}`;
  const destinationComposerKey = `${connection.id}:${profile}:${sessionId}`;
  const [modelOverride, setModelOverride] = useState<ChatModelOverride | undefined>();
  const [immediateMessages, setImmediateMessages] = useState<FeedItem[]>([]);
  const [composerError, setComposerError] = useState('');
  const runId = useRunStore((state) => state.activeRuns[runKey] ?? null);
  const setActiveRun = useRunStore((state) => state.setActiveRun);
  const composerHydrated = useComposerStore((state) => state.hydrated);
  const draft = useComposerStore((state) => state.drafts[composerKey] ?? '');
  const attachments = useComposerStore((state) => state.attachments[composerKey] ?? []);
  const queue = useComposerStore((state) => state.queues[composerKey] ?? EMPTY_PROMPT_QUEUE);
  const queuePaused = useComposerStore((state) => Boolean(state.paused[composerKey]));
  const history = useComposerStore((state) => state.promptHistory[composerKey] ?? []);
  const revisions = useComposerStore((state) => state.draftRevisions[composerKey]);
  const composerStorageError = useComposerStore((state) => state.storageError);
  const setDraft = useComposerStore((state) => state.setDraft);
  const addAttachment = useComposerStore((state) => state.addAttachment);
  const removeAttachment = useComposerStore((state) => state.removeAttachment);
  const enqueueDraft = useComposerStore((state) => state.enqueueDraft);
  const undoDraft = useComposerStore((state) => state.undoDraft);
  const redoDraft = useComposerStore((state) => state.redoDraft);
  const claimNext = useComposerStore((state) => state.claimNext);
  const finalizeAccepted = useComposerStore((state) => state.finalizeAccepted);
  const failPrompt = useComposerStore((state) => state.fail);
  const retryPrompt = useComposerStore((state) => state.retry);
  const removePrompt = useComposerStore((state) => state.remove);
  const editPrompt = useComposerStore((state) => state.edit);
  const movePrompt = useComposerStore((state) => state.move);
  const setQueuePaused = useComposerStore((state) => state.setPaused);
  const [optimisticPrompt, setOptimisticPrompt] = useState<{
    content: string;
    timestamp: number;
  } | null>(null);

  const messages = useQuery({
    queryKey: ['session-messages', connection.id, connection.url, profile, sessionId],
    queryFn: () => getSessionMessages(connection, sessionId, profile),
    enabled: routeSessionId !== 'new' || Boolean(runId),
  });
  const modelOptions = useQuery({
    queryKey: ['model-options', connection.id, connection.url, profile],
    queryFn: () => getModelOptions(connection, false, profile),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const analyticsSessions = useQuery({
    queryKey: ['model-sessions', connection.id, connection.url, profile],
    queryFn: () => listModelSessions(connection, 200, profile),
    staleTime: 30_000,
    retry: false,
  });
  const usage = useQuery({
    queryKey: ['session-usage', connection.id, connection.url, profile, sessionId],
    queryFn: () => getSessionUsage(connection, sessionId, profile),
    enabled: routeSessionId !== 'new',
    refetchInterval: 30_000,
    retry: false,
  });
  const contextBreakdown = useQuery({
    queryKey: ['session-context', connection.id, connection.url, profile, sessionId],
    queryFn: () => getSessionContextBreakdown(connection, sessionId, profile),
    enabled: routeSessionId !== 'new',
    refetchInterval: 30_000,
    retry: false,
  });
  const run = useQuery({
    queryKey: ['run', connection.id, connection.url, profile, runId],
    queryFn: () => getRun(connection, runId!, profile),
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
      queryKey: ['session-messages', connection.id, connection.url, profile, sessionId],
    });
    void queryClient.invalidateQueries({ queryKey: ['sessions', connection.id, connection.url, profile] });
  }, [connection.id, connection.url, profile, queryClient, sessionId, terminal]);

  const submit = useMutation({
    mutationFn: async (queuedPrompt: QueuedPrompt) => {
      const input = queuedPrompt.text.trim();
      if (input.startsWith('/') && queuedPrompt.attachments.length === 0) {
        const response = await dispatchComposerCommand(
          connection,
          sessionId,
          input,
          queuedPrompt.id,
          profile,
        );
        return { kind: 'immediate' as const, output: commandResponseText(response) };
      }

      const attachmentIds = queuedPrompt.attachments.map((attachment) => attachment.id);
      const advancedPrompt = attachmentIds.length > 0 || hasContextReference(input);
      if (advancedPrompt) {
        const relayExpandsComposer = connection.transport === 'relay';
        const responseInput = !relayExpandsComposer
          ? (await prepareComposerPrompt(connection, input, sessionId, attachmentIds, profile)).input
          : input;
        const response = await sendComposerResponse(connection, responseInput, {
          conversation: sessionId,
          conversationHistory: [
            ...(messages.data?.messages ?? [])
              .filter((message) =>
                (message.role === 'user' || message.role === 'assistant') && Boolean(message.content),
              )
              .map((message) => ({ role: message.role, content: message.content })),
            ...immediateMessages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          ],
          model: modelOverride?.model,
          provider: modelOverride?.provider,
          modelOptions: buildRuntimeModelOptions(modelOverride),
          sessionId,
          profile,
          composerSessionId: relayExpandsComposer ? sessionId : undefined,
          attachmentIds: relayExpandsComposer ? attachmentIds : undefined,
        });
        return {
          kind: 'immediate' as const,
          output: hermesResponseText(response),
          responseId: response.id,
        };
      }

      const result = await startRun(connection, input, {
        sessionId,
        model: modelOverride?.model,
        provider: modelOverride?.provider,
        modelOptions: buildRuntimeModelOptions(modelOverride),
        profile,
        conversationHistory: (messages.data?.messages ?? [])
          .filter((message) =>
            (message.role === 'user' || message.role === 'assistant') && Boolean(message.content),
          )
          .map((message) => ({ role: message.role, content: message.content })),
      });
      return { kind: 'run' as const, runId: result.run_id };
    },
    onMutate: (queuedPrompt) => {
      setComposerError('');
      setOptimisticPrompt({ content: displayPrompt(queuedPrompt), timestamp: Date.now() / 1000 });
    },
    onSuccess: async (result, queuedPrompt) => {
      if (result.kind === 'run') {
        setActiveRun(runKey, result.runId);
      } else {
        setImmediateMessages((current) => [
          ...current,
          {
            id: `immediate-${queuedPrompt.id}`,
            role: 'assistant',
            content: result.output,
            timestamp: Date.now() / 1000,
          },
        ]);
        void queryClient.invalidateQueries({
          queryKey: ['session-messages', connection.id, connection.url, profile, sessionId],
        });
      }
      await finalizeAccepted(
        composerKey,
        routeSessionId === 'new' ? destinationComposerKey : composerKey,
        queuedPrompt.id,
      );
      await Promise.all(
        queuedPrompt.attachments.map((attachment) =>
          deleteAttachmentUpload(connection, attachment.id, profile).catch(() => undefined),
        ),
      );
      if (routeSessionId === 'new') {
        router.replace(
          `/thread/${encodeURIComponent(sessionId)}${
            isNamedProfile(profile) ? `?profile=${encodeURIComponent(profile)}` : ''
          }`,
        );
      }
    },
    onError: (reason, queuedPrompt) => {
      setOptimisticPrompt(null);
      const message = reason instanceof Error ? reason.message : 'Hermes could not send the prompt.';
      setComposerError(message);
      void failPrompt(composerKey, queuedPrompt.id, message);
    },
  });
  const approval = useMutation({
    mutationFn: (choice: 'once' | 'session' | 'always' | 'deny') =>
      approveRun(connection, runId!, choice, profile),
    onSuccess: () => void run.refetch(),
  });
  const stop = useMutation({
    mutationFn: () => stopRun(connection, runId!, profile),
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
  immediateMessages.forEach((message) => {
    if (!feed.some((item) => item.content === message.content)) feed.push(message);
  });
  if (run.data?.output && !feed.some((message) => message.content === run.data?.output)) {
    feed.push({
      id: 'current-output',
      role: 'assistant',
      content: run.data.output,
      timestamp: run.data.updated_at ?? 0,
    });
  }

  const controlsThread: ChatThread = {
    id: sessionId,
    profile,
    title: 'Hermes conversation',
    createdAt: 0,
    updatedAt: (() => {
      const timestamp = feed.at(-1)?.timestamp ?? 0;
      return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
    })(),
    messages: feed.map((message) => ({
      id: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.content,
      createdAt: message.timestamp < 10_000_000_000 ? message.timestamp * 1000 : message.timestamp,
    })),
    ...(runId ? { lastResponseId: runId } : {}),
    ...(modelOverride ? { modelOverride } : {}),
    ...(usage.data ? { usage: usage.data } : {}),
    ...(contextBreakdown.data ? { contextBreakdown: contextBreakdown.data } : {}),
    runtimeSessionId: sessionId,
  };
  const changeModelOverride = (override: ChatModelOverride | undefined) => {
    setModelOverride(override);
    if (routeSessionId === 'new') return;
    void setSessionModel(
      connection,
      sessionId,
      override
        ? {
            provider: override.provider,
            model: override.model,
            model_options: buildRuntimeModelOptions(override),
            require_model_lock: true,
          }
        : {},
      profile,
    ).catch(() => undefined);
  };
  const mutatePrompt = submit.mutate;
  useEffect(() => {
    if (!composerHydrated || active || submit.isPending || queuePaused) return;
    void claimNext(composerKey).then((nextPrompt) => {
      if (nextPrompt) mutatePrompt(nextPrompt);
    });
  }, [
    active,
    claimNext,
    composerHydrated,
    composerKey,
    mutatePrompt,
    queue,
    queuePaused,
    submit.isPending,
  ]);

  const send = async (deliveryMode: 'queue' | 'redirect') => {
    if ((!draft.trim() && attachments.length === 0) || !composerHydrated) return;
    const queuedPrompt = await enqueueDraft(composerKey, deliveryMode);
    if (!queuedPrompt || deliveryMode !== 'redirect' || !active) return;
    try {
      await interruptComposerSession(connection, sessionId, profile);
      if (runId) await stopRun(connection, runId, profile).catch(() => undefined);
      void run.refetch();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not redirect the active run.';
      setComposerError(message);
      await failPrompt(composerKey, queuedPrompt.id, message);
    }
  };
  const deleteQueuedPrompt = async (queuedPrompt: QueuedPrompt) => {
    if (!(await removePrompt(composerKey, queuedPrompt.id))) return;
    await Promise.all(
      queuedPrompt.attachments.map((attachment) =>
        deleteAttachmentUpload(connection, attachment.id, profile).catch(() => undefined),
      ),
    );
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

        <View style={[styles.modelControls, { backgroundColor: colors.sheet, borderTopColor: colors.border }]}>
          <SessionModelControls
            onOverrideChange={changeModelOverride}
            options={modelOptions.data}
            optionsError={modelOptions.isError}
            optionsLoading={modelOptions.isLoading}
            sessions={analyticsSessions.data?.sessions}
            thread={controlsThread}
          />
        </View>

        <View style={[styles.composerShell, { backgroundColor: colors.sheet, borderTopColor: colors.border }]}> 
          {queue.length > 0 ? (
            <PromptQueue
              activePromptId={submit.isPending ? submit.variables?.id : undefined}
              draftOccupied={Boolean(draft.trim()) || attachments.length > 0}
              onEdit={(queuedPrompt) => void editPrompt(composerKey, queuedPrompt.id)}
              onMove={(promptId, offset) => void movePrompt(composerKey, promptId, offset)}
              onPause={() => void setQueuePaused(composerKey, !queuePaused)}
              onRemove={(queuedPrompt) => void deleteQueuedPrompt(queuedPrompt)}
              onRetry={(promptId) => void retryPrompt(composerKey, promptId)}
              paused={queuePaused}
              prompts={queue}
            />
          ) : null}
          {composerError || composerStorageError ? (
            <View style={[styles.errorStrip, { backgroundColor: colors.dangerSurface }]}> 
              <AppText style={{ color: colors.danger }}>
                {composerError || composerStorageError}
              </AppText>
            </View>
          ) : null}
          <View style={styles.composer}>
            <ComposerControls
              active={active || submit.isPending}
              attachments={attachments}
              canRedo={Boolean(revisions?.future.length)}
              canUndo={Boolean(revisions?.past.length)}
              connection={connection}
              draft={draft}
              history={history}
              hydrated={composerHydrated}
              onAddAttachment={(attachment) => addAttachment(composerKey, attachment)}
              onDraftChange={(value) => setDraft(composerKey, value)}
              onRedo={() => redoDraft(composerKey)}
              onRemoveAttachment={(attachmentId) => removeAttachment(composerKey, attachmentId)}
              onSend={(mode) => void send(mode)}
              onUndo={() => undoDraft(composerKey)}
              profile={profile}
              sessionId={sessionId}
            />
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
  onRemove: (prompt: QueuedPrompt) => void;
  onRetry: (promptId: string) => void;
  paused: boolean;
  prompts: QueuedPrompt[];
}) {
  const colors = useT3Theme();
  return (
    <View style={[styles.queueShell, { backgroundColor: colors.code, borderColor: colors.border }]}> 
      <View style={styles.queueHeader}>
        <AppText style={styles.queueTitle}>
          {prompts.length} queued {prompts.length === 1 ? 'prompt' : 'prompts'}
        </AppText>
        <Pressable onPress={onPause}>
          <AppText style={[styles.queueAction, { color: colors.primary }]}>{paused ? 'Resume' : 'Pause'}</AppText>
        </Pressable>
      </View>
      {prompts.map((queuedPrompt, index) => {
        const sending = queuedPrompt.id === activePromptId;
        const uncertain = queuedPrompt.state === 'sending' && !sending;
        const status = sending
          ? 'Sending…'
          : uncertain
            ? 'Delivery unconfirmed — verify before retrying.'
            : queuedPrompt.state === 'failed'
              ? queuedPrompt.error || 'Not sent'
              : paused
                ? 'Paused'
                : `Queued ${index + 1}`;
        return (
          <View key={queuedPrompt.id} style={[styles.queueItem, { borderTopColor: colors.border }]}> 
            <View style={styles.queueCopy}>
              <AppText numberOfLines={2} style={styles.queueTitle}>{displayPrompt(queuedPrompt)}</AppText>
              <AppText numberOfLines={2} style={[styles.queueStatus, { color: colors.muted }]}>{status}</AppText>
            </View>
            {!sending ? (
              <View style={styles.queueActions}>
                {queuedPrompt.state === 'pending' ? (
                  <>
                    <QueueAction disabled={index === 0} label="↑" onPress={() => onMove(queuedPrompt.id, -1)} />
                    <QueueAction disabled={index === prompts.length - 1} label="↓" onPress={() => onMove(queuedPrompt.id, 1)} />
                  </>
                ) : (
                  <QueueAction label="Retry" onPress={() => onRetry(queuedPrompt.id)} />
                )}
                {queuedPrompt.state !== 'sending' ? (
                  <QueueAction disabled={draftOccupied} label="Edit" onPress={() => onEdit(queuedPrompt)} />
                ) : null}
                <QueueAction label="Delete" onPress={() => onRemove(queuedPrompt)} tone="danger" />
              </View>
            ) : null}
          </View>
        );
      })}
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
    <Pressable disabled={disabled} onPress={onPress}>
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

function displayPrompt(prompt: QueuedPrompt) {
  const attachmentNames = prompt.attachments.map((attachment) => `📎 ${attachment.name}`);
  return [prompt.deliveryMode === 'redirect' ? '↪ Redirect' : '', prompt.text.trim(), ...attachmentNames]
    .filter(Boolean)
    .join('\n');
}

function commandResponseText(value: Record<string, unknown>): string {
  for (const key of ['output', 'message', 'notice', 'display']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  const nested = value.result;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return commandResponseText(nested as Record<string, unknown>);
  }
  return 'Hermes completed the command.';
}

function hasContextReference(value: string) {
  return /@(file|folder|git|url|session):\S+|@(diff|staged)(?:\b|$)/.test(value);
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
  composerShell: { borderTopWidth: StyleSheet.hairlineWidth, padding: T3Spacing.md },
  modelControls: {
    alignSelf: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    maxWidth: CHAT_CONTENT_MAX_WIDTH,
    paddingHorizontal: T3Spacing.md,
    paddingTop: T3Spacing.sm,
    width: '100%',
  },
  composer: {
    alignSelf: 'center',
    gap: T3Spacing.sm,
    maxWidth: CHAT_CONTENT_MAX_WIDTH,
    width: '100%',
  },
  queueShell: {
    alignSelf: 'center',
    borderRadius: T3Radius.medium,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: T3Spacing.sm,
    maxHeight: 220,
    maxWidth: CHAT_CONTENT_MAX_WIDTH,
    overflow: 'hidden',
    width: '100%',
  },
  queueHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: T3Spacing.md,
    paddingVertical: T3Spacing.sm,
  },
  queueItem: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: T3Spacing.sm,
    paddingHorizontal: T3Spacing.md,
    paddingVertical: T3Spacing.sm,
  },
  queueCopy: { flex: 1 },
  queueTitle: { fontFamily: T3Typography.bold, fontSize: 12, lineHeight: 16 },
  queueStatus: { fontSize: 11, lineHeight: 15 },
  queueActions: { alignItems: 'center', flexDirection: 'row', gap: T3Spacing.sm },
  queueAction: { fontFamily: T3Typography.bold, fontSize: 12, lineHeight: 16 },
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
