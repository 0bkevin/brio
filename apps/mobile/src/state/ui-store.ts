import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { DashboardThemes, type DashboardThemeName } from '@/constants/theme';

const STORAGE_KEY = 'brio.dashboardTheme.v1';

type UIState = {
  hydrated: boolean;
  themeName: DashboardThemeName;
  hydrate: () => Promise<void>;
  setThemeName: (themeName: DashboardThemeName) => Promise<void>;
};

function isThemeName(value: string | null): value is DashboardThemeName {
  return Boolean(value && value in DashboardThemes);
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

export const useUIStore = create<UIState>((set) => ({
  hydrated: false,
  themeName: 'default',
  hydrate: async () => {
    try {
      const storedTheme = await getStoredValue(STORAGE_KEY);
      set({
        hydrated: true,
        themeName: isThemeName(storedTheme) ? storedTheme : 'default',
      });
    } catch {
      set({ hydrated: true, themeName: 'default' });
    }
  },
  setThemeName: async (themeName) => {
    await setStoredValue(STORAGE_KEY, themeName);
    set({ themeName });
  },
}));
