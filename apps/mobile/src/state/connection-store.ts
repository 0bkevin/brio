import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { create } from "zustand";

import type { AgentConnection } from "@/lib/brio";

const STORAGE_KEY = "brio.agentConnection.v1";

type ConnectionState = {
  hydrated: boolean;
  connection: AgentConnection | null;
  hydrate: () => Promise<void>;
  saveConnection: (connection: AgentConnection) => Promise<void>;
  clearConnection: () => Promise<void>;
  updateConnection: (patch: Partial<AgentConnection>) => void;
};

async function getStoredValue(key: string) {
  if (Platform.OS === "web") {
    return globalThis.localStorage?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}

async function setStoredValue(key: string, value: string) {
  if (Platform.OS === "web") {
    globalThis.localStorage?.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

function serializedConnection(connection: AgentConnection) {
  if (Platform.OS !== "web" || connection.authMode !== "dpop")
    return connection;
  // A web origin can recreate this short-lived token through Clerk. Avoid
  // leaving it in localStorage, where unrelated JavaScript can read it.
  return { ...connection, token: "" };
}

async function deleteStoredValue(key: string) {
  if (Platform.OS === "web") {
    globalThis.localStorage?.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  hydrated: false,
  connection: null,
  hydrate: async () => {
    try {
      const raw = await getStoredValue(STORAGE_KEY);
      set({
        connection: raw ? (JSON.parse(raw) as AgentConnection) : null,
        hydrated: true,
      });
    } catch {
      set({ connection: null, hydrated: true });
    }
  },
  saveConnection: async (connection) => {
    await setStoredValue(
      STORAGE_KEY,
      JSON.stringify(serializedConnection(connection)),
    );
    set({ connection });
  },
  clearConnection: async () => {
    await deleteStoredValue(STORAGE_KEY);
    set({ connection: null });
  },
  updateConnection: (patch) => {
    const current = get().connection;
    if (!current) {
      return;
    }
    const connection = { ...current, ...patch };
    void setStoredValue(
      STORAGE_KEY,
      JSON.stringify(serializedConnection(connection)),
    );
    set({ connection });
  },
}));
