import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import {
  EMPTY_COMPOSER_STATE,
  addComposerAttachment,
  enqueueComposerDraft,
  finalizeAcceptedPrompt,
  moveQueuedPrompt,
  nextQueuedPrompt,
  removeComposerAttachment,
  removeQueuedPrompt,
  restoreQueuedPromptToDraft,
  updateQueuedPrompt,
  validStoredComposerState,
  type QueuedPrompt,
  type ComposerAttachment,
  type PromptDeliveryMode,
  type StoredComposerState,
} from '@/state/composer-store-model';

const STORAGE_KEY = 'brio.composer.v1';
const DRAFT_SAVE_DELAY_MS = 250;
const STORAGE_ERROR = 'Composer changes could not be saved on this device.';

type ComposerState = StoredComposerState & {
  hydrated: boolean;
  storageError: string | null;
  draftRevisions: Record<string, DraftRevisions>;
  hydrate: () => Promise<void>;
  setDraft: (threadKey: string, text: string) => void;
  ensureSessionId: (threadKey: string, proposedId: string) => Promise<string>;
  addAttachment: (threadKey: string, attachment: ComposerAttachment) => Promise<void>;
  removeAttachment: (threadKey: string, attachmentId: string) => Promise<boolean>;
  enqueueDraft: (threadKey: string, deliveryMode?: PromptDeliveryMode) => Promise<QueuedPrompt | null>;
  undoDraft: (threadKey: string) => void;
  redoDraft: (threadKey: string) => void;
  claimNext: (threadKey: string) => Promise<QueuedPrompt | null>;
  finalizeAccepted: (
    sourceKey: string,
    destinationKey: string,
    promptId: string,
  ) => Promise<boolean>;
  fail: (threadKey: string, promptId: string, error: string) => Promise<void>;
  retry: (threadKey: string, promptId: string) => Promise<void>;
  remove: (threadKey: string, promptId: string) => Promise<boolean>;
  edit: (threadKey: string, promptId: string) => Promise<void>;
  move: (threadKey: string, promptId: string, offset: -1 | 1) => Promise<void>;
  setPaused: (threadKey: string, paused: boolean) => Promise<void>;
  flush: () => Promise<boolean>;
};

type DraftRevisions = {
  past: string[];
  future: string[];
  lastChangedAt: number;
};

let persistence = Promise.resolve();
let draftSaveTimer: ReturnType<typeof setTimeout> | undefined;

function storedSlice(state: StoredComposerState): StoredComposerState {
  return {
    drafts: state.drafts,
    attachments: state.attachments,
    queues: state.queues,
    paused: state.paused,
    promptHistory: state.promptHistory,
    sessionIds: state.sessionIds,
  };
}

function persist(state: StoredComposerState) {
  const value = JSON.stringify(storedSlice(state));
  persistence = persistence
    .catch(() => undefined)
    .then(() => AsyncStorage.setItem(STORAGE_KEY, value));
  return persistence;
}

function cancelScheduledDraftSave() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = undefined;
}

function promptId() {
  const random = Math.random().toString(36).slice(2);
  return `prompt_${Date.now().toString(36)}_${random}`;
}

