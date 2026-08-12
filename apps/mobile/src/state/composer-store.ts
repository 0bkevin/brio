import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import {
  EMPTY_COMPOSER_STATE,
  addQueuedPrompt,
  moveComposerThread,
  moveQueuedPrompt,
  nextQueuedPrompt,
  removeQueuedPrompt,
  updateQueuedPrompt,
  validStoredComposerState,
  type QueuedPrompt,
  type StoredComposerState,
} from '@/state/composer-store-model';

const STORAGE_KEY = 'brio.composer.v1';

type ComposerState = StoredComposerState & {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDraft: (threadKey: string, text: string) => void;
  enqueueDraft: (threadKey: string, text: string) => Promise<QueuedPrompt | null>;
  claimNext: (threadKey: string) => Promise<QueuedPrompt | null>;
  acknowledge: (threadKey: string, promptId: string) => Promise<void>;
  fail: (threadKey: string, promptId: string, error: string) => Promise<void>;
  retry: (threadKey: string, promptId: string) => Promise<void>;
  remove: (threadKey: string, promptId: string) => Promise<void>;
  move: (threadKey: string, promptId: string, offset: -1 | 1) => Promise<void>;
  setPaused: (threadKey: string, paused: boolean) => Promise<void>;
  moveThread: (sourceKey: string, destinationKey: string) => Promise<void>;
};

let persistence = Promise.resolve();

function storedSlice(state: StoredComposerState): StoredComposerState {
  return { drafts: state.drafts, queues: state.queues, paused: state.paused };
}

function persist(state: StoredComposerState) {
  const value = JSON.stringify(storedSlice(state));
  persistence = persistence
    .catch(() => undefined)
    .then(() => AsyncStorage.setItem(STORAGE_KEY, value));
  return persistence;
}

function promptId() {
  const random = Math.random().toString(36).slice(2);
  return `prompt_${Date.now().toString(36)}_${random}`;
}

export const useComposerStore = create<ComposerState>((set, get) => ({
  ...EMPTY_COMPOSER_STATE,
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const stored = raw ? validStoredComposerState(JSON.parse(raw)) : EMPTY_COMPOSER_STATE;
      set({ ...(stored ?? EMPTY_COMPOSER_STATE), hydrated: true });
    } catch {
      set({ ...EMPTY_COMPOSER_STATE, hydrated: true });
    }
  },
  setDraft: (threadKey, text) => {
    const current = get();
    const drafts = { ...current.drafts };
    if (text.length > 0) drafts[threadKey] = text;
    else delete drafts[threadKey];
    const next = { ...current, drafts };
    set({ drafts });
    void persist(next);
  },
  enqueueDraft: async (threadKey, text) => {
    if (!text.trim()) return null;
    const prompt: QueuedPrompt = {
      id: promptId(),
      text,
      createdAt: Date.now(),
      state: 'pending',
    };
    const next = addQueuedPrompt(get(), threadKey, prompt);
    set(storedSlice(next));
    await persist(next);
    return prompt;
  },
  claimNext: async (threadKey) => {
    const current = get();
    if (current.paused[threadKey]) return null;
    const prompt = nextQueuedPrompt(current, threadKey);
    if (!prompt) return null;
    const attemptedAt = Date.now();
    // Persist the in-flight marker before making the network request. If the
    // app dies after Hermes accepts the prompt, hydration leaves this item in
    // `sending` so it cannot be resent without an explicit user retry.
    const next = updateQueuedPrompt(current, threadKey, prompt.id, {
      state: 'sending',
      attemptedAt,
    });
    set(storedSlice(next));
    await persist(next);
    return { ...prompt, state: 'sending', attemptedAt };
  },
  acknowledge: async (threadKey, id) => {
    const next = removeQueuedPrompt(get(), threadKey, id);
    set(storedSlice(next));
    await persist(next);
  },
  fail: async (threadKey, id, error) => {
    const next = updateQueuedPrompt(get(), threadKey, id, { state: 'failed', error });
    set(storedSlice(next));
    await persist(next);
  },
  retry: async (threadKey, id) => {
    const next = updateQueuedPrompt(get(), threadKey, id, { state: 'pending' });
    set(storedSlice(next));
    await persist(next);
  },
  remove: async (threadKey, id) => {
    const next = removeQueuedPrompt(get(), threadKey, id);
    set(storedSlice(next));
    await persist(next);
  },
  move: async (threadKey, id, offset) => {
    const next = moveQueuedPrompt(get(), threadKey, id, offset);
    set(storedSlice(next));
    await persist(next);
  },
  setPaused: async (threadKey, pausedValue) => {
    const current = get();
    const paused = { ...current.paused };
    if (pausedValue) paused[threadKey] = true;
    else delete paused[threadKey];
    const next = { ...current, paused };
    set({ paused });
    await persist(next);
  },
  moveThread: async (sourceKey, destinationKey) => {
    const next = moveComposerThread(get(), sourceKey, destinationKey);
    set(storedSlice(next));
    await persist(next);
  },
}));
