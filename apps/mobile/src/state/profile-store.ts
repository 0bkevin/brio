import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { DEFAULT_PROFILE_NAME, profileName } from '@/lib/profiles';

// Active Hermes profile per Brio environment. Switching a profile here never
// changes the environment itself and every consumer keys off the pair, so no
// profile's state leaks into another one.
const STORAGE_KEY = 'brio.activeProfiles.v1';

type ProfileState = {
  hydrated: boolean;
  activeProfiles: Record<string, string>;
  hydrate: () => Promise<void>;
  setActiveProfile: (environmentId: string, profile: string | undefined) => Promise<void>;
};

function validStoredMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || typeof entry !== 'string') continue;
    const name = entry.trim();
    // Unknown profiles fall back to default at read time; keep stored names
    // conservative.
    if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) && name !== 'profiles') {
      out[key] = name;
    }
  }
  return out;
}

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

export const useProfileStore = create<ProfileState>((set, get) => ({
  hydrated: false,
  activeProfiles: {},
  hydrate: async () => {
    try {
      const raw = await getStoredValue(STORAGE_KEY);
      set({ activeProfiles: validStoredMap(raw ? JSON.parse(raw) : null), hydrated: true });
    } catch {
      set({ activeProfiles: {}, hydrated: true });
    }
  },
  setActiveProfile: async (environmentId, profile) => {
    const next = { ...get().activeProfiles };
    const name = profileName(profile);
    if (!environmentId.trim()) return;
    if (name === DEFAULT_PROFILE_NAME) delete next[environmentId];
    else next[environmentId] = name;
    set({ activeProfiles: next });
    await setStoredValue(STORAGE_KEY, JSON.stringify(next));
  },
}));
