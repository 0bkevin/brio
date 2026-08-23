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
import { ComposerControls } from '@/components/composer-controls';
import { SessionModelControls } from '@/components/session-model-controls';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  getHermesSessionMessages,
  getSessionContextBreakdown,
  getSessionUsage,
  hermesResponseText,
  interruptComposerSession,
  isAgentHealthy,
  listHermesModelOptions,
  listHermesSessions,
  dispatchComposerCommand,
  prepareComposerPrompt,
  deleteAttachmentUpload,
  sendResponseStream,
  type AgentConnection,
  type HealthResponse,
  type HermesSession,
} from '@/lib/brio';
import {
  DEFAULT_PROFILE_NAME,
  environmentId,
  environmentKey,
  isNamedProfile,
  listProfiles,
  profileName,
  resolveBrioDeepLink,
  type HermesProfile,
} from '@/lib/profiles';
import { createChatId, threadMatchesScope, useChatStore, type ChatMessage, type ChatThread } from '@/state/chat-store';
import {
  buildRuntimeModelOptions,
  modelIncompatibilities,
  normalizeLiveUsage,
  selectedCapabilities,
  type NormalizedContextBreakdown,
  type NormalizedRuntimeUsage,
} from '@/lib/session-runtime';
import { EMPTY_PROMPT_QUEUE, type QueuedPrompt } from '@/state/composer-store-model';
import { useComposerStore } from '@/state/composer-store';
import { useDeepLinkStore } from '@/state/deep-link-store';
import { useProfileStore } from '@/state/profile-store';

const SUGGESTIONS = [
  ['Plan my day', 'Help me plan today. Ask what matters, then turn it into a realistic, prioritized plan.'],
  ['Explore an idea', 'I have an idea I want to think through. Help me clarify it and find the strongest next step.'],
  ['Work on a project', 'Help me make meaningful progress on a project. Start by asking for the goal and current state.'],
] as const;

