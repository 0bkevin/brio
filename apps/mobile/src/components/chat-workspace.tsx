import * as Clipboard from 'expo-clipboard';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { SessionModelControls } from '@/components/session-model-controls';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  getHermesSessionMessages,
  getSessionContextBreakdown,
  getSessionUsage,
  hermesResponseText,
  isAgentHealthy,
  listHermesModelOptions,
  listHermesSessions,
  sendResponseStream,
  type AgentConnection,
  type HealthResponse,
  type HermesSession,
} from '@/lib/brio';
import {
  buildRuntimeModelOptions,
  modelIncompatibilities,
  normalizeLiveUsage,
  selectedCapabilities,
  type NormalizedContextBreakdown,
  type NormalizedRuntimeUsage,
} from '@/lib/session-runtime';
import {
  createChatId,
  useChatStore,
  type ChatMessage,
  type ChatThread,
} from '@/state/chat-store';
import { EMPTY_PROMPT_QUEUE, type QueuedPrompt } from '@/state/composer-store-model';
import { useComposerStore } from '@/state/composer-store';

const SUGGESTIONS = [
  ['Plan my day', 'Help me plan today. Ask what matters, then turn it into a realistic, prioritized plan.'],
  ['Explore an idea', 'I have an idea I want to think through. Help me clarify it and find the strongest next step.'],
  ['Work on a project', 'Help me make meaningful progress on a project. Start by asking for the goal and current state.'],
] as const;

type ChatWorkspaceProps = {
  connection: AgentConnection;
  health?: HealthResponse;
  healthLoading: boolean;
  healthError: boolean;
  onDisconnect: () => void;
};

