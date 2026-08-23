import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';

type RelaySession = {
  relayURL: string;
  email: string;
  deviceName: string;
  token: string;
  userID: string;
  deviceID: string;
};

type RelaySessionState = {
  hydrated: boolean;
  session: RelaySession | null;
  hydrate: () => Promise<void>;
  saveSession: (session: RelaySession) => Promise<void>;
  clearSession: () => Promise<void>;
};

const STORAGE_KEY = 'brio.relaySession.v1';

async function getStoredValue(key: string) {
  if (Platform.OS === 'web') {
    return globalThis.localStorage?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}

async function setStoredValue(key: string, value: string) {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function deleteStoredValue(key: string) {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export type { RelaySession };

export const useRelaySessionStore = create<RelaySessionState>((set) => ({
  hydrated: false,
  session: null,
  hydrate: async () => {
    try {
      const raw = await getStoredValue(STORAGE_KEY);
      set({ session: raw ? (JSON.parse(raw) as RelaySession) : null, hydrated: true });
    } catch {
      set({ session: null, hydrated: true });
    }
  },
  saveSession: async (session) => {
    await setStoredValue(STORAGE_KEY, JSON.stringify(session));
    set({ session });
  },
  clearSession: async () => {
    await deleteStoredValue(STORAGE_KEY);
    set({ session: null });
  },
}));