type StreamState = {
  sending: boolean;
  text: string;
  error?: string;
};

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
  const activeRequest = useRef<AbortController | null>(null);
  const redirectOutcomes = useRef(new Map<string, Promise<boolean>>());
  const streamingTextRef = useRef('');
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
  // Streaming state lives per thread so two conversations on different
  // Hermes profiles can stream at the same time without clobbering each
  // other's transcript or error banner.
  const [streams, setStreams] = useState<Record<string, StreamState>>({});
  const connectionBaseKey = environmentKey(connection);
  const agentId = environmentId(connection);

  // Hermes profile selection for this environment. The connector's profile
  // surface decides whether switching is offered at all.
  const storedProfiles = useProfileStore((state) => state.activeProfiles);
  const setActiveProfileStored = useProfileStore((state) => state.setActiveProfile);
  const profilesQuery = useQuery({
    queryKey: ['profiles', connection.url, agentId],
    queryFn: () => listProfiles(connection),
    staleTime: 30_000,
    retry: false,
  });
  const availableProfiles: HermesProfile[] = useMemo(
    () => profilesQuery.data?.profiles ?? [],
    [profilesQuery.data],
  );
  const requestedProfile = storedProfiles[agentId];
  const activeProfile = availableProfiles.some((profile) => profile.name === requestedProfile)
    ? profileName(requestedProfile)
    : DEFAULT_PROFILE_NAME;

  const switchProfile = useCallback(
    (name: string) => {
      if (!availableProfiles.some((profile) => profile.name === name)) return;
      void setActiveProfileStored(agentId, isNamedProfile(name) ? name : undefined);
      setShowThreads(false);
    },
    [agentId, availableProfiles, setActiveProfileStored],
  );

  // Every derived collection below is keyed by (environment, profile): two
  // profiles of this environment never share threads, composer drafts, or
  // cached queries.
  const [sendStartedAt, setSendStartedAt] = useState<number | null>(null);
  const [elapsedLabel, setElapsedLabel] = useState('');
  const connectionThreads = useMemo(
    () =>
      threads.filter((thread) =>
        threadMatchesScope(thread, connectionBaseKey, activeProfile),
      ),
    [activeProfile, connectionBaseKey, threads],
  );

  const sessions = useQuery({
    queryKey: ['hermes-sessions', connection.url, agentId, activeProfile],
    queryFn: () => listHermesSessions(connection, 200, activeProfile),
    refetchInterval: 15000,
  });

  const modelOptions = useQuery({
    queryKey: ['hermes-model-options', connection.url, connection.agentId ?? connection.id],
    queryFn: () => listHermesModelOptions(connection, false, activeProfile),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (!hydrated) return;
    const activeBelongsToScope = connectionThreads.some((thread) => thread.id === activeThreadId);
    if (!activeBelongsToScope && connectionThreads.length > 0) {
      // Returning to a profile resumes its most recent conversation instead
      // of piling up empty threads.
      const latest = [...connectionThreads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      selectThread(latest.id);
      return;
    }
    if (!activeBelongsToScope) createThread(connectionBaseKey, activeProfile);
  }, [activeProfile, activeThreadId, connectionBaseKey, connectionThreads, createThread, hydrated, selectThread]);

  // Deep links: brio://chat?agent=&profile=&session= opens the named session
  // on the named profile of ONLY the matching environment. A link for a
  // different environment is dropped here rather than redirected, so no
  // state ever crosses environments or profiles.
  const pendingDeepLink = useDeepLinkStore((state) => state.pending);
  const consumeDeepLink = useDeepLinkStore((state) => state.consume);
  useEffect(() => {
    if (!pendingDeepLink || !hydrated || !profilesQuery.data) return;
    const resolved = resolveBrioDeepLink(pendingDeepLink, agentId, availableProfiles);
    if (!resolved) {
      consumeDeepLink();
      return;
    }
    const requested = resolved.profile;
    switchProfile(requested);
    const sessionId = resolved.sessionId;
    consumeDeepLink();
    if (!sessionId) return;
    const existing = threads.find(
      (thread) =>
        threadMatchesScope(thread, connectionBaseKey, requested) &&
        thread.importedSessionId === sessionId,
    );
    if (existing) {
      selectThread(existing.id);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await getHermesSessionMessages(connection, sessionId, requested);
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
        if (cancelled) return;
        const title =
          messages.find((message) => message.role === 'user')?.content || 'Shared conversation';
        const id = importThread(connectionBaseKey, sessionId, title, messages, requested);
        selectThread(id);
      } catch {
        // Session may be gone; the profile still switched so context is right.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeProfile,
    agentId,
    availableProfiles,
    connectionBaseKey,
    connection,
    consumeDeepLink,
    hydrated,
    importThread,
    pendingDeepLink,
    profilesQuery.data,
    selectThread,
    switchProfile,
    threads,
  ]);

  const activeThread = connectionThreads.find((thread) => thread.id === activeThreadId) ?? null;
  const composerKey = activeThread?.id ?? '';
  const composerHydrated = useComposerStore((state) => state.hydrated);
  const prompt = useComposerStore((state) => state.drafts[composerKey] ?? '');
  const attachments = useComposerStore((state) => state.attachments[composerKey] ?? []);
  const queue = useComposerStore((state) => state.queues[composerKey] ?? EMPTY_PROMPT_QUEUE);
  const queuePaused = useComposerStore((state) => Boolean(state.paused[composerKey]));
  const promptHistory = useComposerStore((state) => state.promptHistory[composerKey] ?? []);
  const draftRevisions = useComposerStore((state) => state.draftRevisions[composerKey]);
  const composerStorageError = useComposerStore((state) => state.storageError);
  const sessionId = useComposerStore((state) => state.sessionIds[composerKey]) || activeThread?.importedSessionId || composerKey;
  const setDraft = useComposerStore((state) => state.setDraft);
  const ensureSessionId = useComposerStore((state) => state.ensureSessionId);
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
  }, [activeThread?.messages.length, streams]);

  function setStreamState(threadId: string, patch: Partial<StreamState>) {
    setStreams((current) => {
      const base = current[threadId] ?? { sending: false, text: '' };
      return { ...current, [threadId]: { ...base, ...patch } };
    });
  }

  useEffect(() => {
    if (!composerHydrated || !activeThread) return;
    void ensureSessionId(activeThread.id, activeThread.importedSessionId || activeThread.id);
  }, [activeThread, composerHydrated, ensureSessionId]);

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
  const activeThreadProfile = activeThread?.profile;
  useEffect(() => {
    if (!pollThreadId || !runtimeSessionId) return;
    let cancelled = false;
    const refresh = async () => {
      const patch: { usage?: NormalizedRuntimeUsage; contextBreakdown?: NormalizedContextBreakdown } = {};
      try {
        patch.usage = await getSessionUsage(connection, runtimeSessionId, profileName(activeThreadProfile));
      } catch {
        // Usage RPC unavailable this round; keep prior data untouched.
      }
      try {
        patch.contextBreakdown = await getSessionContextBreakdown(connection, runtimeSessionId, profileName(activeThreadProfile));
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
  }, [activeThreadProfile, connection, pollThreadId, runtimeSessionId, sending, updateThreadRuntime]);

  // Capability checks use the effective selection: the thread override if
  // present, otherwise the model.options root profile default. Unknown
  // capabilities permit sending; an explicit false blocks. Tool support is
  // always required for agent turns; vision is only required when the prompt
  // actually carries attachments (each queued prompt uses its own snapshot).
  const effectiveSelection = useMemo(() => {
    const override = activeThread?.modelOverride;
    return {
      provider: override?.provider ?? modelOptions.data?.provider ?? null,
      model: override?.model ?? modelOptions.data?.model ?? null,
    };
  }, [activeThread?.modelOverride, modelOptions.data]);
  const capabilityBlockers = useCallback(
    (attachmentCount: number) => {
      if (!effectiveSelection.provider || !effectiveSelection.model) return [];
      const caps = selectedCapabilities(
        modelOptions.data ?? { model: null, provider: null, providers: [] },
        effectiveSelection.provider,
        effectiveSelection.model,
      );
      return modelIncompatibilities(caps, { vision: attachmentCount > 0, tools: true });
    },
    [effectiveSelection, modelOptions.data],
  );
  const draftBlockers = useMemo(
    () => capabilityBlockers(attachments.length),
    [attachments.length, capabilityBlockers],
  );
  const sendBlocked = draftBlockers.length > 0;

  function openThread(id: string) {
    selectThread(id);
    setShowThreads(false);
  }

  function startNewThread(initialPrompt?: string) {
    const threadId = createThread(connectionBaseKey, activeProfile);
    setDraft(threadId, initialPrompt ?? '');
    setShowThreads(false);
  }

  async function openRemoteSession(session: HermesSession, sourceProfile: string) {
    // A session always belongs to the Hermes profile that served it: the
    // imported thread is pinned to that profile and Brio switches there so
    // memory, credentials, and cwd stay with their own agent.
    setImportingId(session.id);
    try {
      const result = await getHermesSessionMessages(connection, session.id, sourceProfile);
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
      const id = importThread(connectionBaseKey, session.id, title, messages, sourceProfile);
      if (profileName(sourceProfile) !== activeProfile) switchProfile(sourceProfile);
      openThread(id);
    } catch (error) {
      setStreams((current) => ({
        ...current,
        [activeThreadId ?? '']: { sending: false, text: '', error: error instanceof Error ? error.message : 'Could not open this conversation' },
      }));
    } finally {
      setImportingId(null);
    }
  }

  const deliverPrompt = useCallback(async (queuedPrompt: QueuedPrompt, thread: ChatThread) => {
    // Compatibility gate runs before any state changes or network activity:
    // a blocked prompt is failed using its own attachment snapshot and never
    // produces a Hermes request.
    const promptBlockers = capabilityBlockers(queuedPrompt.attachments.length);
    if (promptBlockers.length > 0) {
      const message = blockerNotice(
        promptBlockers,
        effectiveSelection.provider,
        effectiveSelection.model,
      );
      setSendError(message);
      await failPrompt(thread.id, queuedPrompt.id, message);
      return;
    }
    const content = queuedPrompt.text.trim();
    const threadId = thread.id;
    const composerSessionId = useComposerStore.getState().sessionIds[threadId] || thread.importedSessionId || threadId;
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
    streamingTextRef.current = '';
    setStreamState(threadId, { sending: true, text: '' });
    const controller = new AbortController();
    activeRequest.current = controller;

    const onTextDelta = (delta: string) => {
      streamingTextRef.current += delta;
      setStreamingText((current) => current + delta);
      setStreamState(threadId, { sending: true, text: streamingTextRef.current });
    };

    try {
      let responseText = '';
      let responseId: string | undefined;
      let responseUsage: unknown;
      let responseSessionId: string | undefined;
      if (content.startsWith('/') && queuedPrompt.attachments.length === 0) {
        const command = await dispatchComposerCommand(connection, composerSessionId, content, queuedPrompt.id);
        responseText = commandResponseText(command);
      } else {
        const attachmentIds = queuedPrompt.attachments.map((attachment) => attachment.id);
        const connectorExpandsComposer = connection.transport === 'relay';
        const requiresDirectPreparation = attachmentIds.length > 0 || hasContextReference(content);
        const responseInput = !connectorExpandsComposer && requiresDirectPreparation
          ? (await prepareComposerPrompt(connection, content, composerSessionId, attachmentIds)).input
          : content;
        let response;
        try {
          response = await sendResponseStream(connection, responseInput, {
            conversation: composerSessionId,
            previousResponseId: thread.lastResponseId,
            conversationHistory:
              thread.needsHistorySeed || (!thread.lastResponseId && history.length)
                ? history
                : undefined,
            ...runtimeOverrides,
            onTextDelta,
            profile: profileName(thread.profile),
            signal: controller.signal,
            composerSessionId: connectorExpandsComposer ? composerSessionId : undefined,
            attachmentIds: connectorExpandsComposer ? attachmentIds : undefined,
          });
        } catch (error) {
          if (!thread.lastResponseId || controller.signal.aborted) throw error;
          streamingTextRef.current = '';
          setStreamingText('');
          response = await sendResponseStream(connection, responseInput, {
            conversation: composerSessionId,
            conversationHistory: history,
            ...runtimeOverrides,
            onTextDelta,
            profile: profileName(thread.profile),
            signal: controller.signal,
            composerSessionId: connectorExpandsComposer ? composerSessionId : undefined,
            attachmentIds: connectorExpandsComposer ? attachmentIds : undefined,
          });
        }
        responseText = hermesResponseText(response);
        responseId = response.id;
        responseUsage = response.usage;
        responseSessionId = response.session_id?.trim() || undefined;
      }
      addMessage(threadId, {
        id: createChatId('message'),
        role: 'user',
        content: displayPrompt(queuedPrompt),
        createdAt: queuedPrompt.createdAt,
      });
      completeResponse(
        threadId,
        {
          id: createChatId('message'),
          role: 'assistant',
          content: responseText,
          createdAt: Date.now(),
        },
        responseId,
        {
          ...(responseUsage ? { usage: normalizeLiveUsage(responseUsage) } : {}),
          runtimeSessionId: responseSessionId,
        },
      );
      await finalizeAccepted(threadId, threadId, queuedPrompt.id);
      await Promise.all(queuedPrompt.attachments.map((attachment) =>
        deleteAttachmentUpload(connection, attachment.id).catch(() => undefined),
      ));
      void sessions.refetch();
    } catch (error) {
      const redirectOutcome = redirectOutcomes.current.get(queuedPrompt.id);
      if (redirectOutcome && await redirectOutcome) {
        redirectOutcomes.current.delete(queuedPrompt.id);
        addMessage(threadId, {
          id: createChatId('message'),
          role: 'user',
          content: displayPrompt(queuedPrompt),
          createdAt: queuedPrompt.createdAt,
        });
        if (streamingTextRef.current.trim()) {
          completeResponse(threadId, {
            id: createChatId('message'),
            role: 'assistant',
            content: `${streamingTextRef.current.trim()}\n\n[Interrupted by redirect]`,
            createdAt: Date.now(),
          });
        }
        await finalizeAccepted(threadId, threadId, queuedPrompt.id);
        await Promise.all(queuedPrompt.attachments.map((attachment) =>
          deleteAttachmentUpload(connection, attachment.id).catch(() => undefined),
        ));
        void sessions.refetch();
        return;
      }
      const message = error instanceof Error ? error.message : 'Brio could not complete the request';
      setStreamState(threadId, { sending: false, text: '', error: message });
      setSendError(message);
      await failPrompt(threadId, queuedPrompt.id, message);
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      setSending(false);
      setStreamingText('');
      setSendStartedAt(null);
      setElapsedLabel('');
      streamingTextRef.current = '';
      setStreams((current) => {
        const state = current[threadId];
        if (state?.error) return { ...current, [threadId]: { ...state, sending: false } };
        const next = { ...current };
        delete next[threadId];
        return next;
      });
    }
  }, [addMessage, capabilityBlockers, completeResponse, connection, effectiveSelection, failPrompt, finalizeAccepted, sessions]);

  useEffect(() => {
    if (!composerHydrated || !activeThread || sending || queuePaused) return;
    // Block before claim: the head of the queue is gated with its own
    // attachment snapshot; deliverPrompt re-checks before any Hermes request.
    const nextPending = queue.find((item) => item.state === 'pending');
    if (nextPending && capabilityBlockers(nextPending.attachments.length).length > 0) return;
    void claimNext(composerKey).then((nextPrompt) => {
      if (nextPrompt) void deliverPrompt(nextPrompt, activeThread);
    });
  }, [activeThread, capabilityBlockers, claimNext, composerHydrated, composerKey, deliverPrompt, queue, queuePaused, sending]);

  async function submitPrompt(deliveryMode: 'queue' | 'redirect' = 'queue') {
    if ((!prompt.trim() && attachments.length === 0) || !composerHydrated || !activeThread) return;
    // Block before enqueue: the draft's own attachments decide the vision gate.
    const blockers = capabilityBlockers(attachments.length);
    if (blockers.length > 0) {
      setSendError(blockerNotice(blockers, effectiveSelection.provider, effectiveSelection.model));
      return;
    }
    const queued = await enqueueDraft(activeThread.id, deliveryMode);
    if (!queued || deliveryMode !== 'redirect' || !sending) return;
    const current = queue.find((item) => item.state === 'sending');
    if (!current) return;
    let settleRedirect: (accepted: boolean) => void = () => undefined;
    const redirectOutcome = new Promise<boolean>((resolve) => { settleRedirect = resolve; });
    redirectOutcomes.current.set(current.id, redirectOutcome);
    try {
      await interruptComposerSession(connection, sessionId);
      settleRedirect(true);
      activeRequest.current?.abort();
    } catch (error) {
      settleRedirect(false);
      redirectOutcomes.current.delete(current.id);
      // The run may have completed naturally while the interrupt was in
      // flight. In that case the redirect remains a normal queued prompt.
      if (!activeRequest.current) return;
      const message = error instanceof Error ? error.message : 'Could not redirect the active run';
      setSendError(message);
      await failPrompt(activeThread.id, queued.id, message);
    }
  }

  function editQueuedPrompt(queuedPrompt: QueuedPrompt) {
    if (!activeThread || prompt.trim() || attachments.length) return;
    void editPrompt(activeThread.id, queuedPrompt.id);
  }

  async function deleteQueuedPrompt(queuedPrompt: QueuedPrompt) {
    if (!activeThread || !(await removePrompt(activeThread.id, queuedPrompt.id))) return;
    await Promise.all(queuedPrompt.attachments.map((attachment) =>
      deleteAttachmentUpload(connection, attachment.id).catch(() => undefined),
    ));
  }

  if (!hydrated || !activeThread) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accent} />
        <ThemedText themeColor="textSecondary">Loading conversations…</ThemedText>
      </View>
    );
  }

  const activeStream = streams[activeThread.id];
  const otherProfiles = availableProfiles.filter((profile) => profile.name !== activeProfile);
  const showThreadPanel = wide || showThreads;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.workspace}>
        {showThreadPanel ? (
          <ThreadPanel
            activeThreadId={activeThread.id}
            activeProfile={activeProfile}
            connection={connection}
            filteredThreads={filteredThreads}
            importingId={importingId}
            onClose={() => setShowThreads(false)}
            onDelete={deleteThread}
            onNew={() => startNewThread()}
            onOpen={openThread}
            onOpenRemote={(session, profile) => void openRemoteSession(session, profile)}
            otherProfiles={otherProfiles}
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
              activeProfile={activeProfile}
              availableProfiles={availableProfiles}
              connection={connection}
              health={health}
              healthError={healthError}
              healthLoading={healthLoading}
              onDisconnect={onDisconnect}
              onNew={() => startNewThread()}
              onOpenThreads={() => setShowThreads(true)}
              onSwitchProfile={switchProfile}
              compact={!wide}
              profilesLoading={profilesQuery.isLoading}
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
              {activeStream?.sending ? (
                activeStream.text ? (
                  <MessageBubble
                    message={{
                      id: 'streaming-response',
                      role: 'assistant',
                      content: activeStream.text,
                      createdAt: 0,
                    }}
                  />
                ) : (
                  <ThinkingBubble />
                )
              ) : null}
              {!activeStream?.sending && sending && streamingText ? (
                <MessageBubble
                  message={{
                    id: 'streaming-response',
                    role: 'assistant',
                    content: streamingText,
                    createdAt: 0,
                  }}
                />
              ) : !activeStream?.sending && sending ? <ThinkingBubble elapsedLabel={elapsedLabel} /> : null}
            </ScrollView>

            <View style={[styles.composerArea, !wide && styles.composerAreaMobile]}>
              {queue.length > 0 ? (
                <PromptQueue
                  activePromptId={sending ? queue.find((item) => item.state === 'sending')?.id : undefined}
                  draftOccupied={Boolean(prompt.trim()) || attachments.length > 0}
                  onEdit={editQueuedPrompt}
                  onMove={(promptId, offset) => void movePrompt(composerKey, promptId, offset)}
                  onPause={() => void setQueuePaused(composerKey, !queuePaused)}
                  onRemove={(queuedPrompt) => void deleteQueuedPrompt(queuedPrompt)}
                  onRetry={(promptId) => void retryPrompt(composerKey, promptId)}
                  paused={queuePaused}
                  prompts={queue}
                />
              ) : null}
              {activeStream?.error ? (
                <View style={[styles.errorBanner, { backgroundColor: colors.backgroundSelected }]}>
                  <ThemedText style={{ color: colors.danger }} type="small">
                    {activeStream.error}
                  </ThemedText>
                </View>
              ) : null}
              {sendError || composerStorageError ? (
                <View style={[styles.errorBanner, { backgroundColor: colors.backgroundSelected }]}>
                  <ThemedText style={{ color: colors.danger }} type="small">
                    {sendError || composerStorageError}
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
                    {blockerNotice(draftBlockers, effectiveSelection.provider, effectiveSelection.model)}
                  </ThemedText>
                </View>
              ) : null}
              <ComposerControls
                active={sending}
                attachments={attachments}
                canRedo={Boolean(draftRevisions?.future.length)}
                canUndo={Boolean(draftRevisions?.past.length)}
                connection={connection}
                draft={prompt}
                history={promptHistory}
                hydrated={composerHydrated}
                onAddAttachment={(attachment) => addAttachment(composerKey, attachment)}
                onDraftChange={(value) => setDraft(composerKey, value)}
                onRedo={() => redoDraft(composerKey)}
                onRemoveAttachment={(attachmentId) => removeAttachment(composerKey, attachmentId)}
                onSend={(mode) => void submitPrompt(mode)}
                onUndo={() => undoDraft(composerKey)}
                sessionId={sessionId}
              />
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
  onRemove: (prompt: QueuedPrompt) => void;
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
                <ThemedText numberOfLines={2} type="smallBold">{displayPrompt(queuedPrompt)}</ThemedText>
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
                  <QueueAction label="Delete" onPress={() => onRemove(queuedPrompt)} tone="danger" />
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
  activeProfile,
  activeThreadId,
  connection,
  filteredThreads,
  importingId,
  onClose,
  onDelete,
  onNew,
  onOpen,
  onOpenRemote,
  otherProfiles,
  remoteSessions,
  search,
  setSearch,
  showClose,
}: {
  activeProfile: string;
  activeThreadId: string;
  connection: AgentConnection;
  filteredThreads: ChatThread[];
  importingId: string | null;
  onClose: () => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onOpenRemote: (session: HermesSession, profile: string) => void;
  otherProfiles: HermesProfile[];
  remoteSessions: HermesSession[];
  search: string;
  setSearch: (value: string) => void;
  showClose: boolean;
}) {
  const colors = useTheme();
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);
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
              From {isNamedProfile(activeProfile) ? activeProfile : 'your agent'}
            </ThemedText>
            {remoteSessions.slice(0, 20).map((session) => (
              <RemoteSessionRow
                key={session.id}
                importing={importingId === session.id}
                onPress={() => onOpenRemote(session, activeProfile)}
                session={session}
              />
            ))}
          </>
        ) : null}
        {otherProfiles.length ? (
          <CrossProfileSection
            connection={connection}
            expandedProfile={expandedProfile}
            importingId={importingId}
            onOpenRemote={onOpenRemote}
            otherProfiles={otherProfiles}
            setExpandedProfile={setExpandedProfile}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function RemoteSessionRow({
  importing,
  onPress,
  session,
}: {
  importing: boolean;
  onPress: () => void;
  session: HermesSession;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.remoteRow, { opacity: pressed ? 0.72 : 1 }]}>
      <View style={styles.threadCopy}>
        <ThemedText numberOfLines={1} type="smallBold">
          {session.title || 'Brio conversation'}
        </ThemedText>
        <ThemedText themeColor="textTertiary" type="small">
          {session.message_count} messages · {relativeDate(normalizeTimestamp(session.started_at))}
        </ThemedText>
      </View>
      {importing ? <ActivityIndicator size="small" /> : <ThemedText>›</ThemedText>}
    </Pressable>
  );
}

