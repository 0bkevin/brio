import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';

import type { AgentConnection } from '@/lib/brio';
import {
  activeConnection,
  isStoredConnection,
  removeStoredConnection,
  removeStoredConnectionsWhere,
  upsertStoredConnection,
  validStoredConnections,
  type StoredConnections,
} from '@/state/connection-store-model';

const STORAGE_KEY = 'brio.agentConnections.v2';
const LEGACY_STORAGE_KEY = 'brio.agentConnection.v1';

type ConnectionState = StoredConnections & {
  hydrated: boolean;
  connection: AgentConnection | null;
  hydrate: () => Promise<void>;
  saveConnection: (connection: AgentConnection) => Promise<void>;
  selectConnection: (connectionId: string) => Promise<void>;
  removeConnection: (connectionId: string) => Promise<void>;
  removeRelayConnections: (relayURL: string) => Promise<void>;
  clearConnection: () => Promise<void>;
  updateConnection: (patch: Partial<AgentConnection>) => Promise<void>;
  updateSavedConnection: (connectionId: string, patch: Partial<AgentConnection>) => Promise<void>;
};

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

async function persistConnections(value: StoredConnections) {
  await setStoredValue(STORAGE_KEY, JSON.stringify(value));
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  hydrated: false,
  connection: null,
  connections: [],
  activeConnectionId: null,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await getStoredValue(STORAGE_KEY);
      const stored = raw ? validStoredConnections(JSON.parse(raw)) : null;
      if (raw) {
        if (!stored) throw new Error('Stored environments are invalid');
        set({
          ...stored,
          connection: activeConnection(stored.connections, stored.activeConnectionId),
          hydrated: true,
        });
        return;
      }

      const legacyRaw = await getStoredValue(LEGACY_STORAGE_KEY);
      const legacy = legacyRaw ? JSON.parse(legacyRaw) : null;
      if (isStoredConnection(legacy)) {
        const migrated = { activeConnectionId: legacy.id, connections: [legacy] };
        await persistConnections(migrated);
        set({ ...migrated, connection: legacy, hydrated: true });
        return;
      }
    } catch {
      // A corrupt or unavailable store should never block the onboarding screen.
    }
    set({ connection: null, connections: [], activeConnectionId: null, hydrated: true });
  },
  saveConnection: async (connection) => {
    const stored = upsertStoredConnection(get(), connection);
    await persistConnections(stored);
    set({ ...stored, connection });
  },
  selectConnection: async (connectionId) => {
    const connections = get().connections;
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) throw new Error('That environment is no longer available');
    const stored = { activeConnectionId: connection.id, connections };
    await persistConnections(stored);
    set({ ...stored, connection });
  },
  removeConnection: async (connectionId) => {
    const state = get();
    const stored = removeStoredConnection(state, connectionId);
    await persistConnections(stored);
    set({
      ...stored,
      connection: activeConnection(stored.connections, stored.activeConnectionId),
    });
  },
  removeRelayConnections: async (relayURL) => {
    const stored = removeStoredConnectionsWhere(
      get(),
      (connection) =>
        connection.transport === 'relay' &&
        connection.url.trim().replace(/\/+$/, '').toLowerCase() ===
          relayURL.trim().replace(/\/+$/, '').toLowerCase(),
    );
    await persistConnections(stored);
    set({
      ...stored,
      connection: activeConnection(stored.connections, stored.activeConnectionId),
    });
  },
  clearConnection: async () => {
    const connectionId = get().activeConnectionId;
    if (!connectionId) return;
    await get().removeConnection(connectionId);
  },
  updateConnection: async (patch) => {
    const connectionId = get().activeConnectionId;
    if (!connectionId) return;
    await get().updateSavedConnection(connectionId, patch);
  },
  updateSavedConnection: async (connectionId, patch) => {
    const state = get();
    const connections = state.connections.map((item) =>
      item.id === connectionId ? { ...item, ...patch, id: item.id } : item,
    );
    const connection = activeConnection(connections, state.activeConnectionId);
    const stored = { activeConnectionId: connection?.id ?? null, connections };
    await persistConnections(stored);
    set({ ...stored, connection });
  },
}));
