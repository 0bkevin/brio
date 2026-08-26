import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
import { AppText, AppTextInput, Button, Card, EmptyState } from '@/components/t3-ui';
import { SessionModelControls } from '@/components/session-model-controls';
import { CHAT_CONTENT_MAX_WIDTH, T3Radius, T3Spacing, T3Typography } from '@/constants/t3-theme';
import { useT3Theme } from '@/hooks/use-t3-theme';
import {
  approveRun,
  BrioRequestError,
  ensureSession,
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
  subscribeRunEvents,
  type AgentConnection,
  type HermesMessage,
  type HermesRunStatus,
} from '@/lib/brio';
import {
  acquireHermesGateway,
  type HermesGatewayClient,
  type HermesGatewayState,
} from '@/lib/hermes-gateway';
import { isNamedProfile } from '@/lib/profiles';
import {
  buildRuntimeModelOptions,
  modelIncompatibilities,
  normalizeLiveUsage,
  selectedCapabilities,
} from '@/lib/session-runtime';
import { useRunStore } from '@/state/run-store';
import { useComposerStore } from '@/state/composer-store';
import {
  EMPTY_COMPOSER_ATTACHMENTS,
  EMPTY_PROMPT_HISTORY,
  EMPTY_PROMPT_QUEUE,
  type QueuedPrompt,
} from '@/state/composer-store-model';
import type { ChatModelOverride, ChatThread } from '@/state/chat-thread-model';

type FeedItem = HermesMessage & { id: string };

type GatewaySessionResponse = {
  session_id: string;
  stored_session_id?: string;
  session_key?: string;
  running?: boolean;
  inflight?: {
    assistant?: string;
    error?: string;
    status?: string;
    streaming?: boolean;
  } | null;
  pending_approval?: Record<string, unknown> | null;
  pending_clarify?: Record<string, unknown> | null;
};

type GatewayApproval = {
  requestId: string;
  choices: ('once' | 'session' | 'always' | 'deny')[];
  detail?: string;
};

type GatewayInputQuestion = {
  id?: string;
  question: string;
  choices: string[];
  multiSelect: boolean;
};

type GatewayInputRequest = {
  kind: 'clarify' | 'sudo' | 'secret';
  requestId: string;
  prompt: string;
  questions: GatewayInputQuestion[];
  questionIndex: number;
};

function createDraftSessionId() {
  const timestamp = Date.now().toString(36);
  const entropy = Math.random().toString(36).slice(2, 12);
  return `brio_new_${timestamp}_${entropy}`;
}