/**
 * Cross-profile @session browsing: recent sessions from the environment's
 * other Hermes profiles, fetched lazily under their own query keys so no
 * profile's data is ever cached under another profile's identity.
 */
function CrossProfileSection({
  connection,
  expandedProfile,
  importingId,
  onOpenRemote,
  otherProfiles,
  setExpandedProfile,
}: {
  connection: AgentConnection;
  expandedProfile: string | null;
  importingId: string | null;
  onOpenRemote: (session: HermesSession, profile: string) => void;
  otherProfiles: HermesProfile[];
  setExpandedProfile: (profile: string | null) => void;
}) {
  return (
    <>
      <ThemedText style={styles.remoteLabel} themeColor="textTertiary" type="eyebrow">
        Other profiles
      </ThemedText>
      {otherProfiles.map((profile) => (
        <CrossProfileGroup
          key={profile.name}
          connection={connection}
          expanded={expandedProfile === profile.name}
          importingId={importingId}
          onOpenRemote={onOpenRemote}
          profile={profile}
          toggle={() =>
            setExpandedProfile(expandedProfile === profile.name ? null : profile.name)
          }
        />
      ))}
    </>
  );
}

function CrossProfileGroup({
  connection,
  expanded,
  importingId,
  onOpenRemote,
  profile,
  toggle,
}: {
  connection: AgentConnection;
  expanded: boolean;
  importingId: string | null;
  onOpenRemote: (session: HermesSession, profile: string) => void;
  profile: HermesProfile;
  toggle: () => void;
}) {
  // Only fetch when expanded; each profile keeps its own cache entry.
  const sessions = useQuery({
    queryKey: ['hermes-sessions-cross', connection.url, environmentId(connection), profile.name],
    enabled: expanded,
    queryFn: () => listHermesSessions(connection, 10, profile.name),
    staleTime: 30_000,
    retry: false,
  });
  return (
    <View style={styles.crossProfileGroup}>
      <Pressable
        accessibilityLabel={`Show sessions from profile ${profile.name}`}
        onPress={toggle}
        style={({ pressed }) => [
          styles.crossProfileHeader,
          { opacity: pressed ? 0.72 : 1 },
        ]}>
        <ThemedText
          numberOfLines={1}
          themeColor={profile.gateway_running ? 'text' : 'textSecondary'}
          type="smallBold">
          {profile.gateway_running ? '● ' : '○ '}
          {profile.name}
        </ThemedText>
        <ThemedText themeColor="textTertiary">{expanded ? '▾' : '›'}</ThemedText>
      </Pressable>
      {expanded ? (
        sessions.isLoading ? (
          <ActivityIndicator size="small" style={styles.crossProfileLoading} />
        ) : (sessions.data?.sessions ?? []).length ? (
          (sessions.data?.sessions ?? []).slice(0, 8).map((session) => (
            <RemoteSessionRow
              key={session.id}
              importing={importingId === session.id}
              onPress={() => onOpenRemote(session, profile.name)}
              session={session}
            />
          ))
        ) : (
          <ThemedText style={styles.emptyThreads} themeColor="textTertiary" type="small">
            {sessions.isError
              ? 'No reachable sessions for this profile.'
              : 'No sessions yet.'}
          </ThemedText>
        )
      ) : null}
    </View>
  );
}

