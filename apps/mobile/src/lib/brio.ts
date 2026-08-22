import { fetch as expoFetch } from 'expo/fetch';

import {
  normalizeHermesSessionMessages,
  normalizeHermesSessions,
  type HermesSession,
  type HermesSessionMessage,
} from './hermes-api';
import { ResponsesSSEParser, type HermesResponse } from './responses-sse';

export type { HermesResponse } from './responses-sse';
export type { HermesSession, HermesSessionMessage } from './hermes-api';

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
  status?: string;
  hermes_ok?: boolean;
  hermes_status?: number;
  hermes_home?: string;
  service?: string;
  hermes?: unknown;
  allowed_roots?: string[];
};

/**
 * Healthy under either shape: the former companion's `{hermes_ok: true}` or
 * the Hermes API server's `{status: "ok"}`.
 */
export function isAgentHealthy(health: HealthResponse | null | undefined) {
  if (!health) return false;
  return health.hermes_ok === true || health.status === 'ok';
}

export type CapabilitiesResponse = {
  companion?: Record<string, unknown>;
  hermes?: unknown;
  features?: {
    session_resources?: boolean;
    memory_write_api?: boolean;
    [key: string]: unknown;
  };
  endpoints?: Record<string, { method?: string; path?: string }>;
};

export type RelayDeviceSession = {
  user: { id: string; email: string };
  device: { id: string; user_id: string; name: string };
  token: string;
};

export type RelayAgent = {
  id: string;
  name: string;
  mode: 'self_hosted' | 'brio_hosted';
  status: AgentConnection['status'];
  created_at?: string;
  last_seen_at?: string | null;
};

export type RelayClaimResponse = {
  agent: {
    id: string;
    name: string;
    mode: 'self_hosted' | 'brio_hosted';
    status: AgentConnection['status'];
  };
};

export type RelayRecoveryResponse = {
  code: string;
  agent_token: string;
  agent_id: string;
  name: string;
  expires_at: string;
  created_at: string;
};

export type RelayEnrollmentResponse = {
  code: string;
  name: string;
  expires_at: string;
  created_at: string;
};

function normalizeBaseURL(url: string) {
  return url.trim().replace(/\/+$/, '');
}

function cleanConnectionValue(value: string) {
  return value.trim().replace(/^["'`]+|[,"'`.;]+$/g, '');
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
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const errorBody = typeof body === 'object' && body ? (body as { error?: unknown; message?: unknown }) : null;
    const message = errorBody?.error ?? errorBody?.message ?? (typeof body === 'string' ? body : null);
    throw new Error(message ? String(message) : `Request failed: ${response.status}`);
  }
  return body as T;
}

export function getHealth(connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>) {
  return brioFetch<HealthResponse>(connection, '/health');
}

export function getCapabilities(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
) {
  return brioFetch<CapabilitiesResponse>(connection, '/v1/capabilities');
}

export async function sendResponse(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  prompt: string,
  options: {
    conversation?: string;
    previousResponseId?: string;
    conversationHistory?: { role: string; content: string }[];
  } = {},
) {
  return brioFetch<HermesResponse>(connection, '/v1/responses', {
    method: 'POST',
    body: JSON.stringify(responseRequestBody(prompt, options, false)),
  });
}

export async function sendResponseStream(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  prompt: string,
  options: {
    conversation?: string;
    previousResponseId?: string;
    conversationHistory?: { role: string; content: string }[];
    onTextDelta?: (delta: string) => void;
  } = {},
) {
  const parser = new ResponsesSSEParser(options.onTextDelta);
  const body = JSON.stringify(responseRequestBody(prompt, options, true));

  if (connection.transport === 'relay') {
    await relayFetch<null>(
      connection,
      '/v1/responses',
      { method: 'POST', body },
      (chunk) => parser.push(chunk),
    );
    return parser.finish();
  }

  const response = await expoFetch(`${normalizeBaseURL(connection.url)}/v1/responses`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`,
    },
    body,
  });
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (!response.ok || !contentType.includes('text/event-stream')) {
    const text = await response.text();
    const result = text ? (JSON.parse(text) as HermesResponse) : null;
    if (!response.ok) {
      const error = typeof result?.error === 'string' ? result.error : result?.error?.message;
      throw new Error(error ?? `Request failed: ${response.status}`);
    }
    if (!result) throw new Error('Agent returned an empty response');
    return result;
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Streaming response body is unavailable');
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  return parser.finish();
}

function responseRequestBody(
  prompt: string,
  options: {
    conversation?: string;
    previousResponseId?: string;
    conversationHistory?: { role: string; content: string }[];
  },
  stream: boolean,
) {
  return {
    model: 'hermes-agent',
    input: prompt,
    stream,
    ...(options.previousResponseId
      ? { previous_response_id: options.previousResponseId }
      : options.conversationHistory?.length
        ? { conversation: options.conversation, conversation_history: options.conversationHistory }
        : options.conversation
          ? { conversation: options.conversation }
          : {}),
  };
}

export async function listHermesSessions(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  limit = 60,
) {
  const result = await brioFetch<{ data?: HermesSession[] }>(connection, `/api/sessions?limit=${limit}`);
  return normalizeHermesSessions(result);
}

export async function getHermesSessionMessages(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  sessionId: string,
) {
  const result = await brioFetch<{ data?: HermesSessionMessage[] }>(
    connection,
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  return normalizeHermesSessionMessages(result);
}

export function hermesResponseText(response: HermesResponse) {
  if (response.output_text?.trim()) return response.output_text.trim();
  const parts = (response.output ?? []).flatMap((item) =>
    (item.content ?? [])
      .filter((part) => part.type === 'output_text' || part.type === 'text' || Boolean(part.text))
      .map((part) => part.text?.trim())
      .filter((text): text is string => Boolean(text)),
  );
  if (parts.length) return parts.join('\n\n');
  const error = typeof response.error === 'string' ? response.error : response.error?.message;
  return error?.trim() || 'Brio completed the request without a text response.';
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
    return JSON.parse(decodeBase64URL(value)) as PairingPayload;
  }
}

export function extractPairingPayload(raw: string): PairingPayload {
  const value = raw.trim();
  if (!value) {
    throw new Error('Agent reply is empty');
  }

  const notReadyMatch = value.match(/^\s*NOT\s+READY\s*:\s*(.+)$/is);
  if (notReadyMatch) {
    throw new Error(notReadyMatch[1].trim());
  }

  try {
    return decodePairingPayload(value);
  } catch {
    // Fall through to more forgiving parsing for human-readable Hermes replies.
  }

  const jsonBlock = value.match(/\{[\s\S]*\}/)?.[0];
  if (jsonBlock) {
    try {
      return JSON.parse(jsonBlock) as PairingPayload;
    } catch {
      // Ignore and continue with label-based parsing.
    }
  }

  const urlMatch =
    value.match(/(?:^|\n)\s*url\s*:\s*(\S+)/i) ??
    value.match(/\bhttps?:\/\/[^\s"'`]+/i);
  const tokenMatch = value.match(/(?:^|\n)\s*token\s*:\s*([^\s]+)/i);

  if (!urlMatch || !tokenMatch) {
    throw new Error('Could not find a pairing payload or URL/token in the agent reply');
  }

  return {
    url: cleanConnectionValue(urlMatch[1] ?? urlMatch[0]),
    token: cleanConnectionValue(tokenMatch[1]),
    mode: 'direct',
    transport: 'direct',
  };
}

