import type { AgentConnection } from '../lib/brio';

export type StoredConnections = {
  activeConnectionId: string | null;
  connections: AgentConnection[];
};

export function activeConnection(
  connections: AgentConnection[],
  activeConnectionId: string | null,
) {
  return (
    connections.find((connection) => connection.id === activeConnectionId) ?? connections[0] ?? null
  );
}

export function validStoredConnections(value: unknown): StoredConnections | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StoredConnections>;
  if (!Array.isArray(candidate.connections)) return null;
  const connections = candidate.connections.filter(isStoredConnection);
  const requestedId =
    typeof candidate.activeConnectionId === 'string' ? candidate.activeConnectionId : null;
  const activeConnectionId = activeConnection(connections, requestedId)?.id ?? null;
  return { activeConnectionId, connections };
}

export function isStoredConnection(value: unknown): value is AgentConnection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentConnection>;
  const gatewayFieldsAreValid =
    (candidate.gatewayUrl === undefined && candidate.gatewayToken === undefined) ||
    (candidate.transport === 'direct' &&
      typeof candidate.gatewayUrl === 'string' &&
      typeof candidate.gatewayToken === 'string');
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.url === 'string' &&
    typeof candidate.token === 'string' &&
    (candidate.transport === 'direct' || candidate.transport === 'relay') &&
    gatewayFieldsAreValid
  );
}

export function upsertStoredConnection(
  current: StoredConnections,
  connection: AgentConnection,
): StoredConnections {
  const existingIndex = current.connections.findIndex(
    (item) =>
      item.id === connection.id ||
      (item.transport === 'direct' &&
        connection.transport === 'direct' &&
        normalizedEndpoint(item.url) === normalizedEndpoint(connection.url)),
  );
  const connections =
    existingIndex === -1
      ? [...current.connections, connection]
      : current.connections.map((item, index) => (index === existingIndex ? connection : item));
  return { activeConnectionId: connection.id, connections };
}

export function removeStoredConnection(
  current: StoredConnections,
  connectionId: string,
): StoredConnections {
  return removeStoredConnectionsWhere(current, (connection) => connection.id === connectionId);
}

export function removeStoredConnectionsWhere(
  current: StoredConnections,
  shouldRemove: (connection: AgentConnection) => boolean,
): StoredConnections {
  const connections = current.connections.filter((item) => !shouldRemove(item));
  const activeConnectionId = activeConnection(connections, current.activeConnectionId)?.id ?? null;
  return { activeConnectionId, connections };
}

function normalizedEndpoint(value: string) {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}
