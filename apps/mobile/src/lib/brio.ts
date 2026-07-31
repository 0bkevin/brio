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

export type HermesSession = {
  id: string;
  source: string;
  user_id?: string;
  model?: string;
  started_at: number;
  ended_at?: number | null;
  message_count: number;
  title?: string;
};

export type HermesMessage = {
  role: string;
  content: string;
  tool_name?: string;
  timestamp: number;
};

export type HermesSearchResult = {
  session_id: string;
  role: string;
  snippet: string;
};

export type HermesRunStatus = {
  object: 'hermes.run';
  run_id: string;
  status:
    | 'started'
    | 'queued'
    | 'running'
    | 'waiting_for_approval'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'cancelled';
  session_id?: string;
  model?: string;
  output?: string;
  error?: string;
  last_event?: string;
  created_at?: number;
  updated_at?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

export type HermesRunStart = {
  run_id: string;
  status: 'started';
};

export type HermesFileEntry = {
  name: string;
  path: string;
  dir: boolean;
  size: number;
};

export type HermesSkill = {
  name: string;
  category: string;
  path: string;
  description: string;
  enabled: boolean;
};

export type HermesJob = Record<string, unknown> & {
  id?: string;
  job_id?: string;
  name?: string;
  prompt?: string;
  enabled?: boolean;
  paused?: boolean;
  schedule?: string;
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

async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMilliseconds = 15_000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (reason) {
    if (controller.signal.aborted) {
      throw new Error('Connection timed out');
    }
    throw reason;
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds = 15_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Connection timed out')), timeoutMilliseconds);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

export function listSessions(connection: AgentConnection, limit = 100) {
  return brioFetch<{ sessions: HermesSession[]; error?: string }>(
    connection,
    `/sessions?limit=${limit}`,
  );
}

export function searchSessions(connection: AgentConnection, query: string) {
  return brioFetch<{ results: HermesSearchResult[]; error?: string }>(
    connection,
    `/sessions/search?q=${encodeURIComponent(query)}&limit=100`,
  );
}

export function getSessionMessages(connection: AgentConnection, sessionId: string) {
  return brioFetch<{ messages: HermesMessage[]; error?: string }>(
    connection,
    `/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
}

export function startRun(
  connection: AgentConnection,
  input: string,
  options: {
    sessionId?: string;
    instructions?: string;
    model?: string;
    provider?: string;
    conversationHistory?: { role: string; content: string }[];
  } = {},
) {
  return brioFetch<HermesRunStart>(connection, '/runs', {
    method: 'POST',
    body: JSON.stringify({
      input,
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      ...(options.instructions ? { instructions: options.instructions } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.conversationHistory
        ? { conversation_history: options.conversationHistory }
        : {}),
    }),
  });
}

export function getRun(connection: AgentConnection, runId: string) {
  return brioFetch<HermesRunStatus>(connection, `/runs/${encodeURIComponent(runId)}`);
}

export function approveRun(
  connection: AgentConnection,
  runId: string,
  choice: 'once' | 'session' | 'always' | 'deny',
) {
  return brioFetch<Record<string, unknown>>(
    connection,
    `/runs/${encodeURIComponent(runId)}/approval`,
    { method: 'POST', body: JSON.stringify({ choice }) },
  );
}

export function stopRun(connection: AgentConnection, runId: string) {
  return brioFetch<{ run_id: string; status: string }>(
    connection,
    `/runs/${encodeURIComponent(runId)}/stop`,
    { method: 'POST', body: '{}' },
  );
}

export function listFiles(connection: AgentConnection, path?: string) {
  return brioFetch<{
    path: string;
    entries: HermesFileEntry[];
    roots?: string[];
    error?: string;
  }>(connection, `/files${path ? `?path=${encodeURIComponent(path)}` : ''}`);
}

export function readFile(connection: AgentConnection, path: string) {
  return brioFetch<{ path: string; content: string }>(
    connection,
    `/files/read?path=${encodeURIComponent(path)}`,
  );
}

export function writeFile(connection: AgentConnection, path: string, content: string) {
  return brioFetch<{ ok: boolean }>(connection, '/files/write', {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  });
}

export function getMemory(connection: AgentConnection) {
  return brioFetch<{ memory: string; user: string }>(connection, '/memory');
}

export function updateMemory(
  connection: AgentConnection,
  value: { memory?: string; user?: string },
) {
  return brioFetch<{ ok: boolean }>(connection, '/memory', {
    method: 'PUT',
    body: JSON.stringify(value),
  });
}

export function getRawConfig(connection: AgentConnection) {
  return brioFetch<{ yaml: string; error?: string }>(connection, '/config/raw');
}

export function updateRawConfig(connection: AgentConnection, yaml: string) {
  return brioFetch<{ ok: boolean }>(connection, '/config/raw', {
    method: 'PUT',
    body: JSON.stringify({ yaml }),
  });
}

export function listSkills(connection: AgentConnection) {
  return brioFetch<{ skills: HermesSkill[] }>(connection, '/skills');
}

export function getToolsets(connection: AgentConnection) {
  return brioFetch<{ toolsets: Record<string, string[]>; error?: string }>(
    connection,
    '/tools/toolsets',
  );
}

export function updateToolset(
  connection: AgentConnection,
  name: string,
  enabled: boolean,
  platform = 'cli',
) {
  return brioFetch<{ ok: boolean; platform: string; toolsets: string[] }>(
    connection,
    `/tools/toolsets/${encodeURIComponent(name)}`,
    { method: 'PATCH', body: JSON.stringify({ enabled, platform }) },
  );
}

export function getGatewayStatus(connection: AgentConnection) {
  return brioFetch<{ running: boolean; status?: unknown; raw?: string }>(
    connection,
    '/gateway/status',
  );
}

export function restartGateway(connection: AgentConnection) {
  return brioFetch<{ ok: boolean; output?: string; error?: string }>(
    connection,
    '/gateway/restart',
    { method: 'POST', body: '{}' },
  );
}

export function getLogs(
  connection: AgentConnection,
  file: 'agent' | 'errors' | 'gateway' = 'agent',
  lines = 200,
) {
  return brioFetch<{ file: string; lines: string[] }>(
    connection,
    `/logs?file=${file}&lines=${lines}`,
  );
}

export function listJobs(connection: AgentConnection) {
  return brioFetch<HermesJob[] | { jobs: HermesJob[] }>(connection, '/jobs/');
}

export function runJobAction(
  connection: AgentConnection,
  jobId: string,
  action: 'pause' | 'resume' | 'trigger',
) {
  return brioFetch<Record<string, unknown>>(
    connection,
    `/jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: 'POST', body: '{}' },
  );
}

export function deleteJob(connection: AgentConnection, jobId: string) {
  return brioFetch<Record<string, unknown>>(
    connection,
    `/jobs/${encodeURIComponent(jobId)}`,
    { method: 'DELETE' },
  );
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
    return JSON.parse(decodeBase64URL(value)) as PairingPayload;
  }
}

export function extractPairingPayload(raw: string): PairingPayload {
  const value = raw.trim();
  if (!value) {
    throw new Error('Hermes reply is empty');
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
    throw new Error('Could not find a pairing payload or URL/token in the Hermes reply');
  }

  return {
    url: cleanConnectionValue(urlMatch[1] ?? urlMatch[0]),
    token: cleanConnectionValue(tokenMatch[1]),
    mode: 'direct',
    transport: 'direct',
  };
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

export type ConnectionProgress = 'claiming' | 'checking_companion' | 'checking_hermes' | 'ready';

export async function finalizeConnection(
  connection: AgentConnection,
  onProgress?: (progress: ConnectionProgress) => void,
) {
  let nextConnection = connection;

  if (connection.transport === 'relay') {
    onProgress?.('claiming');
    const session = await createRelayDevice(connection.url);
    if (!connection.pairingCode) {
      throw new Error('Relay pairing payload is missing a code');
    }
    const claim = await claimRelayPairing(connection.url, session.token, connection.pairingCode);
    nextConnection = {
      ...connection,
      id: claim.agent.id,
      name: claim.agent.name,
      status: claim.agent.status,
      relayToken: session.token,
      token: '',
    };
  }

  onProgress?.('checking_companion');
  const health = await withTimeout(getHealth(nextConnection));
  if (!health.ok) {
    throw new Error('Brio Companion did not report a healthy connection');
  }
  onProgress?.('checking_hermes');
  if (!health.hermes_ok) {
    throw new Error('Brio Companion is online, but Hermes Agent is not reachable');
  }
  onProgress?.('ready');
  return { ...nextConnection, status: 'online' as const };
}

export async function createRelayDevice(
  relayURL: string,
  email = 'dev@brio.local',
  deviceName = 'Brio mobile',
) {
  const response = await fetchWithTimeout(`${normalizeBaseURL(relayURL)}/auth/devices`, {
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
  const response = await fetchWithTimeout(
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
  name = 'Hermes',
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