function ChatHeader({
  activeProfile,
  availableProfiles,
  connection,
  health,
  healthError,
  healthLoading,
  onDisconnect,
  onNew,
  onOpenThreads,
  onSwitchProfile,
  compact,
  profilesLoading,
  showThreadsButton,
  thread,
}: {
  activeProfile: string;
  availableProfiles: HermesProfile[];
  connection: AgentConnection;
  health?: HealthResponse;
  healthError: boolean;
  healthLoading: boolean;
  onDisconnect: () => void;
  onNew: () => void;
  onOpenThreads: () => void;
  onSwitchProfile: (name: string) => void;
  compact: boolean;
  profilesLoading: boolean;
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
              {connection.name}
              {isNamedProfile(activeProfile) ? ` · ${activeProfile}` : ''} ·{' '}
              {online ? 'online' : healthLoading ? 'checking' : 'unavailable'}
            </ThemedText>
          </View>
        </View>
      </View>
      <View style={styles.headerActions}>
        {availableProfiles.length > 1 || (profilesLoading && availableProfiles.length === 0) ? (
          <ProfileSwitcher
            activeProfile={activeProfile}
            loading={profilesLoading}
            onSelect={onSwitchProfile}
            profiles={availableProfiles}
          />
        ) : null}
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

/**
 * Profile switcher for the connected environment. Selecting a profile swaps
 * the whole workspace identity (threads, composer drafts, session cache);
 * it never reconnects or changes the environment itself.
 */
function ProfileSwitcher({
  activeProfile,
  loading,
  onSelect,
  profiles,
}: {
  activeProfile: string;
  loading: boolean;
  onSelect: (name: string) => void;
  profiles: HermesProfile[];
}) {
  const colors = useTheme();
  if (!profiles.length) {
    return loading ? (
      <ActivityIndicator size="small" />
    ) : null;
  }
  const activeMeta = profiles.find((profile) => profile.name === activeProfile);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.profileChips}>
      {profiles.map((profile) => {
        const active = profile.name === activeProfile;
        return (
          <Pressable
            key={profile.name}
            accessibilityLabel={`Switch to profile ${profile.name}`}
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(profile.name)}
            style={({ pressed }) => [
              styles.profileChip,
              {
                borderColor: active ? colors.accent : colors.border,
                backgroundColor: active ? colors.backgroundSelected : 'transparent',
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <View
              style={[
                styles.profileChipDot,
                { backgroundColor: profile.gateway_running ? colors.success : colors.textTertiary },
              ]}
            />
            <ThemedText numberOfLines={1} type="smallBold">{profile.name}</ThemedText>
          </Pressable>
        );
      })}
      {activeMeta?.gateway_multiplex ? (
        <View style={[styles.profileChip, { borderColor: colors.border }]}>
          <ThemedText themeColor="textTertiary" type="small">multiplexed</ThemedText>
        </View>
      ) : null}
    </ScrollView>
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

function displayPrompt(prompt: QueuedPrompt) {
  const attachmentNames = prompt.attachments.map((attachment) => `📎 ${attachment.name}`);
  return [prompt.deliveryMode === 'redirect' ? '↪ Redirect' : '', prompt.text.trim(), ...attachmentNames]
    .filter(Boolean)
    .join('\n');
}

function commandResponseText(value: Record<string, unknown>) {
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

function blockerNotice(
  blockers: string[],
  provider: string | null,
  model: string | null,
) {
  const unsupported = blockers
    .map((blocker) => (blocker === 'tools' ? 'tool calling' : 'image attachments'))
    .join(' or ');
  return `${provider}/${model} does not support ${unsupported}, which Brio agent turns require. Pick another model to send messages.`;
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
  crossProfileGroup: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.08)', marginTop: Spacing.one },
  crossProfileHeader: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two, justifyContent: 'space-between', minHeight: 40, paddingHorizontal: Spacing.three },
  crossProfileLoading: { paddingVertical: Spacing.two },
  profileChips: { flexGrow: 0, maxHeight: 44 },
  profileChip: { alignItems: 'center', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 6 },
  profileChipDot: { borderRadius: 4, height: 6, width: 6 },
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
  composerHint: { marginTop: Spacing.one, textAlign: 'center' },
});
