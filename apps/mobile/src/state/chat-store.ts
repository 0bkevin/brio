import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { NormalizedContextBreakdown, NormalizedRuntimeUsage } from '../lib/session-runtime';
import { mergeRuntimeUsage } from '../lib/session-runtime';

export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

// Per-thread model override. When absent the thread clearly inherits the
// connection profile's default model.
export type ChatModelOverride = {
  provider: string;
  model: string;
  reasoningEffort?: string;
  fast?: boolean;
};

export type ChatThreadRuntimePatch = {
  usage?: NormalizedRuntimeUsage;
  contextBreakdown?: NormalizedContextBreakdown | undefined;
  runtimeSessionId?: string;
};

export type ChatThread = {
  id: string;
  connectionKey?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  lastResponseId?: string;
  importedSessionId?: string;
  needsHistorySeed?: boolean;
  modelOverride?: ChatModelOverride;
  usage?: NormalizedRuntimeUsage;
  contextBreakdown?: NormalizedContextBreakdown;
  runtimeSessionId?: string;
};

type ChatState = {
  hydrated: boolean;
  activeThreadId: string | null;
  threads: ChatThread[];
  setHydrated: (hydrated: boolean) => void;
  createThread: (connectionKey: string) => string;
  selectThread: (id: string) => void;
  deleteThread: (id: string) => void;
  addMessage: (threadId: string, message: ChatMessage) => void;
  completeResponse: (
    threadId: string,
    message: ChatMessage,
    responseId?: string,
    runtime?: ChatThreadRuntimePatch,
  ) => void;
  updateThreadRuntime: (threadId: string, patch: ChatThreadRuntimePatch) => void;
  setThreadModelOverride: (threadId: string, override: ChatModelOverride | undefined) => void;
  importThread: (connectionKey: string, sessionId: string, title: string, messages: ChatMessage[]) => string;
};

export function createChatId(prefix: string) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function titleFromMessage(content: string) {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'New conversation';
  return singleLine.length > 46 ? `${singleLine.slice(0, 46).trim()}…` : singleLine;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      activeThreadId: null,
      threads: [],
      setHydrated: (hydrated) => set({ hydrated }),
      createThread: (connectionKey) => {
        const now = Date.now();
        const id = createChatId('thread');
        const thread: ChatThread = {
          id,
          connectionKey,
          title: 'New conversation',
          createdAt: now,
          updatedAt: now,
          messages: [],
          // The thread id doubles as the stable runtime session identity for
          // fresh conversations; imported threads use the imported session id.
          runtimeSessionId: id,
        };
        set((state) => ({ activeThreadId: id, threads: [thread, ...state.threads] }));
        return id;
      },
      selectThread: (id) => set({ activeThreadId: id }),
      deleteThread: (id) => {
        const remaining = get().threads.filter((thread) => thread.id !== id);
        set({
          threads: remaining,
          activeThreadId: get().activeThreadId === id ? (remaining[0]?.id ?? null) : get().activeThreadId,
        });
      },
      addMessage: (threadId, message) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  title:
                    thread.messages.length === 0 && message.role === 'user'
                      ? titleFromMessage(message.content)
                      : thread.title,
                  updatedAt: message.createdAt,
                  messages: [...thread.messages, message],
                }
              : thread,
          ),
        })),
      completeResponse: (threadId, message, responseId, runtime) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  updatedAt: message.createdAt,
                  messages: [...thread.messages, message],
                  lastResponseId: responseId ?? thread.lastResponseId,
                  needsHistorySeed: false,
                  // Merge so a sparse final Responses usage never erases
                  // richer live cache/reasoning/cost/call metrics.
                  ...(runtime?.usage !== undefined
                    ? { usage: mergeRuntimeUsage(thread.usage, runtime.usage) }
                    : {}),
                  ...(runtime?.contextBreakdown !== undefined
                    ? { contextBreakdown: runtime.contextBreakdown }
                    : {}),
                  ...(runtime?.runtimeSessionId !== undefined
                    ? { runtimeSessionId: runtime.runtimeSessionId }
                    : {}),
                }
              : thread,
          ),
        })),
      updateThreadRuntime: (threadId, patch) =>
        set((state) => ({
          threads: state.threads.map((thread) => {
            if (thread.id !== threadId) return thread;
            const next = { ...thread, ...patch };
            if (patch.usage !== undefined) {
              next.usage = mergeRuntimeUsage(thread.usage, patch.usage);
            }
            return next;
          }),
        })),
      setThreadModelOverride: (threadId, override) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId ? { ...thread, modelOverride: override } : thread,
          ),
        })),
      importThread: (connectionKey, sessionId, title, messages) => {
        const existing = get().threads.find(
          (thread) => thread.connectionKey === connectionKey && thread.importedSessionId === sessionId,
        );
        if (existing) {
          set({ activeThreadId: existing.id });
          return existing.id;
        }
        const id = createChatId('thread');
        const now = Date.now();
        const lastTimestamp = messages.at(-1)?.createdAt ?? now;
        const thread: ChatThread = {
          id,
          connectionKey,
          title: title || titleFromMessage(messages.find((message) => message.role === 'user')?.content ?? ''),
          createdAt: messages[0]?.createdAt ?? now,
          updatedAt: lastTimestamp,
          messages,
          importedSessionId: sessionId,
          runtimeSessionId: sessionId,
          needsHistorySeed: messages.length > 0,
        };
        set((state) => ({ activeThreadId: id, threads: [thread, ...state.threads] }));
        return id;
      },
    }),
    {
      name: 'brio.chatThreads.v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ activeThreadId: state.activeThreadId, threads: state.threads }),
      onRehydrateStorage: () => (state) => state?.setHydrated(true),
    },
  ),
);