export const useComposerStore = create<ComposerState>((set, get) => {
  const save = async (state: StoredComposerState) => {
    cancelScheduledDraftSave();
    try {
      await persist(state);
      set({ storageError: null });
      return true;
    } catch {
      set({ storageError: STORAGE_ERROR });
      return false;
    }
  };

  const saveCurrentStateSoon = () => {
    cancelScheduledDraftSave();
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = undefined;
      void save(storedSlice(get()));
    }, DRAFT_SAVE_DELAY_MS);
  };

  return {
    ...EMPTY_COMPOSER_STATE,
    hydrated: false,
    storageError: null,
    draftRevisions: {},
    hydrate: async () => {
      if (get().hydrated) return;
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const stored = raw ? validStoredComposerState(JSON.parse(raw)) : EMPTY_COMPOSER_STATE;
        set({
          ...(stored ?? EMPTY_COMPOSER_STATE),
          hydrated: true,
          storageError: raw && !stored ? 'Saved composer data was invalid and was not loaded.' : null,
        });
      } catch {
        set({
          ...EMPTY_COMPOSER_STATE,
          hydrated: true,
          storageError: 'Saved composer data could not be loaded.',
        });
      }
    },
    setDraft: (threadKey, text) => {
      const current = get();
      const previous = current.drafts[threadKey] ?? '';
      if (previous === text) return;
      const drafts = { ...current.drafts };
      if (text.length > 0) drafts[threadKey] = text;
      else delete drafts[threadKey];
      const existing = current.draftRevisions[threadKey];
      const now = Date.now();
      const beginRevision = !existing || now - existing.lastChangedAt > 750;
      const revisions: DraftRevisions = {
        past: beginRevision
          ? [...(existing?.past ?? []), previous].slice(-100)
          : (existing?.past ?? []),
        future: [],
        lastChangedAt: now,
      };
      set({
        drafts,
        draftRevisions: { ...current.draftRevisions, [threadKey]: revisions },
      });
      saveCurrentStateSoon();
    },
    ensureSessionId: async (threadKey, proposedId) => {
      const current = get();
      const existing = current.sessionIds[threadKey];
      if (existing) return existing;
      const sessionIds = { ...current.sessionIds, [threadKey]: proposedId };
      const next = { ...storedSlice(current), sessionIds };
      set({ sessionIds });
      await save(next);
      return proposedId;
    },
    addAttachment: async (threadKey, attachment) => {
      const next = addComposerAttachment(storedSlice(get()), threadKey, attachment);
      set(storedSlice(next));
      await save(next);
    },
    removeAttachment: async (threadKey, attachmentId) => {
      const next = removeComposerAttachment(storedSlice(get()), threadKey, attachmentId);
      set(storedSlice(next));
      return save(next);
    },
    enqueueDraft: async (threadKey, deliveryMode = 'queue') => {
      const enqueued = enqueueComposerDraft(
        storedSlice(get()),
        threadKey,
        promptId(),
        Date.now(),
        deliveryMode,
      );
      if (!enqueued) return null;
      set(storedSlice(enqueued.state));
      await save(enqueued.state);
      return enqueued.prompt;
    },
    undoDraft: (threadKey) => {
      const current = get();
      const revisions = current.draftRevisions[threadKey];
      const previous = revisions?.past.at(-1);
      if (previous === undefined) return;
      const present = current.drafts[threadKey] ?? '';
      const drafts = { ...current.drafts };
      if (previous) drafts[threadKey] = previous;
      else delete drafts[threadKey];
      set({
        drafts,
        draftRevisions: {
          ...current.draftRevisions,
          [threadKey]: {
            past: revisions.past.slice(0, -1),
            future: [present, ...revisions.future].slice(0, 100),
            lastChangedAt: 0,
          },
        },
      });
      saveCurrentStateSoon();
    },
    redoDraft: (threadKey) => {
      const current = get();
      const revisions = current.draftRevisions[threadKey];
      const nextText = revisions?.future[0];
      if (nextText === undefined) return;
      const present = current.drafts[threadKey] ?? '';
      const drafts = { ...current.drafts };
      if (nextText) drafts[threadKey] = nextText;
      else delete drafts[threadKey];
      set({
        drafts,
        draftRevisions: {
          ...current.draftRevisions,
          [threadKey]: {
            past: [...revisions.past, present].slice(-100),
            future: revisions.future.slice(1),
            lastChangedAt: 0,
          },
        },
      });
      saveCurrentStateSoon();
    },
    claimNext: async (threadKey) => {
      const current = storedSlice(get());
      const prompt = nextQueuedPrompt(current, threadKey);
      if (!prompt) return null;
      const attemptedAt = Date.now();
      // The in-flight marker must reach durable storage before the request starts.
      // Otherwise an app restart could silently send the same prompt twice.
      const next = updateQueuedPrompt(current, threadKey, prompt.id, {
        state: 'sending',
        attemptedAt,
      });
      set(storedSlice(next));
      if (!(await save(next))) {
        const failed = updateQueuedPrompt(storedSlice(get()), threadKey, prompt.id, {
          state: 'failed',
          error: 'Not sent because Brio could not save its delivery marker.',
        });
        set(storedSlice(failed));
        await save(failed);
        return null;
      }
      return { ...prompt, state: 'sending', attemptedAt };
    },
    finalizeAccepted: async (sourceKey, destinationKey, id) => {
      const next = finalizeAcceptedPrompt(storedSlice(get()), sourceKey, destinationKey, id);
      set(storedSlice(next));
      return save(next);
    },
    fail: async (threadKey, id, error) => {
      const next = updateQueuedPrompt(storedSlice(get()), threadKey, id, {
        state: 'failed',
        error,
      });
      set(storedSlice(next));
      await save(next);
    },
    retry: async (threadKey, id) => {
      const next = updateQueuedPrompt(storedSlice(get()), threadKey, id, { state: 'pending' });
      set(storedSlice(next));
      await save(next);
    },
    remove: async (threadKey, id) => {
      const next = removeQueuedPrompt(storedSlice(get()), threadKey, id);
      set(storedSlice(next));
      return save(next);
    },
    edit: async (threadKey, id) => {
      const next = restoreQueuedPromptToDraft(storedSlice(get()), threadKey, id);
      set(storedSlice(next));
      await save(next);
    },
    move: async (threadKey, id, offset) => {
      const next = moveQueuedPrompt(storedSlice(get()), threadKey, id, offset);
      set(storedSlice(next));
      await save(next);
    },
    setPaused: async (threadKey, pausedValue) => {
      const current = storedSlice(get());
      const paused = { ...current.paused };
      if (pausedValue) paused[threadKey] = true;
      else delete paused[threadKey];
      const next = { ...current, paused };
      set({ paused });
      await save(next);
    },
    flush: () => (get().hydrated ? save(storedSlice(get())) : Promise.resolve(true)),
  };
});
