import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { profileName } from '@/lib/profiles';
import { threadProfileName, type ChatMessage, type ChatThread } from '@/state/chat-thread-model';

export type { ChatMessage, ChatRole, ChatThread } from '@/state/chat-thread-model';
export { threadMatchesScope, threadProfileName } from '@/state/chat-thread-model';

type ChatState = {
  hydrated: boolean;
  activeThreadId: string | null;
  threads: ChatThread[];
  setHydrated: (hydrated: boolean) => void;
  createThread: (connectionKey: string, profile?: string) => string;
  selectThread: (id: string) => void;
  deleteThread: (id: string) => void;
  addMessage: (threadId: string, message: ChatMessage) => void;
  completeResponse: (threadId: string, message: ChatMessage, responseId?: string) => void;
  importThread: (
    connectionKey: string,
    sessionId: string,
    title: string,
    messages: ChatMessage[],
    profile?: string,
  ) => string;
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
      createThread: (connectionKey, profile) => {
        const now = Date.now();
        const id = createChatId('thread');
        const thread: ChatThread = {
          id,
          connectionKey,
          profile: profileName(profile),
          title: 'New conversation',
          createdAt: now,
          updatedAt: now,
          messages: [],
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
      completeResponse: (threadId, message, responseId) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  updatedAt: message.createdAt,
                  messages: [...thread.messages, message],
                  lastResponseId: responseId ?? thread.lastResponseId,
                  needsHistorySeed: false,
                }
              : thread,
          ),
        })),
      importThread: (connectionKey, sessionId, title, messages, profile) => {
        const scopedProfile = profileName(profile);
        const existing = get().threads.find(
          (thread) =>
            thread.connectionKey === connectionKey &&
            threadProfileName(thread) === scopedProfile &&
            thread.importedSessionId === sessionId,
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
          profile: scopedProfile,
          title: title || titleFromMessage(messages.find((message) => message.role === 'user')?.content ?? ''),
          createdAt: messages[0]?.createdAt ?? now,
          updatedAt: lastTimestamp,
          messages,
          importedSessionId: sessionId,
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
