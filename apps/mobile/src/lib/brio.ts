export type AgentConnection = {
  id: string;
  name: string;
  mode: 'self_hosted' | 'brio_hosted';
  transport: 'relay' | 'direct';
  status: 'online' | 'offline' | 'connecting' | 'error';
  capabilities: Record<string, unknown>;
  url: string;
  token: string;
  relayToken?: string;
  agentId?: string;
  pairingCode?: string;
};

export type HealthResponse = {
  ok: boolean;
  hermes_ok?: boolean;
  hermes_status?: number;
  hermes_home?: string;
  service?: string;
  hermes?: unknown;
  allowed_roots?: string[];
};

export type CapabilitiesResponse = {
  companion?: Record<string, unknown>;
  hermes?: unknown;
};

export type RelayDeviceSession = {
  user: { id: string; email: string };
  device: { id: string; user_id: string; name: string };
  token: string;
};

export type RelayClaimResponse = {
  agent: {
    id: string;
    name: string;
    mode: 'self_hosted' | 'brio_hosted';
    status: AgentConnection['status'];
  };
};

function normalizeBaseURL(url: string) {
  return url.trim().replace(/\/+$/, '');
}

export async function brioFetch<T>(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (connection.transport === 'relay') {
    return relayFetch<T>(connection, path, init);
  }
  const response = await fetch(`${normalizeBaseURL(connection.url)}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.error ?? body?.message ?? `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function getHealth(connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>) {
  return brioFetch<HealthResponse>(connection, '/health');
}

export function getCapabilities(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
) {
  return brioFetch<CapabilitiesResponse>(connection, '/capabilities');
}

export async function sendResponse(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  prompt: string,
) {
  return brioFetch<Record<string, unknown>>(connection, '/chat/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'hermes-agent',
      input: prompt,
      stream: false,
    }),
  });
}

export type PairingPayload = {
  url: string;
  token: string;
  mode?: 'direct' | 'relay';
  transport?: 'direct' | 'relay';
  agent_id?: string;
  code?: string;
};

export function decodePairingPayload(raw: string): PairingPayload {
  const value = raw.trim();
  if (!value) {
    throw new Error('Pairing payload is empty');
  }
  try {
    return JSON.parse(value) as PairingPayload;
  } catch {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    if (typeof atob !== 'function') {
      throw new Error('This device cannot decode the pairing payload');
    }
    const decoded = atob(padded);
    return JSON.parse(decoded) as PairingPayload;
  }
}

export function connectionFromPairingPayload(payload: PairingPayload): AgentConnection {
  const transport = payload.transport ?? payload.mode ?? 'direct';
  return {
    id: payload.agent_id ?? 'self-hosted-local',
    name: 'Hermes',
    mode: 'self_hosted',
    transport,
    status: 'connecting',
    capabilities: {},
    url: payload.url,
    token: payload.token,
    agentId: payload.agent_id,
    pairingCode: payload.code,
  };
}

export async function createRelayDevice(
  relayURL: string,
  email = 'dev@brio.local',
  deviceName = 'Brio mobile',
) {
  const response = await fetch(`${normalizeBaseURL(relayURL)}/auth/devices`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, device_name: deviceName }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? 'Could not create relay device');
  }
  return body as RelayDeviceSession;
}

export async function claimRelayPairing(
  relayURL: string,
  relayToken: string,
  pairingCode: string,
) {
  const response = await fetch(
    `${normalizeBaseURL(relayURL)}/pairings/${encodeURIComponent(pairingCode)}/claim`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${relayToken}`,
      },
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? 'Could not claim pairing');
  }
  return body as RelayClaimResponse;
}

type RelayFrame = {
  type: 'request' | 'response' | 'error';
  id: string;
  method?: string;
  path?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  code?: string;
  message?: string;
};

function relayFetch<T>(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  path: string,
  init: RequestInit,
): Promise<T> {
  const agentId = connection.agentId ?? connection.id;
  if (!agentId) {
    return Promise.reject(new Error('Relay connection is missing an agent id'));
  }
  const frameId = `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const relayToken = connection.relayToken;
  if (!relayToken) {
    return Promise.reject(new Error('Relay connection is missing a device token'));
  }
  const wsURL = relayTunnelURL(connection.url, agentId, relayToken);
  const body =
    typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : null;
  const requestFrame: RelayFrame = {
    type: 'request',
    id: frameId,
    method: init.method ?? 'GET',
    path,
    headers: {
      Authorization: `Bearer ${connection.token}`,
    },
    body,
  };

  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(wsURL);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Relay request timed out'));
    }, 30000);

    socket.onopen = () => {
      socket.send(JSON.stringify(requestFrame));
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Relay connection failed'));
    };
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as RelayFrame;
      if (frame.id !== frameId) {
        return;
      }
      clearTimeout(timeout);
      socket.close();
      if (frame.type === 'error') {
        reject(new Error(frame.message ?? frame.code ?? 'Relay request failed'));
        return;
      }
      if ((frame.status ?? 500) >= 400) {
        const message =
          typeof frame.body === 'object' && frame.body && 'error' in frame.body
            ? String((frame.body as { error?: unknown }).error)
            : `Request failed: ${frame.status}`;
        reject(new Error(message));
        return;
      }
      resolve(frame.body as T);
    };
  });
}

function relayTunnelURL(baseURL: string, agentId: string, relayToken: string) {
  const normalized = normalizeBaseURL(baseURL);
  const withScheme = normalized.startsWith('http') || normalized.startsWith('ws')
    ? normalized
    : `https://${normalized}`;
  const url = new URL(withScheme);
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/tunnel/mobile/${encodeURIComponent(agentId)}`;
  url.searchParams.set('token', relayToken);
  return url.toString();
}