export function connectionFromPairingPayload(payload: PairingPayload): AgentConnection {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Pairing payload must be an object');
  }
  const transport = payload.transport ?? payload.mode ?? 'direct';
  if (transport !== 'direct' && transport !== 'relay') {
    throw new Error('Pairing payload has an unsupported transport');
  }
  if (typeof payload.url !== 'string' || !payload.url.trim()) {
    throw new Error('Pairing payload is missing a server URL');
  }
  if (transport === 'direct' && (typeof payload.token !== 'string' || !payload.token.trim())) {
    throw new Error('Pairing payload is missing a direct connection token');
  }
  if (transport === 'relay' && (typeof payload.code !== 'string' || !payload.code.trim())) {
    throw new Error('Relay pairing payload is missing a pairing code');
  }
  return {
    id: payload.agent_id ?? 'self-hosted-local',
    name: 'Brio Agent',
    mode: 'self_hosted',
    transport,
    status: 'connecting',
    capabilities: {},
    url: payload.url.trim(),
    token: typeof payload.token === 'string' ? payload.token.trim() : '',
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

export async function listRelayAgents(relayURL: string, relayToken: string) {
  const response = await fetch(`${normalizeBaseURL(relayURL)}/agents`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${relayToken}`,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? 'Could not load agents');
  }
  return (body?.agents ?? []) as RelayAgent[];
}

export async function createRelayEnrollment(
  relayURL: string,
  relayToken: string,
  name = 'Brio Agent',
) {
  const response = await fetch(`${normalizeBaseURL(relayURL)}/enrollments`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${relayToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? 'Could not create enrollment');
  }
  return body as RelayEnrollmentResponse;
}

export async function recoverRelayAgent(
  relayURL: string,
  relayToken: string,
  agentID: string,
  name?: string,
) {
  const response = await fetch(
    `${normalizeBaseURL(relayURL)}/agents/${encodeURIComponent(agentID)}/recover`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${relayToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(name ? { name } : {}),
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? 'Could not recover relay agent');
  }
  return body as RelayRecoveryResponse;
}

type RelayFrame = {
  type: 'request' | 'response' | 'stream_chunk' | 'stream_end' | 'error' | 'ping' | 'pong';
  id: string;
  method?: string;
  path?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  data?: string;
  code?: string;
  message?: string;
};

type PendingRelayRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  chunks: unknown[];
  onChunk?: (chunk: string) => void;
};

const relayClients = new Map<string, RelaySocketClient>();

class RelaySocketClient {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private pending = new Map<string, PendingRelayRequest>();

  constructor(private readonly wsURL: string) {}

  request<T>(frame: RelayFrame, timeoutMs = 5 * 60 * 1000, onChunk?: (chunk: string) => void): Promise<T> {
    return this.connect().then(
      () =>
        new Promise<T>((resolve, reject) => {
          const socket = this.socket;
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            reject(new Error('Relay connection is not open'));
            return;
          }

          const timer = setTimeout(() => {
            if (this.pending.delete(frame.id)) {
              reject(new Error('Relay request timed out'));
            }
          }, timeoutMs);

          this.pending.set(frame.id, {
            resolve: (value) => resolve(value as T),
            reject,
            timer,
            chunks: [],
            onChunk,
          });

          try {
            socket.send(JSON.stringify(frame));
          } catch (error) {
            this.clearPending(frame.id);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
  }

  private connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.opening) {
      return this.opening;
    }

    this.opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.wsURL);
      this.socket = socket;

      const connectTimer = setTimeout(() => {
        if (this.socket === socket) {
          socket.close();
          this.socket = null;
        }
        this.opening = null;
        reject(new Error('Relay connection timed out'));
      }, 15000);

      socket.onopen = () => {
        clearTimeout(connectTimer);
        this.opening = null;
        resolve();
      };

      socket.onerror = () => {
        clearTimeout(connectTimer);
        if (this.opening) {
          this.opening = null;
          reject(new Error('Relay connection failed'));
        }
      };

      socket.onmessage = (event) => {
        this.handleMessage(String(event.data));
      };

      socket.onclose = () => {
        clearTimeout(connectTimer);
        if (this.socket === socket) {
          this.socket = null;
        }
        this.opening = null;
        this.rejectAll(new Error('Relay connection closed'));
      };
    });

    return this.opening;
  }

  private handleMessage(data: string) {
    let frame: RelayFrame;
    try {
      frame = JSON.parse(data) as RelayFrame;
    } catch {
      return;
    }

    if (frame.type === 'ping') {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'pong', id: frame.id } satisfies RelayFrame));
      }
      return;
    }

    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }

    if (frame.type === 'stream_chunk') {
      if (pending.onChunk) {
        try {
          pending.onChunk(String(frame.data ?? frame.body ?? ''));
        } catch (error) {
          this.clearPending(frame.id);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      pending.chunks.push(frame.body ?? frame.data ?? null);
      return;
    }

    this.clearPending(frame.id);

    if (frame.type === 'error') {
      pending.reject(new Error(frame.message ?? frame.code ?? 'Relay request failed'));
      return;
    }

    if (frame.type === 'stream_end') {
      if (pending.onChunk) {
        pending.resolve(null);
        return;
      }
      if (frame.body !== undefined) {
        pending.resolve(frame.body);
        return;
      }
      if (pending.chunks.length === 0) {
        pending.resolve(null);
        return;
      }
      if (pending.chunks.every((chunk) => typeof chunk === 'string')) {
        const combined = pending.chunks.join('');
        try {
          pending.resolve(JSON.parse(combined));
        } catch {
          pending.reject(new Error('Relay returned streamed data that could not be decoded'));
        }
        return;
      }
      if (pending.chunks.length === 1) {
        pending.resolve(pending.chunks[0]);
        return;
      }
      pending.reject(new Error('Relay returned an unsupported streamed response'));
      return;
    }

    if ((frame.status ?? 500) >= 400) {
      const message =
        typeof frame.body === 'object' && frame.body && 'error' in frame.body
          ? String((frame.body as { error?: unknown }).error)
          : `Request failed: ${frame.status}`;
      pending.reject(new Error(message));
      return;
    }

    pending.resolve(frame.body);
  }

  private clearPending(id: string) {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
    }
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function relayFetch<T>(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  path: string,
  init: RequestInit,
  onChunk?: (chunk: string) => void,
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

  let client = relayClients.get(wsURL);
  if (!client) {
    client = new RelaySocketClient(wsURL);
    relayClients.set(wsURL, client);
  }
  return client.request<T>(requestFrame, 5 * 60 * 1000, onChunk);
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
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/tunnel/mobile/${agentId}`;
  url.searchParams.set('token', relayToken);
  return url.toString();
}

function decodeBase64URL(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');

  if (typeof globalThis.atob === 'function') {
    return globalThis.atob(padded);
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  let buffer = 0;
  let bits = 0;

  for (const char of padded) {
    if (char === '=') {
      break;
    }
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error('Pairing payload is not valid base64');
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }

  return output;
}
