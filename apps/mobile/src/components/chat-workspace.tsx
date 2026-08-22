import * as Clipboard from 'expo-clipboard';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  getHermesSessionMessages,
  hermesResponseText,
  isAgentHealthy,
  listHermesSessions,
  sendResponseStream,
  type AgentConnection,
  type HealthResponse,
  type HermesSession,
} from '@/lib/brio';
import { createChatId, useChatStore, type ChatMessage, type ChatThread } from '@/state/chat-store';

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
  const importThread = useChatStore((state) => state.importThread);
  const [showThreads, setShowThreads] = useState(false);
  const [search, setSearch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [sendError, setSendError] = useState('');
  const [importingId, setImportingId] = useState<string | null>(null);
  const connectionKey = `${connection.transport}:${connection.url}:${connection.agentId ?? connection.id}`;
  const connectionThreads = useMemo(
    () => threads.filter((thread) => thread.connectionKey === connectionKey),
    [connectionKey, threads],
  );

  const sessions = useQuery({
    queryKey: ['hermes-sessions', connection.url, connection.agentId ?? connection.id],
    queryFn: () => listHermesSessions(connection),
    refetchInterval: 15000,
  });

  useEffect(() => {
    const activeBelongsToConnection = connectionThreads.some((thread) => thread.id === activeThreadId);
    if (hydrated && !activeBelongsToConnection) createThread(connectionKey);
  }, [activeThreadId, connectionKey, connectionThreads, createThread, hydrated]);

  const activeThread = connectionThreads.find((thread) => thread.id === activeThreadId) ?? null;
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

  function openThread(id: string) {
    selectThread(id);
    setShowThreads(false);
    setSendError('');
  }

  function startNewThread(initialPrompt?: string) {
    createThread(connectionKey);
    setPrompt(initialPrompt ?? '');
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

  async function submitPrompt(value = prompt) {
    const content = value.trim();
    if (!content || sending || !activeThread) return;

    const threadId = activeThread.id;
    const history = activeThread.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    addMessage(threadId, {
      id: createChatId('message'),
      role: 'user',
      content,
      createdAt: Date.now(),
    });
    setPrompt('');
    setSendError('');
    setSending(true);
    setStreamingText('');

    const onTextDelta = (delta: string) => {
      setStreamingText((current) => current + delta);
    };

    try {
      let response;
      try {
        response = await sendResponseStream(connection, content, {
          conversation: threadId,
          previousResponseId: activeThread.lastResponseId,
          conversationHistory:
            activeThread.needsHistorySeed || (!activeThread.lastResponseId && history.length)
              ? history
              : undefined,
          onTextDelta,
        });
      } catch (error) {
        if (!activeThread.lastResponseId) throw error;
        setStreamingText('');
        response = await sendResponseStream(connection, content, {
          conversation: threadId,
          conversationHistory: history,
          onTextDelta,
        });
      }
      completeResponse(
        threadId,
        {
          id: createChatId('message'),
          role: 'assistant',
          content: hermesResponseText(response),
          createdAt: Date.now(),
        },
        response.id,
      );
      void sessions.refetch();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Brio could not complete the request');
    } finally {
      setSending(false);
      setStreamingText('');
    }
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
                <EmptyConversation compact={!wide} connection={connection} onSuggestion={setPrompt} />
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
              ) : sending ? <ThinkingBubble /> : null}
            </ScrollView>

            <View style={[styles.composerArea, !wide && styles.composerAreaMobile]}>
              {sendError ? (
                <View style={[styles.errorBanner, { backgroundColor: colors.backgroundSelected }]}>
                  <ThemedText style={{ color: colors.danger }} type="small">
                    {sendError}
                  </ThemedText>
                </View>
              ) : null}
              <View style={[styles.composer, { backgroundColor: colors.panelStrong, borderColor: colors.border }]}>
                <TextInput
                  accessibilityLabel="Message Brio"
                  editable={!sending}
                  maxLength={20000}
                  multiline
                  onChangeText={setPrompt}
                  placeholder="Message Brio…"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.composerInput, { color: colors.text }]}
                  textAlignVertical="top"
                  value={prompt}
                />
                <Pressable
                  accessibilityLabel="Send message"
                  disabled={sending || !prompt.trim()}
                  onPress={() => void submitPrompt()}
                  style={({ pressed }) => [
                    styles.sendButton,
                    {
                      backgroundColor: prompt.trim() && !sending ? colors.accent : colors.backgroundSelected,
                      opacity: pressed ? 0.72 : 1,
                    },
                  ]}>
                  {sending ? (
                    <ActivityIndicator color={colors.textSecondary} size="small" />
                  ) : (
                    <ThemedText
                      style={{ color: prompt.trim() ? colors.accentText : colors.textDisabled, fontSize: 20 }}>
                      ↑
                    </ThemedText>
                  )}
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

function ThinkingBubble() {
  const colors = useTheme();
  return (
    <View style={styles.messageRow}>
      <View style={[styles.avatar, { backgroundColor: colors.accent }]}>
        <ThemedText style={{ color: colors.accentText }} type="smallBold">B</ThemedText>
      </View>
      <View style={styles.thinkingRow}>
        <ActivityIndicator color={colors.textSecondary} size="small" />
        <ThemedText themeColor="textSecondary" type="small">Brio is working…</ThemedText>
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
  errorBanner: { borderRadius: 10, marginBottom: Spacing.two, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two },
  composer: { alignItems: 'flex-end', borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: Spacing.two, minHeight: 58, padding: Spacing.two, paddingLeft: Spacing.three },
  composerInput: { flex: 1, fontSize: 16, lineHeight: 23, maxHeight: 150, minHeight: 40, outlineStyle: 'none', paddingBottom: 8, paddingTop: 8 } as never,
  sendButton: { alignItems: 'center', borderRadius: 13, height: 42, justifyContent: 'center', width: 42 },
  composerHint: { marginTop: Spacing.one, textAlign: 'center' },
});