export function ChatWorkspace({
  connection,
  health,
  healthLoading,
  healthError,
  onDisconnect,
}: ChatWorkspaceProps) {
  const colors = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const scrollRef = useRef<ScrollView>(null);
  const hydrated = useChatStore((state) => state.hydrated);
  const threads = useChatStore((state) => state.threads);
  const activeThreadId = useChatStore((state) => state.activeThreadId);
  const createThread = useChatStore((state) => state.createThread);
  const selectThread = useChatStore((state) => state.selectThread);
  const deleteThread = useChatStore((state) => state.deleteThread);
  const addMessage = useChatStore((state) => state.addMessage);
  const completeResponse = useChatStore((state) => state.completeResponse);
  const updateThreadRuntime = useChatStore((state) => state.updateThreadRuntime);
  const setThreadModelOverride = useChatStore((state) => state.setThreadModelOverride);
  const importThread = useChatStore((state) => state.importThread);
  const [showThreads, setShowThreads] = useState(false);
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [sendError, setSendError] = useState('');
  const [importingId, setImportingId] = useState<string | null>(null);
  const [sendStartedAt, setSendStartedAt] = useState<number | null>(null);
  const [elapsedLabel, setElapsedLabel] = useState('');
  const connectionKey = `${connection.transport}:${connection.url}:${connection.agentId ?? connection.id}`;
  const connectionThreads = useMemo(
    () => threads.filter((thread) => thread.connectionKey === connectionKey),
    [connectionKey, threads],
  );

  const sessions = useQuery({
    queryKey: ['hermes-sessions', connection.url, connection.agentId ?? connection.id],
    queryFn: () => listHermesSessions(connection, 200),
    refetchInterval: 15000,
  });

  const modelOptions = useQuery({
    queryKey: ['hermes-model-options', connection.url, connection.agentId ?? connection.id],
    queryFn: () => listHermesModelOptions(connection),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  useEffect(() => {
    const activeBelongsToConnection = connectionThreads.some((thread) => thread.id === activeThreadId);
    if (hydrated && !activeBelongsToConnection) createThread(connectionKey);
  }, [activeThreadId, connectionKey, connectionThreads, createThread, hydrated]);

  const activeThread = connectionThreads.find((thread) => thread.id === activeThreadId) ?? null;
  const composerKey = activeThread?.id ?? '';
  const composerHydrated = useComposerStore((state) => state.hydrated);
  const prompt = useComposerStore((state) => state.drafts[composerKey] ?? '');
  const queue = useComposerStore((state) => state.queues[composerKey] ?? EMPTY_PROMPT_QUEUE);
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
  const sortedThreads = useMemo(
    () => [...connectionThreads].sort((a, b) => b.updatedAt - a.updatedAt),
    [connectionThreads],
  );
  const filteredThreads = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sortedThreads;
    return sortedThreads.filter(
      (thread) =>
        thread.title.toLowerCase().includes(query) ||
        thread.messages.some((message) => message.content.toLowerCase().includes(query)),
    );
  }, [search, sortedThreads]);
  const localRemoteIds = useMemo(
    () => new Set(connectionThreads.map((thread) => thread.importedSessionId).filter(Boolean)),
    [connectionThreads],
  );
  const remoteSessions = (sessions.data?.sessions ?? []).filter(
    (session) => !localRemoteIds.has(session.id),
  );

  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [activeThread?.messages.length, sending, streamingText]);

  // Live elapsed duration while a prompt is in flight. The label starts in
  // deliverPrompt and resets there too; this effect only ticks it forward.
  useEffect(() => {
    if (!sending || !sendStartedAt) return;
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - sendStartedAt) / 1000));
      setElapsedLabel(seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [sending, sendStartedAt]);

  // Poll live usage/context for the active runtime session: frequently while
  // sending, then at a modest idle interval. Each RPC is caught separately so
  // one failing never blocks or erases the other's successful result; failures
  // simply leave the panel showing Unavailable and never break the chat.
  const pollThreadId = activeThread?.id;
  const runtimeSessionId = activeThread?.runtimeSessionId ?? null;
  useEffect(() => {
    if (!pollThreadId || !runtimeSessionId) return;
    let cancelled = false;
    const refresh = async () => {
      const patch: { usage?: NormalizedRuntimeUsage; contextBreakdown?: NormalizedContextBreakdown } = {};
      try {
        patch.usage = await getSessionUsage(connection, runtimeSessionId);
      } catch {
        // Usage RPC unavailable this round; keep prior data untouched.
      }
      try {
        patch.contextBreakdown = await getSessionContextBreakdown(connection, runtimeSessionId);
      } catch {
        // Context RPC unavailable this round; keep prior data untouched.
      }
      if (!cancelled && (patch.usage !== undefined || 'contextBreakdown' in patch)) {
        updateThreadRuntime(pollThreadId, patch);
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), sending ? 2000 : 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [connection, pollThreadId, runtimeSessionId, sending, updateThreadRuntime]);

  // Tool incompatibility uses the effective selection: the thread override if
  // present, otherwise the model.options root profile default. Explicit
  // tools/toolcall=false blocks agent turns before send; unknown allows.
  const effectiveSelection = useMemo(() => {
    const override = activeThread?.modelOverride;
    return {
      provider: override?.provider ?? modelOptions.data?.provider ?? null,
      model: override?.model ?? modelOptions.data?.model ?? null,
    };
  }, [activeThread?.modelOverride, modelOptions.data]);
  const toolBlockers = useMemo(() => {
    if (!effectiveSelection.provider || !effectiveSelection.model) return [];
    const caps = selectedCapabilities(
      modelOptions.data ?? { model: null, provider: null, providers: [] },
      effectiveSelection.provider,
      effectiveSelection.model,
    );
    return modelIncompatibilities(caps, { vision: false, tools: true });
  }, [effectiveSelection, modelOptions.data]);
  const sendBlocked = toolBlockers.includes('tools');

  function openThread(id: string) {
    selectThread(id);
    setShowThreads(false);
    setSendError('');
  }

  function startNewThread(initialPrompt?: string) {
    const threadId = createThread(connectionKey);
    setDraft(threadId, initialPrompt ?? '');
    setShowThreads(false);
    setSendError('');
  }

  async function openRemoteSession(session: HermesSession) {
    setImportingId(session.id);
    try {
      const result = await getHermesSessionMessages(connection, session.id);
      const messages: ChatMessage[] = (result.messages ?? [])
        .filter((message) => Boolean(message.content?.trim()))
        .map((message, index) => ({
          id: createChatId(`history_${index}`),
          role: message.role === 'user' ? 'user' : 'assistant',
          content: message.tool_name
            ? `${message.tool_name}\n${message.content.trim()}`
            : message.content.trim(),
          createdAt: normalizeTimestamp(message.timestamp),
        }));
      const title = session.title?.trim() ||
        messages.find((message) => message.role === 'user')?.content ||
        'Brio conversation';
      const id = importThread(connectionKey, session.id, title, messages);
      openThread(id);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Could not open this conversation');
    } finally {
      setImportingId(null);
    }
  }

  const deliverPrompt = useCallback(async (queuedPrompt: QueuedPrompt, thread: ChatThread) => {
    const content = queuedPrompt.text.trim();
    const threadId = thread.id;
    const history = thread.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    // The override and session identity are frozen from the snapshot this
    // prompt was claimed with; a mid-flight override change must not leak in.
    const snapshotOverride = thread.modelOverride;
    const runtimeOverrides = {
      provider: snapshotOverride?.provider,
      model: snapshotOverride?.model,
      modelOptions: buildRuntimeModelOptions(snapshotOverride),
      sessionId: thread.runtimeSessionId ?? thread.id,
    };
    setSendError('');
    setSending(true);
    setStreamingText('');
    setSendStartedAt(Date.now());
    setElapsedLabel('0s');

    const onTextDelta = (delta: string) => {
      setStreamingText((current) => current + delta);
    };

    try {
      let response;
      try {
        response = await sendResponseStream(connection, content, {
          conversation: threadId,
          previousResponseId: thread.lastResponseId,
          conversationHistory:
            thread.needsHistorySeed || (!thread.lastResponseId && history.length)
              ? history
              : undefined,
          ...runtimeOverrides,
          onTextDelta,
        });
      } catch (error) {
        if (!thread.lastResponseId) throw error;
        setStreamingText('');
        response = await sendResponseStream(connection, content, {
          conversation: threadId,
          conversationHistory: history,
          ...runtimeOverrides,
          onTextDelta,
        });
      }
      addMessage(threadId, {
        id: createChatId('message'),
        role: 'user',
        content,
        createdAt: queuedPrompt.createdAt,
      });
      completeResponse(
        threadId,
        {
          id: createChatId('message'),
          role: 'assistant',
          content: hermesResponseText(response),
          createdAt: Date.now(),
        },
        response.id,
        {
          ...(response.usage ? { usage: normalizeLiveUsage(response.usage) } : {}),
          runtimeSessionId: response.session_id?.trim() || undefined,
        },
      );
      await acknowledgePrompt(threadId, queuedPrompt.id);
      void sessions.refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Brio could not complete the request';
      setSendError(message);
      await failPrompt(threadId, queuedPrompt.id, message);
    } finally {
      setSending(false);
      setStreamingText('');
      setSendStartedAt(null);
      setElapsedLabel('');
    }
  }, [acknowledgePrompt, addMessage, completeResponse, connection, failPrompt, sessions]);

  useEffect(() => {
    if (!composerHydrated || !activeThread || sending || queuePaused || sendBlocked) return;
    void claimNext(composerKey).then((nextPrompt) => {
      if (nextPrompt) void deliverPrompt(nextPrompt, activeThread);
    });
  }, [activeThread, claimNext, composerHydrated, composerKey, deliverPrompt, queue, queuePaused, sendBlocked, sending]);

  async function submitPrompt(value = prompt) {
    const content = value.trim();
    if (!content || !composerHydrated || !activeThread || sendBlocked) return;
    await enqueueDraft(activeThread.id, content);
  }

  function editQueuedPrompt(queuedPrompt: QueuedPrompt) {
    if (!activeThread || prompt.trim()) return;
    setDraft(activeThread.id, queuedPrompt.text);
    void removePrompt(activeThread.id, queuedPrompt.id);
  }

  if (!hydrated || !activeThread) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accent} />
        <ThemedText themeColor="textSecondary">Loading conversations…</ThemedText>
      </View>
    );
  }

  const showThreadPanel = wide || showThreads;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.workspace}>
        {showThreadPanel ? (
          <ThreadPanel
            activeThreadId={activeThread.id}
            filteredThreads={filteredThreads}
            importingId={importingId}
            onClose={() => setShowThreads(false)}
            onDelete={deleteThread}
            onNew={() => startNewThread()}
            onOpen={openThread}
            onOpenRemote={(session) => void openRemoteSession(session)}
            remoteSessions={remoteSessions}
            search={search}
            setSearch={setSearch}
            showClose={!wide}
          />
        ) : null}

        {wide || !showThreads ? (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 24 : 0}
            style={styles.chatColumn}>
            <ChatHeader
              connection={connection}
              health={health}
              healthError={healthError}
              healthLoading={healthLoading}
              onDisconnect={onDisconnect}
              onNew={() => startNewThread()}
              onOpenThreads={() => setShowThreads(true)}
              compact={!wide}
              showThreadsButton={!wide}
              thread={activeThread}
            />

            <ScrollView
              contentContainerStyle={[
                styles.messageContent,
                !wide && styles.messageContentMobile,
                activeThread.messages.length === 0 && styles.messageContentEmpty,
              ]}
              keyboardShouldPersistTaps="handled"
              ref={scrollRef}
              style={styles.messages}>
              {activeThread.messages.length === 0 ? (
                <EmptyConversation
                  compact={!wide}
                  connection={connection}
                  onSuggestion={(value) => setDraft(composerKey, value)}
                />
              ) : (
                activeThread.messages.map((message) => <MessageBubble key={message.id} message={message} />)
              )}
              {sending && streamingText ? (
                <MessageBubble
                  message={{
                    id: 'streaming-response',
                    role: 'assistant',
                    content: streamingText,
                    createdAt: 0,
                  }}
                />
              ) : sending ? <ThinkingBubble elapsedLabel={elapsedLabel} /> : null}
            </ScrollView>

            <View style={[styles.composerArea, !wide && styles.composerAreaMobile]}>
              {queue.length > 0 ? (
                <PromptQueue
                  activePromptId={sending ? queue.find((item) => item.state === 'sending')?.id : undefined}
                  draftOccupied={Boolean(prompt.trim())}
                  onEdit={editQueuedPrompt}
                  onMove={(promptId, offset) => void movePrompt(composerKey, promptId, offset)}
                  onPause={() => void setQueuePaused(composerKey, !queuePaused)}
                  onRemove={(promptId) => void removePrompt(composerKey, promptId)}
                  onRetry={(promptId) => void retryPrompt(composerKey, promptId)}
                  paused={queuePaused}
                  prompts={queue}
                />
              ) : null}
              {sendError ? (
                <View style={[styles.errorBanner, { backgroundColor: colors.backgroundSelected }]}>
                  <ThemedText style={{ color: colors.danger }} type="small">
                    {sendError}
                  </ThemedText>
                </View>
              ) : null}
              <SessionModelControls
                onOverrideChange={(override) => setThreadModelOverride(activeThread.id, override)}
                options={modelOptions.data}
                optionsError={Boolean(modelOptions.error)}
                optionsLoading={modelOptions.isLoading}
                sessions={sessions.data?.sessions}
                thread={activeThread}
              />
              {sendBlocked ? (
                <View style={[styles.errorBanner, { backgroundColor: colors.backgroundSelected }]}>
                  <ThemedText style={{ color: colors.warning }} type="small">
                    {effectiveSelection.provider}/{effectiveSelection.model} does not support tool
                    calling, which Brio agent turns require. Pick another model to send messages.
                  </ThemedText>
                </View>
              ) : null}
              <View style={[styles.composer, { backgroundColor: colors.panelStrong, borderColor: colors.border }]}>
                <TextInput
                  accessibilityLabel="Message Brio"
                  maxLength={20000}
                  multiline
                  onChangeText={(value) => setDraft(composerKey, value)}
                  placeholder={sending ? 'Queue a follow-up…' : 'Message Brio…'}
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.composerInput, { color: colors.text }]}
                  textAlignVertical="top"
                  value={prompt}
                />
                <Pressable
                  accessibilityLabel="Send message"
                  disabled={!composerHydrated || !prompt.trim() || sendBlocked}
                  onPress={() => void submitPrompt()}
                  style={({ pressed }) => [
                    styles.sendButton,
                    {
                      backgroundColor:
                        prompt.trim() && composerHydrated && !sendBlocked
                          ? colors.accent
                          : colors.backgroundSelected,
                      opacity: pressed ? 0.72 : 1,
                    },
                  ]}>
                  <ThemedText
                    style={{
                      color:
                        prompt.trim() && composerHydrated && !sendBlocked
                          ? colors.accentText
                          : colors.textDisabled,
                      fontSize: 20,
                    }}>
                    ↑
                  </ThemedText>
                </Pressable>
              </View>
              {wide ? (
                <ThemedText style={styles.composerHint} themeColor="textTertiary" type="small">
                  Brio can make mistakes. Review important work.
                </ThemedText>
              ) : null}
            </View>
          </KeyboardAvoidingView>
        ) : null}
      </View>
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
  const colors = useTheme();
  return (
    <View style={[styles.queueShell, { backgroundColor: colors.panel, borderColor: colors.border }]}>
      <View style={styles.queueHeader}>
        <ThemedText type="smallBold">
          {prompts.length} queued {prompts.length === 1 ? 'prompt' : 'prompts'}
        </ThemedText>
        <Pressable accessibilityRole="button" onPress={onPause}>
          <ThemedText style={{ color: colors.accent }} type="smallBold">
            {paused ? 'Resume' : 'Pause'}
          </ThemedText>
        </Pressable>
      </View>
      <ScrollView nestedScrollEnabled style={styles.queueList}>
        {prompts.map((queuedPrompt, index) => {
          const sending = activePromptId === queuedPrompt.id;
          const uncertain = queuedPrompt.state === 'sending' && !sending;
          const canEdit = queuedPrompt.state !== 'sending' && !draftOccupied;
          const status = sending
            ? 'Sending…'
            : uncertain
              ? 'Delivery unconfirmed — check the conversation before retrying.'
              : queuedPrompt.state === 'failed'
                ? `Not confirmed${queuedPrompt.error ? `: ${queuedPrompt.error}` : ''}`
                : paused
                  ? 'Paused'
                  : `Queued ${index + 1}`;
          return (
            <View key={queuedPrompt.id} style={[styles.queueItem, { borderColor: colors.border }]}>
              <View style={styles.queueCopy}>
                <ThemedText numberOfLines={2} type="smallBold">{queuedPrompt.text}</ThemedText>
                <ThemedText numberOfLines={2} themeColor="textTertiary" type="small">{status}</ThemedText>
              </View>
              {!sending ? (
                <View style={styles.queueActions}>
                  {queuedPrompt.state !== 'pending' ? (
                    <QueueAction label="Retry" onPress={() => onRetry(queuedPrompt.id)} />
                  ) : (
                    <>
                      <QueueAction
                        disabled={index === 0}
                        label="↑"
                        onPress={() => onMove(queuedPrompt.id, -1)}
                      />
                      <QueueAction
                        disabled={index === prompts.length - 1}
                        label="↓"
                        onPress={() => onMove(queuedPrompt.id, 1)}
                      />
                    </>
                  )}
                  {queuedPrompt.state !== 'sending' ? (
                    <QueueAction
                      disabled={!canEdit}
                      label="Edit"
                      onPress={() => onEdit(queuedPrompt)}
                    />
                  ) : null}
                  <QueueAction label="Delete" onPress={() => onRemove(queuedPrompt.id)} tone="danger" />
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
  const colors = useTheme();
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}>
      <ThemedText
        style={{
          color: tone === 'danger' ? colors.danger : colors.accent,
          opacity: disabled ? 0.3 : 1,
        }}
        type="smallBold">
        {label}
      </ThemedText>
    </Pressable>
  );
}

function ThreadPanel({
  activeThreadId,
  filteredThreads,
  importingId,
  onClose,
  onDelete,
  onNew,
  onOpen,
  onOpenRemote,
  remoteSessions,
  search,
  setSearch,
  showClose,
}: {
  activeThreadId: string;
  filteredThreads: ChatThread[];
  importingId: string | null;
  onClose: () => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onOpenRemote: (session: HermesSession) => void;
  remoteSessions: HermesSession[];
  search: string;
  setSearch: (value: string) => void;
  showClose: boolean;
}) {
  const colors = useTheme();
  return (
    <View
      style={[
        styles.threadPanel,
        showClose && styles.threadPanelMobile,
        { backgroundColor: colors.panel, borderColor: colors.border },
      ]}>
      <View style={styles.threadTopRow}>
        <View style={styles.threadBrand}>
          <View style={[styles.brandMark, { backgroundColor: colors.accent }]}>
            <ThemedText style={{ color: colors.accentText }} type="smallBold">B</ThemedText>
          </View>
          <ThemedText type="smallBold">Conversations</ThemedText>
        </View>
        {showClose ? <IconButton label="Close conversations" onPress={onClose} symbol="×" /> : null}
      </View>
      <Pressable
        onPress={onNew}
        style={({ pressed }) => [
          styles.newChatButton,
          { backgroundColor: colors.accent, opacity: pressed ? 0.8 : 1 },
        ]}>
        <ThemedText style={{ color: colors.accentText, fontSize: 18 }}>＋</ThemedText>
        <ThemedText style={{ color: colors.accentText }} type="smallBold">New conversation</ThemedText>
      </Pressable>
      <View style={[styles.searchBox, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>
        <ThemedText themeColor="textTertiary">⌕</ThemedText>
        <TextInput
          accessibilityLabel="Search conversations"
          onChangeText={setSearch}
          placeholder="Search"
          placeholderTextColor={colors.textTertiary}
          style={[styles.searchInput, { color: colors.text }]}
          value={search}
        />
      </View>
      <ScrollView contentContainerStyle={styles.threadList}>
        <ThemedText style={styles.groupLabel} themeColor="textTertiary" type="eyebrow">
          Your threads
        </ThemedText>
        {filteredThreads.map((thread) => {
          const active = thread.id === activeThreadId;
          return (
            <View key={thread.id} style={styles.threadRowWrap}>
              <Pressable
                onPress={() => onOpen(thread.id)}
                style={({ pressed }) => [
                  styles.threadRow,
                  {
                    backgroundColor: active ? colors.backgroundSelected : 'transparent',
                    borderColor: active ? colors.border : 'transparent',
                    opacity: pressed ? 0.72 : 1,
                  },
                ]}>
                <View style={styles.threadCopy}>
                  <ThemedText numberOfLines={1} type="smallBold">{thread.title}</ThemedText>
                  <ThemedText numberOfLines={1} themeColor="textTertiary" type="small">
                    {thread.messages.at(-1)?.content || 'No messages yet'}
                  </ThemedText>
                </View>
                <ThemedText themeColor="textTertiary" type="small">{relativeDate(thread.updatedAt)}</ThemedText>
              </Pressable>
              {filteredThreads.length > 1 ? (
                <Pressable
                  accessibilityLabel={`Delete ${thread.title}`}
                  onPress={() => onDelete(thread.id)}
                  style={styles.deleteThread}>
                  <ThemedText themeColor="textTertiary">×</ThemedText>
                </Pressable>
              ) : null}
            </View>
          );
        })}
        {filteredThreads.length === 0 ? (
          <ThemedText style={styles.emptyThreads} themeColor="textTertiary" type="small">
            No matching conversations.
          </ThemedText>
        ) : null}
        {remoteSessions.length ? (
          <>
            <ThemedText style={styles.remoteLabel} themeColor="textTertiary" type="eyebrow">
              From your agent
            </ThemedText>
            {remoteSessions.slice(0, 20).map((session) => (
              <Pressable
                key={session.id}
                onPress={() => onOpenRemote(session)}
                style={({ pressed }) => [styles.remoteRow, { opacity: pressed ? 0.72 : 1 }]}>
                <View style={styles.threadCopy}>
                  <ThemedText numberOfLines={1} type="smallBold">
                    {session.title || 'Brio conversation'}
                  </ThemedText>
                  <ThemedText themeColor="textTertiary" type="small">
                    {session.message_count} messages · {relativeDate(normalizeTimestamp(session.started_at))}
                  </ThemedText>
                </View>
                {importingId === session.id ? <ActivityIndicator size="small" /> : <ThemedText>›</ThemedText>}
              </Pressable>
            ))}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ChatHeader({
  connection,
  health,
  healthError,
  healthLoading,
  onDisconnect,
  onNew,
  onOpenThreads,
  compact,
  showThreadsButton,
  thread,
}: {
  connection: AgentConnection;
  health?: HealthResponse;
  healthError: boolean;
  healthLoading: boolean;
  onDisconnect: () => void;
  onNew: () => void;
  onOpenThreads: () => void;
  compact: boolean;
  showThreadsButton: boolean;
  thread: ChatThread;
}) {
  const colors = useTheme();
  const online = !healthError && isAgentHealthy(health);
  return (
    <View style={[styles.chatHeader, compact && styles.chatHeaderMobile, { borderColor: colors.border }]}>
      <View style={styles.headerLeft}>
        {showThreadsButton ? <IconButton label="Open conversations" onPress={onOpenThreads} symbol="☰" /> : null}
        <View style={styles.headerCopy}>
          <ThemedText numberOfLines={1} type="smallBold">{thread.title}</ThemedText>
          <View style={styles.agentLine}>
            <View
              style={[
                styles.onlineDot,
                { backgroundColor: online ? colors.success : healthLoading ? colors.warning : colors.danger },
              ]}
            />
            <ThemedText themeColor="textTertiary" type="small">
              {connection.name} · {online ? 'online' : healthLoading ? 'checking' : 'unavailable'}
            </ThemedText>
          </View>
        </View>
      </View>
      <View style={styles.headerActions}>
        <IconButton label="New conversation" onPress={onNew} symbol="＋" />
        {compact ? (
          <IconButton label="Manage agents" onPress={onDisconnect} symbol="···" />
        ) : (
          <Pressable onPress={onDisconnect} style={styles.disconnectButton}>
            <ThemedText themeColor="textSecondary" type="small">Agents</ThemedText>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function EmptyConversation({
  compact,
  connection,
  onSuggestion,
}: {
  compact: boolean;
  connection: AgentConnection;
  onSuggestion: (prompt: string) => void;
}) {
  const colors = useTheme();
  return (
    <View style={[styles.emptyConversation, compact && styles.emptyConversationMobile]}>
      <View style={[styles.heroMark, { backgroundColor: colors.backgroundSelected, borderColor: colors.border }]}>
        <ThemedText style={styles.heroMarkText}>H</ThemedText>
      </View>
      <ThemedText style={styles.welcomeTitle} type="subtitle">What can I help with?</ThemedText>
      <ThemedText style={styles.welcomeCopy} themeColor="textSecondary">
        Brio is connected to {connection.name}. Start with a question, a task, or something you want to think through.
      </ThemedText>
      <View style={styles.suggestions}>
        {SUGGESTIONS.map(([label, suggestion]) => (
          <Pressable
            key={label}
            onPress={() => onSuggestion(suggestion)}
            style={({ pressed }) => [
              styles.suggestion,
              { backgroundColor: colors.panel, borderColor: colors.border, opacity: pressed ? 0.72 : 1 },
            ]}>
            <ThemedText type="smallBold">{label}</ThemedText>
            <ThemedText themeColor="textTertiary">↗</ThemedText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const colors = useTheme();
  const user = message.role === 'user';
  const [copied, setCopied] = useState(false);
  return (
    <View style={[styles.messageRow, user && styles.messageRowUser]}>
      {!user ? (
        <View style={[styles.avatar, { backgroundColor: colors.accent }]}>
          <ThemedText style={{ color: colors.accentText }} type="smallBold">B</ThemedText>
        </View>
      ) : null}
      <View style={[styles.messageBlock, user && styles.messageBlockUser]}>
        <View
          style={[
            styles.messageBubble,
            user && styles.userBubble,
            {
              backgroundColor: user ? colors.backgroundSelected : 'transparent',
              borderColor: user ? colors.border : 'transparent',
            },
          ]}>
          <ThemedText selectable style={styles.messageText}>{message.content}</ThemedText>
        </View>
        {!user ? (
          <Pressable
            accessibilityLabel="Copy response"
            onPress={() => {
              void Clipboard.setStringAsync(message.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
            style={styles.copyButton}>
            <ThemedText themeColor="textTertiary" type="small">{copied ? 'Copied' : 'Copy'}</ThemedText>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function ThinkingBubble({ elapsedLabel }: { elapsedLabel?: string }) {
  const colors = useTheme();
  return (
    <View style={styles.messageRow}>
      <View style={[styles.avatar, { backgroundColor: colors.accent }]}>
        <ThemedText style={{ color: colors.accentText }} type="smallBold">B</ThemedText>
      </View>
      <View style={styles.thinkingRow}>
        <ActivityIndicator color={colors.textSecondary} size="small" />
        <ThemedText themeColor="textSecondary" type="small">
          Brio is working…{elapsedLabel ? ` · ${elapsedLabel}` : ''}
        </ThemedText>
      </View>
    </View>
  );
}

function IconButton({ label, onPress, symbol }: { label: string; onPress: () => void; symbol: string }) {
  const colors = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        { borderColor: colors.border, backgroundColor: colors.backgroundElement, opacity: pressed ? 0.7 : 1 },
      ]}>
      <ThemedText style={styles.iconSymbol}>{symbol}</ThemedText>
    </Pressable>
  );
}

function normalizeTimestamp(value: number) {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function relativeDate(timestamp: number) {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  workspace: { flex: 1, flexDirection: 'row', minHeight: 0 },
  loading: { alignItems: 'center', flex: 1, gap: Spacing.two, justifyContent: 'center' },
  threadPanel: { borderRightWidth: StyleSheet.hairlineWidth, padding: Spacing.three, width: 304 },
  threadPanelMobile: { borderRightWidth: 0, flex: 1, width: '100%' },
  threadTopRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: Spacing.three },
  threadBrand: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two },
  brandMark: { alignItems: 'center', borderRadius: 10, height: 30, justifyContent: 'center', width: 30 },
  newChatButton: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: Spacing.two, justifyContent: 'center', minHeight: 46, paddingHorizontal: Spacing.three },
  searchBox: { alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.three, paddingHorizontal: Spacing.three },
  searchInput: { flex: 1, fontSize: 14, minHeight: 42, outlineStyle: 'none' } as never,
  threadList: { paddingBottom: Spacing.four, paddingTop: Spacing.four },
  groupLabel: { marginBottom: Spacing.two, paddingHorizontal: Spacing.two },
  threadRowWrap: { position: 'relative' },
  threadRow: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: Spacing.two, minHeight: 64, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  threadCopy: { flex: 1, gap: 2, minWidth: 0 },
  deleteThread: { alignItems: 'center', height: 28, justifyContent: 'center', position: 'absolute', right: 3, top: 30, width: 28 },
  emptyThreads: { paddingHorizontal: Spacing.two, paddingVertical: Spacing.three },
  remoteLabel: { marginBottom: Spacing.two, marginTop: Spacing.four, paddingHorizontal: Spacing.two },
  remoteRow: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two, minHeight: 56, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  chatColumn: { flex: 1, minWidth: 0 },
  chatHeader: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 72, paddingHorizontal: Spacing.four, paddingVertical: Spacing.two },
  chatHeaderMobile: { minHeight: 62, paddingHorizontal: Spacing.three },
  headerLeft: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: Spacing.three, minWidth: 0 },
  headerCopy: { flex: 1, minWidth: 0 },
  agentLine: { alignItems: 'center', flexDirection: 'row', gap: Spacing.one },
  onlineDot: { borderRadius: 4, height: 7, width: 7 },
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two },
  disconnectButton: { paddingHorizontal: Spacing.two, paddingVertical: Spacing.two },
  iconButton: { alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, height: 38, justifyContent: 'center', width: 38 },
  iconSymbol: { fontSize: 19, lineHeight: 22 },
  messages: { flex: 1 },
  messageContent: { alignSelf: 'center', maxWidth: 820, paddingBottom: Spacing.four, paddingHorizontal: Spacing.four, paddingTop: Spacing.four, width: '100%' },
  messageContentMobile: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three },
  messageContentEmpty: { flexGrow: 1, justifyContent: 'center' },
  emptyConversation: { alignItems: 'center', alignSelf: 'center', maxWidth: 620, paddingVertical: Spacing.five, width: '100%' },
  emptyConversationMobile: { paddingVertical: Spacing.three },
  heroMark: { alignItems: 'center', borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, height: 68, justifyContent: 'center', marginBottom: Spacing.four, width: 68 },
  heroMarkText: { fontSize: 27, fontWeight: '700' },
  welcomeTitle: { textAlign: 'center' },
  welcomeCopy: { marginTop: Spacing.two, maxWidth: 540, textAlign: 'center' },
  suggestions: { gap: Spacing.two, marginTop: Spacing.five, width: '100%' },
  suggestion: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', minHeight: 50, paddingHorizontal: Spacing.three },
  messageRow: { alignItems: 'flex-start', flexDirection: 'row', gap: Spacing.three, marginBottom: Spacing.four },
  messageRowUser: { justifyContent: 'flex-end' },
  avatar: { alignItems: 'center', borderRadius: 12, height: 32, justifyContent: 'center', marginTop: 2, width: 32 },
  messageBlock: { flex: 1, maxWidth: 720 },
  messageBlockUser: { flex: 0, maxWidth: '82%' },
  messageBubble: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  userBubble: { borderBottomRightRadius: 5, paddingHorizontal: Spacing.three, paddingVertical: 12 },
  messageText: { fontSize: 16, lineHeight: 25 },
  copyButton: { alignSelf: 'flex-start', marginTop: Spacing.one, paddingVertical: Spacing.one },
  thinkingRow: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two, minHeight: 34 },
  composerArea: { alignSelf: 'center', maxWidth: 860, paddingBottom: Spacing.two, paddingHorizontal: Spacing.four, width: '100%' },
  composerAreaMobile: { paddingBottom: Spacing.two, paddingHorizontal: Spacing.three },
  queueShell: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, marginBottom: Spacing.two, overflow: 'hidden' },
  queueHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  queueList: { maxHeight: 220 },
  queueItem: { alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: Spacing.three, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  queueCopy: { flex: 1, gap: 2, minWidth: 0 },
  queueActions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, justifyContent: 'flex-end' },
  errorBanner: { borderRadius: 10, marginBottom: Spacing.two, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  composer: { alignItems: 'flex-end', borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: Spacing.two, minHeight: 58, padding: Spacing.two, paddingLeft: Spacing.three },
  composerInput: { flex: 1, fontSize: 16, lineHeight: 23, maxHeight: 150, minHeight: 40, outlineStyle: 'none', paddingBottom: 8, paddingTop: 8 } as never,
  sendButton: { alignItems: 'center', borderRadius: 13, height: 42, justifyContent: 'center', width: 42 },
  composerHint: { marginTop: Spacing.one, textAlign: 'center' },
});