export function HermesThreadScreen({
  connection,
  initialModelOverride,
  profile,
  routeSessionId,
}: {
  connection: AgentConnection;
  initialModelOverride?: ChatModelOverride;
  profile: string;
  routeSessionId: string;
}) {
  const colors = useT3Theme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<FeedItem>>(null);
  const composerKey = `${connection.id}:${profile}:${routeSessionId}`;
  const [generatedSessionId] = useState(createDraftSessionId);
  const persistedDraftSessionId = useComposerStore((state) => state.sessionIds[composerKey]);
  const sessionId = routeSessionId === 'new'
    ? (persistedDraftSessionId ?? generatedSessionId)
    : routeSessionId;
  const runKey = `${connection.id}:${profile}:${sessionId}`;
  const [modelOverride, setModelOverride] = useState<ChatModelOverride | undefined>(
    initialModelOverride,
  );
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [immediateMessages, setImmediateMessages] = useState<FeedItem[]>([]);
  const [composerError, setComposerError] = useState('');
  const gatewayRef = useRef<HermesGatewayClient | null>(null);
  const gatewaySessionRef = useRef<{ runtime: string; stored: string } | null>(null);
  const [gatewayState, setGatewayState] = useState<HermesGatewayState>('connecting');
  const [gatewayRun, setGatewayRun] = useState<HermesRunStatus | null>(null);
  const [gatewayActivity, setGatewayActivity] = useState<FeedItem[]>([]);
  const [gatewayApproval, setGatewayApproval] = useState<GatewayApproval | null>(null);
  const [gatewayInput, setGatewayInput] = useState<GatewayInputRequest | null>(null);
  const runId = useRunStore((state) => state.activeRuns[runKey] ?? null);
  const setActiveRun = useRunStore((state) => state.setActiveRun);
  const clearActiveRun = useRunStore((state) => state.clearActiveRun);
  const composerHydrated = useComposerStore((state) => state.hydrated);
  const ensureComposerSessionId = useComposerStore((state) => state.ensureSessionId);
  const draft = useComposerStore((state) => state.drafts[composerKey] ?? '');
  const attachments = useComposerStore(
    (state) => state.attachments[composerKey] ?? EMPTY_COMPOSER_ATTACHMENTS,
  );
  const queue = useComposerStore((state) => state.queues[composerKey] ?? EMPTY_PROMPT_QUEUE);
  const queuePaused = useComposerStore((state) => Boolean(state.paused[composerKey]));
  const history = useComposerStore(
    (state) => state.promptHistory[composerKey] ?? EMPTY_PROMPT_HISTORY,
  );
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

  useEffect(() => {
    if (routeSessionId !== 'new' || !composerHydrated) return;
    void ensureComposerSessionId(composerKey, generatedSessionId);
  }, [composerHydrated, composerKey, ensureComposerSessionId, generatedSessionId, routeSessionId]);

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
    refetchInterval: false,
    retry: false,
  });
  const contextBreakdown = useQuery({
    queryKey: ['session-context', connection.id, connection.url, profile, sessionId],
    queryFn: () => getSessionContextBreakdown(connection, sessionId, profile),
    enabled: routeSessionId !== 'new',
    refetchInterval: false,
    retry: false,
  });
  const run = useQuery({
    queryKey: ['run', connection.id, connection.url, profile, runId],
    queryFn: () => getRun(connection, runId!, profile),
    enabled: Boolean(runId && !runId.startsWith('gateway:')),
    refetchInterval: false,
  });
  const refetchRun = run.refetch;
  const currentRun = gatewayRun ?? run.data;
  const terminal = currentRun && ['completed', 'failed', 'cancelled'].includes(currentRun.status);
  const active = Boolean(runId && !terminal);

  useEffect(() => {
    if (
      !runId ||
      runId.startsWith('gateway:') ||
      !(run.error instanceof BrioRequestError) ||
      run.error.status !== 404
    ) {
      return;
    }
    const timer = setTimeout(() => {
      const hasQueuedPrompts = queue.length > 0;
      if (hasQueuedPrompts) void setQueuePaused(composerKey, true);
      setComposerError(
        hasQueuedPrompts
          ? 'Hermes no longer has the previous run. Queued prompts are paused because its delivery could not be verified.'
          : 'Hermes no longer has the previous run. Its final delivery could not be verified.',
      );
      clearActiveRun(runKey);
    }, 0);
    return () => clearTimeout(timer);
  }, [clearActiveRun, composerKey, queue.length, run.error, runId, runKey, setQueuePaused]);

  useEffect(() => {
    const acquired = acquireHermesGateway(connection, profile);
    const gateway = acquired.client;
    gatewayRef.current = gateway;
    let observedOpen = false;
    let disposed = false;
    const profileParams = isNamedProfile(profile) ? { profile } : {};
    const applyResumedSession = (resumed: GatewaySessionResponse, fallbackStoredID: string) => {
      const storedSessionID = resumed.stored_session_id ?? resumed.session_key ?? fallbackStoredID;
      const pendingInput = normalizeGatewayInput('clarify.request', resumed.pending_clarify);
      gatewaySessionRef.current = { runtime: resumed.session_id, stored: storedSessionID };
      setGatewayApproval(normalizeGatewayApproval(resumed.pending_approval));
      setGatewayInput(pendingInput);
      if (resumed.running || resumed.inflight?.error || resumed.pending_approval || pendingInput) {
        const identifier = `gateway:${resumed.session_id}`;
        setActiveRun(runKey, identifier);
        const storedRunKey = `${connection.id}:${profile}:${storedSessionID}`;
        if (storedRunKey !== runKey) setActiveRun(storedRunKey, identifier);
        setGatewayRun({
          object: 'hermes.run',
          run_id: identifier,
          session_id: storedSessionID,
          status: resumed.inflight?.error
            ? 'failed'
            : resumed.pending_approval
              ? 'waiting_for_approval'
              : pendingInput
                ? 'waiting_for_input'
              : 'running',
          output: resumed.inflight?.assistant,
          error: resumed.inflight?.error,
          updated_at: Date.now() / 1000,
        });
      } else {
        if (useRunStore.getState().activeRuns[runKey]?.startsWith('gateway:')) clearActiveRun(runKey);
        setGatewayRun(null);
      }
    };
    const rebindSession = async (storedSessionID: string) => {
      const resumed = await gateway.request<GatewaySessionResponse>('session.resume', {
        session_id: storedSessionID,
        omit_messages: true,
        ...profileParams,
      });
      if (disposed) return;
      applyResumedSession(resumed, storedSessionID);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['session-messages', connection.id, connection.url, profile, storedSessionID],
        }),
        queryClient.invalidateQueries({
          queryKey: ['session-usage', connection.id, connection.url, profile, storedSessionID],
        }),
        queryClient.invalidateQueries({
          queryKey: ['session-context', connection.id, connection.url, profile, storedSessionID],
        }),
      ]);
    };
    const removeStateListener = gateway.onState((state) => {
      setGatewayState(state);
      if (state !== 'open') return;
      if (!observedOpen) {
        observedOpen = true;
        return;
      }
      const target = gatewaySessionRef.current;
      if (!target) return;
      void rebindSession(target.stored).catch(() => {
        if (disposed) return;
        setGatewayState('degraded');
        if (useRunStore.getState().activeRuns[runKey]?.startsWith('gateway:')) clearActiveRun(runKey);
      });
    });
    const removeEventListener = gateway.onEvent((event) => {
      const target = gatewaySessionRef.current;
      if (!target || event.session_id !== target.runtime) return;
      const now = Date.now() / 1000;
      const runIdentifier = `gateway:${target.runtime}`;
      const base: HermesRunStatus = {
        object: 'hermes.run',
        run_id: runIdentifier,
        session_id: target.stored,
        status: 'running',
        updated_at: now,
      };
      if (event.type === 'message.start') {
        setGatewayActivity([]);
        setGatewayApproval(null);
        setGatewayInput(null);
        setGatewayRun(base);
      } else if (event.type === 'message.delta') {
        const delta = gatewayPayloadText(event.payload);
        setGatewayRun((previous) => ({
          ...(previous ?? base),
          status: 'running',
          output: `${previous?.output ?? ''}${delta}`,
          last_event: 'message.delta',
          updated_at: now,
        }));
      } else if (event.type === 'message.complete') {
        const output = gatewayPayloadText(event.payload);
        const failed = event.payload?.status === 'error';
        setGatewayActivity([]);
        setGatewayApproval(null);
        setGatewayInput(null);
        if (event.payload?.usage) {
          queryClient.setQueryData(
            ['session-usage', connection.id, connection.url, profile, target.stored],
            normalizeLiveUsage(event.payload.usage),
          );
        }
        setGatewayRun((previous) => ({
          ...(previous ?? base),
          status: failed ? 'failed' : 'completed',
          output: output || previous?.output,
          error: failed
            ? String(event.payload?.error ?? (output || 'Hermes failed the turn.'))
            : undefined,
          last_event: event.type,
          updated_at: now,
        }));
        clearActiveRun(`${connection.id}:${profile}:${target.stored}`);
        clearActiveRun(runKey);
      } else if (event.type === 'approval.request') {
        setGatewayInput(null);
        setGatewayApproval(normalizeGatewayApproval(event.payload));
        setGatewayRun((previous) => ({
          ...(previous ?? base),
          status: 'waiting_for_approval',
          last_event: event.type,
          updated_at: now,
        }));
      } else if (
        event.type === 'clarify.request' ||
        event.type === 'sudo.request' ||
        event.type === 'secret.request'
      ) {
        setGatewayApproval(null);
        setGatewayInput(normalizeGatewayInput(event.type, event.payload));
        setGatewayRun((previous) => ({
          ...(previous ?? base),
          status: 'waiting_for_input',
          last_event: event.type,
          updated_at: now,
        }));
      } else if (
        event.type === 'clarify.expire' ||
        event.type === 'sudo.expire' ||
        event.type === 'secret.expire'
      ) {
        const requestID = typeof event.payload?.request_id === 'string' ? event.payload.request_id : '';
        setGatewayInput((current) => {
          if (!current || (requestID && current.requestId !== requestID)) return current;
          setGatewayRun((previous) => previous ? { ...previous, status: 'running' } : previous);
          return null;
        });
      } else if (event.type === 'session.usage') {
        queryClient.setQueryData(
          ['session-usage', connection.id, connection.url, profile, target.stored],
          normalizeLiveUsage(event.payload?.usage ?? event.payload),
        );
      } else if (event.type === 'reasoning.delta' || event.type === 'thinking.delta') {
        const delta = gatewayPayloadText(event.payload);
        if (delta) {
          setGatewayActivity((current) => upsertGatewayActivity(current, {
            id: 'gateway-reasoning',
            role: 'tool',
            content: `${current.find((item) => item.id === 'gateway-reasoning')?.content ?? ''}${delta}`,
            tool_name: 'Reasoning',
            timestamp: now,
          }));
        }
      } else if (event.type === 'reasoning.available') {
        const text = gatewayPayloadText(event.payload);
        if (text) {
          setGatewayActivity((current) => upsertGatewayActivity(current, {
            id: 'gateway-reasoning',
            role: 'tool',
            content: text,
            tool_name: 'Reasoning',
            timestamp: now,
          }));
        }
      } else if (event.type === 'tool.start' || event.type === 'tool.complete') {
        const toolID = String(event.payload?.tool_id ?? event.seq ?? 'current');
        const toolName = String(event.payload?.name ?? 'Tool');
        const content = gatewayToolText(event.payload, event.type === 'tool.complete');
        setGatewayActivity((current) => upsertGatewayActivity(current, {
          id: `gateway-tool-${toolID}`,
          role: 'tool',
          content,
          tool_name: toolName,
          timestamp: now,
        }));
      } else if (event.type === 'error') {
        setGatewayActivity([]);
        setGatewayApproval(null);
        setGatewayInput(null);
        setGatewayRun((previous) => ({
          ...(previous ?? base),
          status: 'failed',
          error: gatewayPayloadText(event.payload) || 'Hermes gateway reported an error.',
          last_event: event.type,
          updated_at: now,
        }));
        clearActiveRun(`${connection.id}:${profile}:${target.stored}`);
        clearActiveRun(runKey);
      } else if (
        event.type.startsWith('tool.') ||
        event.type.endsWith('.request') ||
        event.type === 'status.update' ||
        event.type.endsWith('.delta')
      ) {
        setGatewayRun((previous) => ({
          ...(previous ?? base),
          last_event: event.type,
          updated_at: now,
        }));
      }
    });

    void gateway.connect().then(async () => {
      if (routeSessionId === 'new' || gatewaySessionRef.current) return;
      try {
        const resumed = await gateway.request<GatewaySessionResponse>('session.resume', {
          session_id: routeSessionId,
          omit_messages: true,
          ...profileParams,
        });
        applyResumedSession(resumed, routeSessionId);
      } catch {
        if (useRunStore.getState().activeRuns[runKey]?.startsWith('gateway:')) clearActiveRun(runKey);
        setGatewayState('degraded');
      }
    }).catch(() => {
      if (useRunStore.getState().activeRuns[runKey]?.startsWith('gateway:')) clearActiveRun(runKey);
      setGatewayApproval(null);
      setGatewayInput(null);
      setGatewayRun(null);
      setGatewayState('degraded');
    });

    return () => {
      disposed = true;
      removeEventListener();
      removeStateListener();
      if (gatewayRef.current === gateway) gatewayRef.current = null;
      gatewaySessionRef.current = null;
      acquired.release();
    };
  }, [clearActiveRun, connection, profile, queryClient, routeSessionId, runKey, setActiveRun]);

  useEffect(() => {
    if (!runId || runId.startsWith('gateway:')) return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refetchRun();
      }, 120);
    };
    const unsubscribe = subscribeRunEvents(connection, runId, profile, refresh, refresh);
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [connection, profile, refetchRun, runId]);

  useEffect(() => {
    if (!terminal) return;
    clearActiveRun(runKey);
    void queryClient.invalidateQueries({
      queryKey: ['session-messages', connection.id, connection.url, profile, sessionId],
    });
    void queryClient.invalidateQueries({ queryKey: ['sessions', connection.id, connection.url, profile] });
    void queryClient.invalidateQueries({
      queryKey: ['session-usage', connection.id, connection.url, profile, sessionId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['session-context', connection.id, connection.url, profile, sessionId],
    });
  }, [clearActiveRun, connection.id, connection.url, profile, queryClient, runKey, sessionId, terminal]);

  const submit = useMutation({
    mutationFn: async (queuedPrompt: QueuedPrompt) => {
      const input = queuedPrompt.text.trim();
      const promptModelOverride = queuedPrompt.modelOverride ?? modelOverride;
      const persistedModel = promptModelOverride
        ? {
            provider: promptModelOverride.provider,
            model: promptModelOverride.model,
            model_options: buildRuntimeModelOptions(promptModelOverride),
            require_model_lock: true,
          }
        : undefined;
      if (input.startsWith('/') && queuedPrompt.attachments.length === 0) {
        if (routeSessionId === 'new') {
          await ensureSession(connection, sessionId, profile, persistedModel);
        }
        const response = await dispatchComposerCommand(
          connection,
          sessionId,
          input,
          queuedPrompt.id,
          profile,
        );
        return { kind: 'immediate' as const, output: commandResponseText(response), sessionId };
      }

      const attachmentIds = queuedPrompt.attachments.map((attachment) => attachment.id);
      const advancedPrompt = attachmentIds.length > 0 || hasContextReference(input);
      const gateway = gatewayRef.current;
      if (gateway) {
        let gatewayPromptStarted = false;
        try {
          await gateway.connect();
          let target = gatewaySessionRef.current;
          if (!target) {
            if (routeSessionId === 'new') {
              const created = await gateway.request<{
                session_id: string;
                stored_session_id: string;
              }>('session.create', {
                source: 'brio',
                title: 'Hermes conversation',
                ...(isNamedProfile(profile) ? { profile } : {}),
                ...(promptModelOverride?.model ? { model: promptModelOverride.model } : {}),
                ...(promptModelOverride?.provider ? { provider: promptModelOverride.provider } : {}),
                ...(promptModelOverride?.reasoningEffort
                  ? { reasoning_effort: promptModelOverride.reasoningEffort }
                  : {}),
                ...(typeof promptModelOverride?.fast === 'boolean'
                  ? { fast: promptModelOverride.fast }
                  : {}),
              });
              target = { runtime: created.session_id, stored: created.stored_session_id };
            } else {
              const resumed = await gateway.request<GatewaySessionResponse>(
                'session.resume',
                {
                  session_id: routeSessionId,
                  omit_messages: true,
                  ...(isNamedProfile(profile) ? { profile } : {}),
                },
              );
              target = {
                runtime: resumed.session_id,
                stored: resumed.stored_session_id ?? resumed.session_key ?? routeSessionId,
              };
            }
            gatewaySessionRef.current = target;
          }

          const gatewayInput = advancedPrompt
            ? (await prepareComposerPrompt(connection, input, sessionId, attachmentIds, profile)).input
            : input;
          const gatewayRunID = `gateway:${target.runtime}`;
          const targetRunKey = `${connection.id}:${profile}:${target.stored}`;
          setActiveRun(runKey, gatewayRunID);
          if (targetRunKey !== runKey) setActiveRun(targetRunKey, gatewayRunID);
          setGatewayRun({
            object: 'hermes.run',
            run_id: gatewayRunID,
            session_id: target.stored,
            status: 'started',
            created_at: Date.now() / 1000,
            updated_at: Date.now() / 1000,
          });
          setGatewayActivity([]);
          try {
            gatewayPromptStarted = true;
            await gateway.request('prompt.submit', {
              session_id: target.runtime,
              text: gatewayInput,
            });
          } catch (reason) {
            clearActiveRun(runKey);
            if (targetRunKey !== runKey) clearActiveRun(targetRunKey);
            throw reason;
          }
          return {
            kind: 'gateway' as const,
            runId: gatewayRunID,
            sessionId: target.stored,
          };
        } catch (reason) {
          // A connected prompt has an ambiguous delivery outcome and must not
          // be repeated through REST. Only connection/session negotiation
          // failures arrive here before an active gateway run is installed.
          if (gatewayPromptStarted) throw reason;
          setGatewayState('degraded');
        }
      }

      // The Runs and Responses APIs interpret session_id as an existing
      // persisted session. The draft route's generated id is only a local
      // correlation key, so create its Hermes session before degrading from
      // the WebSocket gateway to REST. Without this step the run is accepted
      // asynchronously, navigation succeeds, and transcript loading then
      // fails with "Session not found: brio_new_...".
      if (routeSessionId === 'new') {
        await ensureSession(connection, sessionId, profile, persistedModel);
      }

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
          model: promptModelOverride?.model,
          provider: promptModelOverride?.provider,
          modelOptions: buildRuntimeModelOptions(promptModelOverride),
          sessionId,
          profile,
          composerSessionId: relayExpandsComposer ? sessionId : undefined,
          attachmentIds: relayExpandsComposer ? attachmentIds : undefined,
        });
        return {
          kind: 'immediate' as const,
          output: hermesResponseText(response),
          responseId: response.id,
          sessionId,
        };
      }

      const result = await startRun(connection, input, {
        sessionId,
        model: promptModelOverride?.model,
        provider: promptModelOverride?.provider,
        modelOptions: buildRuntimeModelOptions(promptModelOverride),
        profile,
        conversationHistory: (messages.data?.messages ?? [])
          .filter((message) =>
            (message.role === 'user' || message.role === 'assistant') && Boolean(message.content),
          )
          .map((message) => ({ role: message.role, content: message.content })),
      });
      return { kind: 'run' as const, runId: result.run_id, sessionId };
    },
    onMutate: (queuedPrompt) => {
      setComposerError('');
      setOptimisticPrompt({ content: displayPrompt(queuedPrompt), timestamp: Date.now() / 1000 });
    },
    onSuccess: async (result, queuedPrompt) => {
      if (result.kind === 'run') {
        setActiveRun(runKey, result.runId);
      } else if (result.kind === 'gateway') {
        setActiveRun(`${connection.id}:${profile}:${result.sessionId}`, result.runId);
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
        routeSessionId === 'new'
          ? `${connection.id}:${profile}:${result.sessionId ?? sessionId}`
          : composerKey,
        queuedPrompt.id,
      );
      await Promise.all(
        queuedPrompt.attachments.map((attachment) =>
          deleteAttachmentUpload(connection, attachment.id, profile).catch(() => undefined),
        ),
      );
      if (routeSessionId === 'new') {
        const params: string[] = [];
        if (isNamedProfile(profile)) params.push(`profile=${encodeURIComponent(profile)}`);
        const acceptedModelOverride = queuedPrompt.modelOverride ?? modelOverride;
        if (acceptedModelOverride) {
          params.push(`provider=${encodeURIComponent(acceptedModelOverride.provider)}`);
          params.push(`model=${encodeURIComponent(acceptedModelOverride.model)}`);
          if (acceptedModelOverride.reasoningEffort) {
            params.push(`effort=${encodeURIComponent(acceptedModelOverride.reasoningEffort)}`);
          }
          if (typeof acceptedModelOverride.fast === 'boolean') {
            params.push(`fast=${String(acceptedModelOverride.fast)}`);
          }
        }
        router.replace(
          `/thread/${encodeURIComponent(result.sessionId ?? sessionId)}${
            params.length ? `?${params.join('&')}` : ''
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
    mutationFn: async (choice: 'once' | 'session' | 'always' | 'deny') => {
      const target = gatewaySessionRef.current;
      if (runId?.startsWith('gateway:') && target && gatewayRef.current) {
        if (!gatewayApproval?.requestId || !gatewayApproval.choices.includes(choice)) {
          throw new Error('This Hermes approval is no longer available');
        }
        const result = await gatewayRef.current.request<{ resolved?: boolean }>('approval.respond', {
          session_id: target.runtime,
          request_id: gatewayApproval.requestId,
          choice,
        });
        if (result.resolved !== true) throw new Error('Hermes did not resolve the approval request');
        return result;
      }
      return approveRun(connection, runId!, choice, profile);
    },
    onSuccess: () => {
      if (runId?.startsWith('gateway:')) {
        setGatewayApproval(null);
        setGatewayRun((previous) => previous ? { ...previous, status: 'running' } : previous);
      } else {
        void run.refetch();
      }
    },
  });
  const answerGatewayInput = useMutation({
    mutationFn: async (answer: string) => {
      const request = gatewayInput;
      const gateway = gatewayRef.current;
      if (!request || !gateway || !request.requestId) {
        throw new Error('This Hermes input request is no longer available');
      }
      const question = request.questions[request.questionIndex];
      const method = `${request.kind}.respond`;
      const valueKey = request.kind === 'clarify' ? 'answer' : request.kind === 'sudo' ? 'password' : 'value';
      return gateway.request<{ status?: string; remaining?: string[] }>(method, {
        request_id: request.requestId,
        ...(question?.id ? { question_id: question.id } : {}),
        [valueKey]: answer,
      });
    },
    onSuccess: (result) => {
      setGatewayInput((current) => {
        if (!current) return null;
        if (current.kind === 'clarify' && Array.isArray(result.remaining) && result.remaining.length > 0) {
          const nextIndex = current.questions.findIndex((question) => question.id === result.remaining?.[0]);
          return { ...current, questionIndex: nextIndex >= 0 ? nextIndex : current.questionIndex + 1 };
        }
        return null;
      });
      if (!Array.isArray(result.remaining) || result.remaining.length === 0) {
        setGatewayRun((previous) => previous ? { ...previous, status: 'running' } : previous);
      }
    },
  });
  const stop = useMutation({
    mutationFn: () => {
      const target = gatewaySessionRef.current;
      if (runId?.startsWith('gateway:') && target && gatewayRef.current) {
        return gatewayRef.current.request('session.interrupt', { session_id: target.runtime });
      }
      return stopRun(connection, runId!, profile);
    },
    onSuccess: () => {
      if (runId?.startsWith('gateway:')) {
        setGatewayRun((previous) => previous ? { ...previous, status: 'stopping' } : previous);
      } else {
        void run.refetch();
      }
    },
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
  gatewayActivity.forEach((message) => feed.push(message));
  if (currentRun?.output && !feed.some((message) => message.content === currentRun.output)) {
    feed.push({
      id: 'current-output',
      role: 'assistant',
      content: currentRun.output,
      timestamp: currentRun.updated_at ?? 0,
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
  const selectedModelBlocked = Boolean(
    modelOverride &&
      modelIncompatibilities(
        selectedCapabilities(modelOptions.data ?? { model: null, provider: null, providers: [] }, modelOverride.provider, modelOverride.model),
        { vision: attachments.some((attachment) => attachment.kind === 'image'), tools: true },
      ).length,
  );
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
    const queuedPrompt = await enqueueDraft(composerKey, deliveryMode, modelOverride);
    if (!queuedPrompt || deliveryMode !== 'redirect' || !active) return;
    try {
      const target = gatewaySessionRef.current;
      if (runId?.startsWith('gateway:') && target && gatewayRef.current) {
        await gatewayRef.current.request('session.interrupt', { session_id: target.runtime });
      } else {
        await interruptComposerSession(connection, sessionId, profile);
        if (runId) await stopRun(connection, runId, profile).catch(() => undefined);
        void run.refetch();
      }
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
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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

        {currentRun?.status === 'waiting_for_approval' ? (
          <ApprovalCard
            approval={gatewayApproval}
            loading={approval.isPending}
            onChoose={(choice) => approval.mutate(choice)}
          />
        ) : null}

        {currentRun?.status === 'waiting_for_input' && gatewayInput ? (
          <GatewayInputCard
            key={`${gatewayInput.requestId}:${gatewayInput.questionIndex}`}
            loading={answerGatewayInput.isPending}
            onSubmit={(answer) => answerGatewayInput.mutate(answer)}
            request={gatewayInput}
          />
        ) : null}

        {active && currentRun?.status !== 'waiting_for_approval' && currentRun?.status !== 'waiting_for_input' ? (
          <View style={[styles.runStrip, { borderTopColor: colors.border }]}>
            <View style={[styles.pulse, { backgroundColor: colors.warning }]} />
            <AppText numberOfLines={1} style={[styles.runLabel, { color: colors.muted }]}>
              {gatewayState === 'reconnecting'
                ? 'Reconnecting to Hermes'
                : gatewayState === 'synchronizing'
                  ? 'Synchronizing missed events'
                  : currentRun?.last_event
                    ? humanizeEvent(currentRun.last_event)
                    : 'Hermes is working'}
            </AppText>
            <Pressable disabled={stop.isPending} onPress={() => stop.mutate()}>
              <AppText style={[styles.stopLabel, { color: colors.danger }]}>Stop</AppText>
            </Pressable>
          </View>
        ) : null}

        {currentRun?.status === 'failed' ? (
          <View style={[styles.errorStrip, { backgroundColor: colors.dangerSurface }]}>
            <AppText style={{ color: colors.danger }}>{currentRun.error ?? 'The run failed.'}</AppText>
          </View>
        ) : null}

        <View style={[styles.composerShell, { backgroundColor: colors.sheet }]}>
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
              forceExpanded={modelPickerOpen}
              history={history}
              hydrated={composerHydrated}
              modelControl={
                <SessionModelControls
                  onOpenChange={setModelPickerOpen}
                  onOverrideChange={changeModelOverride}
                  options={modelOptions.data}
                  optionsError={modelOptions.isError}
                  optionsLoading={modelOptions.isLoading}
                  sessions={analyticsSessions.data?.sessions}
                  thread={controlsThread}
                  variant="inline"
                />
              }
              onAddAttachment={(attachment) => addAttachment(composerKey, attachment)}
              onDraftChange={(value) => setDraft(composerKey, value)}
              onRedo={() => redoDraft(composerKey)}
              onRemoveAttachment={(attachmentId) => removeAttachment(composerKey, attachmentId)}
              onSend={(mode) => void send(mode)}
              onUndo={() => undoDraft(composerKey)}
              profile={profile}
              sendDisabled={selectedModelBlocked}
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
  approval,
  loading,
  onChoose,
}: {
  approval: GatewayApproval | null;
  loading: boolean;
  onChoose: (choice: 'once' | 'session' | 'always' | 'deny') => void;
}) {
  const colors = useT3Theme();
  return (
    <Card style={[styles.approvalCard, { borderColor: colors.warning }]}>
      <AppText style={styles.approvalTitle}>Hermes needs approval</AppText>
      <AppText style={[styles.approvalDetail, { color: colors.muted }]}>
        {approval?.detail ?? 'A protected action is waiting for your decision. Approve only if you trust the current task.'}
      </AppText>
      <View style={styles.approvalActions}>
        {(approval?.choices ?? ['once', 'session', 'deny']).map((choice) => (
          <Button
            disabled={loading || (approval !== null && !approval.requestId)}
            key={choice}
            onPress={() => onChoose(choice)}
            style={styles.approvalButton}
            tone={choice === 'deny' ? 'danger' : choice === 'once' ? undefined : 'secondary'}>
            {{ once: 'Allow once', session: 'This session', always: 'Always allow', deny: 'Deny' }[choice]}
          </Button>
        ))}
      </View>
    </Card>
  );
}

function normalizeGatewayApproval(payload?: Record<string, unknown> | null): GatewayApproval | null {
  if (!payload) return null;
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : '';
  const allowed = new Set(['once', 'session', 'always', 'deny']);
  const choices = Array.isArray(payload.choices)
    ? payload.choices.filter(
        (choice): choice is GatewayApproval['choices'][number] =>
          typeof choice === 'string' && allowed.has(choice),
      )
    : ['once', 'session', 'deny'] satisfies GatewayApproval['choices'];
  const rawDetail = payload.description ?? payload.command ?? payload.reason;
  return {
    requestId,
    choices: choices.length > 0 ? choices : ['deny'],
    ...(typeof rawDetail === 'string' && rawDetail.trim() ? { detail: rawDetail.trim() } : {}),
  };
}

function GatewayInputCard({
  loading,
  onSubmit,
  request,
}: {
  loading: boolean;
  onSubmit: (answer: string) => void;
  request: GatewayInputRequest;
}) {
  const colors = useT3Theme();
  const question = request.questions[request.questionIndex];
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const secure = request.kind === 'sudo' || request.kind === 'secret';
  const answer = question?.multiSelect
    ? selected.length > 0 ? JSON.stringify(selected) : draft.trim()
    : selected[0] ?? draft.trim();
  const toggleChoice = (choice: string) => {
    setDraft('');
    setSelected((current) =>
      question?.multiSelect
        ? current.includes(choice)
          ? current.filter((value) => value !== choice)
          : [...current, choice]
        : [choice],
    );
  };
  return (
    <Card style={[styles.approvalCard, { borderColor: colors.warning }]}>
      <AppText style={styles.approvalTitle}>
        {request.kind === 'clarify' ? 'Hermes has a question' : request.kind === 'sudo' ? 'Sudo password required' : 'Credential required'}
      </AppText>
      <AppText style={[styles.approvalDetail, { color: colors.muted }]}>
        {question?.question || request.prompt}
      </AppText>
      {question?.choices.map((choice) => (
        <Button
          disabled={loading}
          key={choice}
          onPress={() => toggleChoice(choice)}
          tone={selected.includes(choice) ? undefined : 'secondary'}>
          {selected.includes(choice) ? `✓ ${choice}` : choice}
        </Button>
      ))}
      <AppTextInput
        autoCapitalize="none"
        autoCorrect={false}
        editable={!loading}
        onChangeText={(value) => { setDraft(value); setSelected([]); }}
        placeholder={secure ? 'Enter securely…' : question?.choices.length ? 'Or type another answer…' : 'Type your answer…'}
        secureTextEntry={secure}
        value={draft}
      />
      <Button disabled={loading || !answer} onPress={() => onSubmit(answer)}>
        Continue
      </Button>
    </Card>
  );
}

function normalizeGatewayInput(
  type: string,
  payload?: Record<string, unknown> | null,
): GatewayInputRequest | null {
  if (!payload) return null;
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : '';
  if (!requestId) return null;
  if (type === 'sudo.request') {
    return { kind: 'sudo', requestId, prompt: 'Enter the password for the requested protected command.', questions: [], questionIndex: 0 };
  }
  if (type === 'secret.request') {
    const prompt = typeof payload.prompt === 'string'
      ? payload.prompt
      : typeof payload.env_var === 'string'
        ? `Enter ${payload.env_var}`
        : 'Enter the requested credential.';
    return { kind: 'secret', requestId, prompt, questions: [], questionIndex: 0 };
  }
  if (type !== 'clarify.request') return null;
  const normalizeQuestion = (value: unknown): GatewayInputQuestion | null => {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.question !== 'string' || !candidate.question.trim()) return null;
    return {
      ...(typeof candidate.qid === 'string' ? { id: candidate.qid } : {}),
      question: candidate.question,
      choices: Array.isArray(candidate.choices)
        ? candidate.choices.filter((choice): choice is string => typeof choice === 'string')
        : [],
      multiSelect: candidate.multi_select === true,
    };
  };
  const questions = Array.isArray(payload.questions)
    ? payload.questions.map(normalizeQuestion).filter((question): question is GatewayInputQuestion => question !== null)
    : [normalizeQuestion(payload)].filter((question): question is GatewayInputQuestion => question !== null);
  if (questions.length === 0) return null;
  const locked = payload.answers && typeof payload.answers === 'object'
    ? new Set(Object.keys(payload.answers as Record<string, unknown>))
    : new Set<string>();
  const questionIndex = questions.findIndex((question) => !question.id || !locked.has(question.id));
  if (questionIndex < 0) return null;
  return { kind: 'clarify', requestId, prompt: '', questions, questionIndex };
}

function humanizeEvent(event: string) {
  return event
    .replaceAll('.', ' ')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function gatewayPayloadText(payload?: Record<string, unknown>) {
  for (const key of ['text', 'message', 'summary', 'error']) {
    const value = payload?.[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function gatewayToolText(payload: Record<string, unknown> | undefined, complete: boolean) {
  for (const key of ['summary', 'context', 'result_text', 'inline_diff']) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return complete ? 'Completed' : 'Running…';
}

function upsertGatewayActivity(current: FeedItem[], next: FeedItem) {
  const index = current.findIndex((item) => item.id === next.id);
  if (index < 0) return [...current, next];
  const updated = [...current];
  updated[index] = next;
  return updated;
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
  composerShell: { paddingHorizontal: T3Spacing.lg, paddingVertical: 6 },
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
