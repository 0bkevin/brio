import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';

const STORAGE_KEY = 'brio.activeRuns.v1';

type RunState = {
  activeRuns: Record<string, string>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setActiveRun: (runKey: string, runId: string) => void;
  clearActiveRun: (runKey: string) => void;
};

async function getStoredRuns() {
  const raw =
    Platform.OS === 'web'
      ? (globalThis.localStorage?.getItem(STORAGE_KEY) ?? null)
      : await SecureStore.getItemAsync(STORAGE_KEY);
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === 'string' && typeof entry[1] === 'string',
    ),
  );
}

async function setStoredRuns(activeRuns: Record<string, string>) {
  const value = JSON.stringify(activeRuns);
  if (Platform.OS === 'web') {
    globalThis.localStorage?.setItem(STORAGE_KEY, value);
    return;
  }
  await SecureStore.setItemAsync(STORAGE_KEY, value);
}

export const useRunStore = create<RunState>((set, get) => ({
  activeRuns: {},
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      set({ activeRuns: await getStoredRuns(), hydrated: true });
    } catch {
      set({ activeRuns: {}, hydrated: true });
    }
  },
  setActiveRun: (runKey, runId) => {
    const activeRuns = { ...get().activeRuns, [runKey]: runId };
    set({ activeRuns });
    void setStoredRuns(activeRuns);
  },
  clearActiveRun: (runKey) => {
    const activeRuns = { ...get().activeRuns };
    delete activeRuns[runKey];
    set({ activeRuns });
    void setStoredRuns(activeRuns);
  },
}));
