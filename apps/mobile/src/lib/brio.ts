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
  agentKind?: string;
  agentName?: string;
};

export type HealthResponse = {
  ok: boolean;
  agent_ok?: boolean;
  agent_kind?: string;
  agent_name?: string;
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
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (reason) {
    if (callerSignal?.aborted) {
      throw new Error('Connection cancelled');
    }
    if (controller.signal.aborted) {
      throw new Error('Connection timed out');
    }
    throw reason;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
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
  const response = await fetchWithTimeout(`${normalizeBaseURL(connection.url)}${path}`, {
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

export function getHealth(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  signal?: AbortSignal,
) {
  return brioFetch<HealthResponse>(connection, '/health', { signal });
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

function isPairingTransport(value: unknown): value is 'direct' | 'relay' {
  return value === 'direct' || value === 'relay';
}

function pairingPayloadFromUnknown(value: unknown): PairingPayload {
  if (!value || typeof value !== 'object') {
    throw new Error('Pairing details are not a valid object');
  }
  const candidate = value as Record<string, unknown>;
  const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
  const token = typeof candidate.token === 'string' ? candidate.token.trim() : '';
  const transport = candidate.transport ?? candidate.mode ?? 'direct';
  const code = typeof candidate.code === 'string' ? candidate.code.trim() : undefined;
  const agentId = typeof candidate.agent_id === 'string' ? candidate.agent_id.trim() : undefined;

  if (
    candidate.transport !== undefined &&
    candidate.mode !== undefined &&
    candidate.transport !== candidate.mode
  ) {
    throw new Error('Pairing details contain conflicting connection types');
  }

  if (!url) throw new Error('Pairing details do not include an address');
  let parsedURL: URL;
  try {
    parsedURL = new URL(url);
  } catch {
    throw new Error('Pairing details include an invalid address');
  }
  if (!['http:', 'https:'].includes(parsedURL.protocol) || !parsedURL.hostname) {
    throw new Error('Pairing details must use an HTTP or HTTPS address');
  }
  if (parsedURL.search || parsedURL.hash) {
    throw new Error('Pairing details include an invalid Companion address');
  }
  if (!isPairingTransport(transport)) {
    throw new Error('Pairing details include an unsupported connection type');
  }
  if (transport === 'direct' && !token) {
    throw new Error('Pairing details do not include a token');
  }
  if (transport === 'relay' && !code) {
    throw new Error('Relay pairing details do not include a claim code');
  }

  return {
    url: parsedURL.toString().replace(/\/$/, ''),
    token,
    mode: transport,
    transport,
    ...(agentId ? { agent_id: agentId } : {}),
    ...(code ? { code } : {}),
  };
}

export function decodePairingPayload(raw: string): PairingPayload {
  const value = raw.trim();
  if (!value) {
    throw new Error('Pairing payload is empty');
  }
  if (value.length > 65_536) {
    throw new Error('Pairing payload is too large');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    decoded = JSON.parse(decodeBase64URL(value));
  }
  return pairingPayloadFromUnknown(decoded);
}

export function extractPairingPayload(raw: string): PairingPayload {
  let value = raw.trim();
  if (!value) {
    throw new Error('Hermes reply is empty');
  }
  if (value.length > 65_536) {
    throw new Error('Pairing payload is too large');
  }

  try {
    const deepLink = new URL(value);
    if (deepLink.protocol === 'brio:') {
      value =
        deepLink.searchParams.get('pairingPayload')?.trim() ??
        deepLink.searchParams.get('payload')?.trim() ??
        '';
      if (!value) throw new Error('Brio pairing link does not contain pairing details');
    }
  } catch (reason) {
    if (/^brio:/i.test(value)) throw reason;
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
      return pairingPayloadFromUnknown(JSON.parse(jsonBlock));
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

  return pairingPayloadFromUnknown({
    url: cleanConnectionValue(urlMatch[1] ?? urlMatch[0]),
    token: cleanConnectionValue(tokenMatch[1]),
    mode: 'direct',
    transport: 'direct',
  });
}

export function connectionFromPairingPayload(payload: PairingPayload): AgentConnection {
  const transport = payload.transport ?? payload.mode ?? 'direct';
  const directId = `direct_${stableConnectionHash(payload.url)}`;
  return {
    id: payload.agent_id ?? directId,
    name: transport === 'direct' ? directConnectionName(payload.url) : 'Hermes',
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

export function normalizeConnectionURL(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const localHostname = /^(localhost|[^/:]+\.local)(?::\d+)?$/i.test(trimmed);
  return `${isPrivateNetworkLiteral(trimmed) || localHostname ? 'http' : 'https'}://${trimmed}`;
}

function isPrivateNetworkLiteral(host: string) {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
    if (hostname.includes(':')) {
      const normalized = hostname.toLowerCase();
      return (
        normalized === '::1' ||
        /^f[cd]/.test(normalized) ||
        /^fe[89ab]/.test(normalized)
      );
    }
    const octets = hostname.split('.');
    if (
      octets.length !== 4 ||
      !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    ) {
      return false;
    }
    const [first, second] = octets.map(Number);
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  } catch {
    return false;
  }
}

function stableConnectionHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function directConnectionName(value: string) {
  try {
    return new URL(value).hostname || 'Hermes';
  } catch {
    return 'Hermes';
  }
}

export type ConnectionProgress = 'claiming' | 'checking_companion' | 'checking_hermes' | 'ready';

export async function finalizeConnection(
  connection: AgentConnection,
  onProgress?: (progress: ConnectionProgress) => void,
  signal?: AbortSignal,
) {
  if (connection.transport === 'relay') {
    throw new Error('Development Relay pairing must be completed from the Relay screen');
  }

  onProgress?.('checking_companion');
  const health = await withTimeout(getHealth(connection, signal));
  if (!health.ok) {
    throw new Error('Brio Companion did not report a healthy connection');
  }
  onProgress?.('checking_hermes');
  const agentKind = health.agent_kind?.trim().toLowerCase() || 'hermes';
  if (agentKind !== 'hermes') {
    throw new Error(`${health.agent_name ?? agentKind} is not supported by this version of Brio`);
  }
  if (!(health.agent_ok ?? health.hermes_ok)) {
    throw new Error('Brio Companion is online, but Hermes Agent is not reachable');
  }
  onProgress?.('ready');
  return {
    ...connection,
    agentKind,
    agentName: health.agent_name ?? 'Hermes Agent',
    status: 'online' as const,
  };
}

export async function createRelayDevice(
  relayURL: string,
  email: string,
  deviceName = 'Brio mobile',
  signal?: AbortSignal,
) {
  const response = await fetchWithTimeout(`${normalizeBaseURL(relayURL)}/auth/devices`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, device_name: deviceName }),
    signal,
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
  signal?: AbortSignal,
) {
  const response = await fetchWithTimeout(
    `${normalizeBaseURL(relayURL)}/pairings/${encodeURIComponent(pairingCode)}/claim`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${relayToken}`,
      },
      signal,
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error ?? 'Could not claim pairing');
  }
  return body as RelayClaimResponse;
}

export async function listRelayAgents(relayURL: string, relayToken: string) {
  const response = await fetchWithTimeout(`${normalizeBaseURL(relayURL)}/agents`, {
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
  const response = await fetchWithTimeout(`${normalizeBaseURL(relayURL)}/enrollments`, {
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
  const response = await fetchWithTimeout(
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
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abortRequest);
      socket.close();
      callback();
    };
    const abortRequest = () => finish(() => reject(new Error('Connection cancelled')));
    const timeout = setTimeout(() => {
      finish(() => reject(new Error('Relay request timed out')));
    }, 30000);

    if (init.signal?.aborted) {
      abortRequest();
      return;
    }
    init.signal?.addEventListener('abort', abortRequest, { once: true });

    socket.onopen = () => {
      if (settled) return;
      socket.send(JSON.stringify(requestFrame));
    };
    socket.onerror = () => {
      finish(() => reject(new Error('Relay connection failed')));
    };
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as RelayFrame;
      if (frame.id !== frameId) {
        return;
      }
      if (frame.type === 'error') {
        finish(() => reject(new Error(frame.message ?? frame.code ?? 'Relay request failed')));
        return;
      }
      if ((frame.status ?? 500) >= 400) {
        const message =
          typeof frame.body === 'object' && frame.body && 'error' in frame.body
            ? String((frame.body as { error?: unknown }).error)
            : `Request failed: ${frame.status}`;
        finish(() => reject(new Error(message)));
        return;
      }
      finish(() => resolve(frame.body as T));
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
