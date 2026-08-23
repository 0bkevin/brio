import { fetch as expoFetch } from 'expo/fetch';

import {
  filterAgentsForControlSession,
  parseGoalStatus,
  parseHeartbeatStatus,
} from './control-model';
import {
  normalizeHermesSessionMessages,
  normalizeHermesSessions,
  SESSION_ID_HEADER,
  headerValue,
  mergeRequestHeaders,
  sessionIdentityHeaders,
  type HermesModelOptions,
  type HermesSession,
  type HermesSessionMessage,
  type HermesSessionModelLock,
  type HermesSessionModelPayload,
} from './hermes-api';
import { ResponsesSSEParser, type HermesResponse } from './responses-sse';
// Import the dependency-free model module: profiles.ts re-exports it, but
// importing from there would create a brio <-> profiles cycle.
import { scopedPath } from './profiles-model';
import {
  responseRequestBody,
  type ResponseRequestOptions,
} from './response-request';
import {
  normalizeContextBreakdown,
  normalizeLiveUsage,
  normalizeModelOptions,
  type NormalizedContextBreakdown,
  type NormalizedRuntimeUsage,
} from './session-runtime';

export {
  aggregateRootAgentUsage,
  filterAgentsForControlSession,
  parseGoalStatus,
  parseHeartbeatStatus,
} from './control-model';

export {
  normalizeContextBreakdown,
  normalizeLiveUsage,
  normalizeModelOptions,
} from './session-runtime';

export type { HermesResponse } from './responses-sse';
export type { NormalizedContextBreakdown, NormalizedRuntimeUsage } from './session-runtime';
export type {
  HermesContextBreakdown,
  HermesLiveUsage,
  HermesModelOptions,
  HermesSession,
  HermesSessionMessage,
  HermesSessionModelLock,
  HermesSessionModelPayload,
} from './hermes-api';

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
  hermes_control_configured?: boolean;
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

export type ComposerAttachmentUpload = {
  id: string;
  session_id: string;
  name: string;
  mime_type: string;
  kind: 'image' | 'file';
  size: number;
  received: number;
  next_chunk: number;
  sha256?: string;
  complete: boolean;
  created_at: number;
};

export type ComposerCapabilities = {
  attachment_chunk_bytes: number;
  attachment_file_bytes: number;
  attachment_total_bytes: number;
  attachment_max_count: number;
  context_item_bytes: number;
  context_soft_bytes: number;
  context_hard_bytes: number;
  context_max_references: number;
  folder_entries: number;
  attachment_kinds: ('image' | 'file')[];
  context_references: string[];
  redirect_mode: 'interrupt_then_redirect';
};

export type ComposerCompletion = {
  text: string;
  display?: string;
  meta?: string;
  kind?: string;
};

export type CommandCatalog = {
  pairs?: [string, string][];
  commands?: { name: string; description?: string; permission?: string }[];
  categories?: { name: string; pairs: [string, string][] }[];
  skills?: Record<string, { usage?: number; origin?: string }>;
  permissions?: Record<string, string>;
  warning?: string;
};

export type HermesControlSession = {
  id: string;
  title?: string;
  preview?: string;
  started_at?: number;
  message_count?: number;
  source?: string;
};

export type HermesGoalStatus = {
  status: 'active' | 'paused' | 'blocked' | 'waiting' | 'done';
  objective: string;
  turnsUsed?: number;
  maxTurns?: number;
  subgoalCount: number;
  subgoals: string[];
  gateCount: number;
  hasContract: boolean;
  pausedReason?: string;
  detail: string;
};

export type HermesHeartbeatStatus = {
  status: 'active' | 'paused';
  prompt: string;
  interval: string;
  nextInSeconds?: number;
  fireCount: number;
  detail: string;
  lastError?: string;
};

export type HermesSubagent = Record<string, unknown> & {
  subagent_id: string;
  owner_session_id?: string;
  parent_id?: string | null;
  child_session_id?: string;
  depth?: number;
  goal?: string;
  model?: string;
  status?: string;
  started_at?: number;
  tool_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  files_read?: string[];
  files_written?: string[];
  summary?: string;
  last_event?: string;
};

export type HermesBackgroundProcess = Record<string, unknown> & {
  session_id?: string;
  process_id?: string;
  pid?: number;
  command?: string;
  status?: string;
  running?: boolean;
  exit_code?: number | null;
  output_tail?: string;
};

export type HermesBackgroundTask = {
  task_id: string;
  session_id: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  started_at: number;
  finished_at?: number;
  output?: string;
};

export type HermesControlEvent = {
  sequence: number;
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
};

export type HermesCommandCenterSnapshot = {
  runtimeSessionId: string;
  goal: HermesGoalStatus | null;
  heartbeat: HermesHeartbeatStatus | null;
  agents: HermesSubagent[];
  spawningPaused: boolean;
  maxSpawnDepth?: number;
  maxConcurrentChildren?: number;
  processes: HermesBackgroundProcess[];
  backgroundTasks: HermesBackgroundTask[];
  sessionInfo?: Record<string, unknown>;
  events: HermesControlEvent[];
  latestEvent: number;
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

export function getComposerCapabilities(connection: AgentConnection) {
  return brioFetch<ComposerCapabilities>(connection, '/composer/capabilities');
}

export function createAttachmentUpload(
  connection: AgentConnection,
  value: { sessionId: string; name: string; mimeType: string; size: number },
  signal?: AbortSignal,
) {
  return brioFetch<ComposerAttachmentUpload>(connection, '/attachments', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      session_id: value.sessionId,
      name: value.name,
      mime_type: value.mimeType,
      size: value.size,
    }),
  });
}

export function uploadAttachmentChunk(
  connection: AgentConnection,
  attachmentId: string,
  index: number,
  dataBase64: string,
  final: boolean,
  signal?: AbortSignal,
) {
  return brioFetch<ComposerAttachmentUpload>(
    connection,
    `/attachments/${encodeURIComponent(attachmentId)}/chunks/${index}`,
    {
      method: 'PUT',
      signal,
      body: JSON.stringify({ data_base64: dataBase64, final }),
    },
  );
}

export function deleteAttachmentUpload(connection: AgentConnection, attachmentId: string) {
  return brioFetch<{ deleted: boolean }>(
    connection,
    `/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' },
  );
}

export function getCommandCatalog(connection: AgentConnection) {
  return brioFetch<CommandCatalog>(connection, '/composer/commands');
}

export function completeSlashCommand(connection: AgentConnection, text: string) {
  return brioFetch<{ items: ComposerCompletion[] }>(connection, '/composer/commands/complete', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export function completeContextReference(connection: AgentConnection, query: string) {
  return brioFetch<{ items: ComposerCompletion[] }>(connection, '/composer/context/complete', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

export function dispatchComposerCommand(
  connection: AgentConnection,
  sessionId: string,
  text: string,
  requestId: string,
) {
  return brioFetch<Record<string, unknown>>(connection, '/composer/commands/dispatch', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, text, request_id: requestId }),
  });
}

export function prepareComposerPrompt(
  connection: AgentConnection,
  input: string,
  sessionId: string,
  attachments: string[],
) {
  return brioFetch<{ input: unknown }>(connection, '/composer/prepare', {
    method: 'POST',
    body: JSON.stringify({ input, session_id: sessionId, attachments }),
  });
}

export function interruptComposerSession(connection: AgentConnection, sessionId: string) {
  return brioFetch<{ ok: boolean }>(connection, '/composer/redirect', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId }),
  });
}

export function controlRPC<T>(
  connection: AgentConnection,
  method: string,
  params: Record<string, unknown> = {},
  confirm = false,
  runtimeSessionId?: string,
  profile?: string,
) {
  return brioFetch<T>(connection, scopedPath('/control/rpc', profile), {
    method: 'POST',
    body: JSON.stringify({
      method,
      params,
      ...(confirm ? { confirm: true } : {}),
      ...(runtimeSessionId ? { runtime_session_id: runtimeSessionId } : {}),
    }),
  });
}

export function listControlSessions(connection: AgentConnection, limit = 100, profile?: string) {
  return controlRPC<{ sessions: HermesControlSession[] }>(connection, 'session.list', { limit }, false, undefined, profile);
}

export function executeControlCommand(
  connection: AgentConnection,
  sessionId: string,
  command: string,
  confirm = false,
  profile?: string,
) {
  return brioFetch<{
    result: { output?: string; notice?: string; type?: string };
    kickoff?: Record<string, unknown>;
    runtime_session_id?: string;
    heartbeat?: HermesHeartbeatStatus | null;
  }>(connection, scopedPath('/control/command', profile), {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, command, ...(confirm ? { confirm: true } : {}) }),
  });
}

export function startBackgroundTask(
  connection: AgentConnection,
  sessionId: string,
  text: string,
  profile?: string,
) {
  return brioFetch<{ task_id: string }>(connection, scopedPath('/control/background', profile), {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, text }),
  });
}

export function listControlEvents(
  connection: AgentConnection,
  after = 0,
  session?: { storedSessionId: string; runtimeSessionId: string },
  profile?: string,
) {
  const sessionQuery = session
    ? `&stored_session_id=${encodeURIComponent(session.storedSessionId)}&runtime_session_id=${encodeURIComponent(session.runtimeSessionId)}`
    : '';
  return brioFetch<{
    events: HermesControlEvent[];
    latest: number;
    background_tasks?: HermesBackgroundTask[];
  }>(
    connection,
    `${scopedPath('/control/events', profile)}?after=${Math.max(0, Math.floor(after))}${sessionQuery}`,
  );
}

export async function getCommandCenterSnapshot(
  connection: AgentConnection,
  sessionId: string,
  profile?: string,
): Promise<HermesCommandCenterSnapshot> {
  const heartbeatCommand = await executeControlCommand(
    connection,
    sessionId,
    'heartbeat status',
    false,
    profile,
  );
  const runtimeSessionId = heartbeatCommand.runtime_session_id?.trim() || sessionId;
  // Hermes owns one slash worker per live session. Keep its commands ordered;
  // typed read-only RPCs can still fan out after the worker is hydrated.
  const goalResult = await controlRPC<{ output?: string }>(connection, 'slash.exec', {
    session_id: runtimeSessionId,
    command: 'goal status',
  }, false, undefined, profile);
  const subgoalResult = await controlRPC<{ output?: string }>(connection, 'slash.exec', {
    session_id: runtimeSessionId,
    command: 'subgoal',
  }, false, undefined, profile);
  const [delegation, processes, sessionStatus, eventResult] = await Promise.all([
      controlRPC<{
        active?: HermesSubagent[];
        paused?: boolean;
        max_spawn_depth?: number;
        max_concurrent_children?: number;
      }>(connection, 'delegation.status', {}, false, runtimeSessionId, profile),
      controlRPC<{ processes?: HermesBackgroundProcess[] }>(connection, 'process.list', {
        session_id: runtimeSessionId,
      }, false, undefined, profile),
      controlRPC<{ output?: string }>(connection, 'session.status', {
        session_id: runtimeSessionId,
      }, false, undefined, profile),
      listControlEvents(connection, 0, {
        storedSessionId: sessionId,
        runtimeSessionId,
      }, profile),
  ]);

  const scopedAgents = filterAgentsForControlSession(
    delegation.active ?? [],
    eventResult.events,
    runtimeSessionId,
  );

  return {
    runtimeSessionId,
    goal: withSubgoals(parseGoalStatus(goalResult.output ?? ''), subgoalResult.output ?? ''),
    heartbeat:
      heartbeatCommand.heartbeat ??
      parseHeartbeatStatus(heartbeatCommand.result.output ?? ''),
    agents: scopedAgents,
    spawningPaused: Boolean(delegation.paused),
    maxSpawnDepth: delegation.max_spawn_depth,
    maxConcurrentChildren: delegation.max_concurrent_children,
    processes: processes.processes ?? [],
    backgroundTasks: eventResult.background_tasks ?? [],
    sessionInfo: sessionStatus,
    events: eventResult.events,
    latestEvent: eventResult.latest,
  };
}

function withSubgoals(goal: HermesGoalStatus | null, output: string) {
  if (!goal) return null;
  const subgoals = output
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim().match(/^-\s*\d+\.\s+(.+)$/)?.[1]?.trim() ?? '')
    .filter(Boolean);
  return { ...goal, subgoalCount: Math.max(goal.subgoalCount, subgoals.length), subgoals };
}

export type { ResponseRequestOptions };

export async function sendResponse(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  prompt: string,
  options: ResponseRequestOptions & { profile?: string } = {},
) {
  const sessionHeaders = sessionIdentityHeaders(options.sessionId);
  return brioFetch<HermesResponse>(connection, scopedPath('/v1/responses', options.profile), {
    method: 'POST',
    body: JSON.stringify(responseRequestBody(prompt, options, false)),
    ...(sessionHeaders ? { headers: sessionHeaders } : {}),
  });
}

export async function sendResponseStream(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  prompt: unknown,
  options: ResponseRequestOptions & {
    onTextDelta?: (delta: string) => void;
    profile?: string;
    signal?: AbortSignal;
    composerSessionId?: string;
    attachmentIds?: string[];
  } = {},
) {
  const parser = new ResponsesSSEParser(options.onTextDelta);
  const body = JSON.stringify(responseRequestBody(prompt, options, true));
  const responsesPath = scopedPath('/v1/responses', options.profile);
  const sessionHeaders = sessionIdentityHeaders(options.sessionId);

  if (connection.transport === 'relay') {
    let terminalSessionId = '';
    await relayFetch<null>(
      connection,
      responsesPath,
      {
        method: 'POST',
        body,
        signal: options.signal,
        ...(sessionHeaders ? { headers: sessionHeaders } : {}),
      },
      (chunk) => parser.push(chunk),
      (headers) => {
        terminalSessionId = headerValue(headers, SESSION_ID_HEADER)?.trim() ?? '';
      },
    );
    return withFallbackSessionId(parser.finish(), terminalSessionId);
  }

  const response = await expoFetch(`${normalizeBaseURL(connection.url)}${responsesPath}`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`,
      ...(sessionHeaders ?? {}),
    },
    body,
    signal: options.signal,
  });
  const directSessionId = response.headers.get(SESSION_ID_HEADER)?.trim() ?? '';
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (!response.ok || !contentType.includes('text/event-stream')) {
    const text = await response.text();
    const result = text ? (JSON.parse(text) as HermesResponse) : null;
    if (!response.ok) {
      const error = typeof result?.error === 'string' ? result.error : result?.error?.message;
      throw new Error(error ?? `Request failed: ${response.status}`);
    }
    if (!result) throw new Error('Agent returned an empty response');
    return withFallbackSessionId(result, directSessionId);
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
  return withFallbackSessionId(parser.finish(), directSessionId);
}

// A session id from the body always wins; transport headers only fill the gap.
function withFallbackSessionId(response: HermesResponse, headerSessionId: string): HermesResponse {
  if (!response.session_id?.trim() && headerSessionId) {
    response.session_id = headerSessionId;
  }
  return response;
}

export async function listHermesSessions(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  limit = 60,
  profile?: string,
) {
  const result = await brioFetch<{ data?: HermesSession[] }>(
    connection,
    `${scopedPath('/api/sessions', profile)}?limit=${limit}`,
  );
  return normalizeHermesSessions(result);
}

export async function getHermesSessionMessages(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  sessionId: string,
  profile?: string,
) {
  const result = await brioFetch<{ data?: HermesSessionMessage[] }>(
    connection,
    scopedPath(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, profile),
  );
  return normalizeHermesSessionMessages(result);
}

export async function listHermesModelOptions(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  refresh = false,
  profile?: string,
): Promise<HermesModelOptions> {
  const result = await brioFetch<unknown>(
    connection,
    `${scopedPath('/api/model/options', profile)}${refresh ? '?refresh=1' : ''}`,
  );
  return normalizeModelOptions(result);
}

export async function getHermesSession(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  sessionId: string,
): Promise<HermesSession> {
  if (!sessionId.trim()) {
    throw new Error('getHermesSession requires a non-empty session id');
  }
  const result = await brioFetch<{ session?: HermesSession } | HermesSession>(
    connection,
    `/api/sessions/${encodeURIComponent(sessionId)}`,
  );
  const session =
    typeof result === 'object' && result !== null && 'session' in result && result.session
      ? result.session
      : (result as HermesSession);
  if (!session || typeof session !== 'object' || typeof session.id !== 'string') {
    throw new Error(`getHermesSession received no valid session for id ${sessionId}`);
  }
  return session;
}

export async function setHermesSessionModel(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  sessionId: string,
  payload: HermesSessionModelPayload,
): Promise<HermesSessionModelLock> {
  if (!sessionId.trim()) {
    throw new Error('setHermesSessionModel requires a non-empty session id');
  }
  return brioFetch<HermesSessionModelLock>(
    connection,
    `/api/sessions/${encodeURIComponent(sessionId)}/model`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

// Control-RPC reads for live session telemetry. These intentionally surface
// failures (unknown method, offline agent, ...) so the UI can mark the data
// as unavailable instead of guessing.
export async function getSessionUsage(
  connection: AgentConnection,
  runtimeSessionId: string,
  profile?: string,
): Promise<NormalizedRuntimeUsage> {
  const result = await controlRPC<unknown>(connection, 'session.usage', {
    session_id: runtimeSessionId,
  }, false, runtimeSessionId, profile);
  return normalizeLiveUsage(result);
}

export async function getSessionContextBreakdown(
  connection: AgentConnection,
  runtimeSessionId: string,
  profile?: string,
): Promise<NormalizedContextBreakdown | undefined> {
  const result = await controlRPC<unknown>(connection, 'session.context_breakdown', {
    session_id: runtimeSessionId,
  }, false, runtimeSessionId, profile);
  return normalizeContextBreakdown(result);
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
  identityToken?: string,
) {
  const response = await fetch(`${normalizeBaseURL(relayURL)}/auth/devices`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(identityToken ? { Authorization: `Bearer ${identityToken}` } : {}),
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
  onTerminalHeaders?: (headers: Record<string, string>) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

const relayClients = new Map<string, RelaySocketClient>();
const RELAY_TUNNEL_SUBPROTOCOL = 'brio.tunnel.v1';
const RELAY_MOBILE_AUTH_SUBPROTOCOL = 'brio.mobile.auth.';

class RelaySocketClient {
  private readonly wsURL: string;
  private readonly authSubprotocol: string;
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private pending = new Map<string, PendingRelayRequest>();

  constructor(wsURL: string, relayToken: string) {
    this.wsURL = wsURL;
    if (!/^[A-Za-z0-9._~-]+$/.test(relayToken)) {
      throw new Error('Relay device token cannot be used as a WebSocket credential');
    }
    this.authSubprotocol = `${RELAY_MOBILE_AUTH_SUBPROTOCOL}${relayToken}`;
  }

  request<T>(
    frame: RelayFrame,
    timeoutMs = 5 * 60 * 1000,
    onChunk?: (chunk: string) => void,
    onTerminalHeaders?: (headers: Record<string, string>) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.connect().then(
      () =>
        new Promise<T>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('Relay request cancelled'));
            return;
          }
          const socket = this.socket;
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            reject(new Error('Relay connection is not open'));
            return;
          }

          const timer = setTimeout(() => {
            if (this.pending.has(frame.id)) {
              this.clearPending(frame.id);
              reject(new Error('Relay request timed out'));
            }
          }, timeoutMs);

          const abort = () => {
            if (!this.pending.has(frame.id)) return;
            this.clearPending(frame.id);
            reject(new Error('Relay request cancelled'));
          };

          this.pending.set(frame.id, {
            resolve: (value) => resolve(value as T),
            reject,
            timer,
            chunks: [],
            onChunk,
            onTerminalHeaders,
            signal,
            abort,
          });
          signal?.addEventListener('abort', abort, { once: true });

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
      // Browsers cannot attach Authorization to a WebSocket upgrade. Negotiate
      // the device credential as a role-bound subprotocol so it never appears
      // in the URL or load-balancer request-target logs.
      const socket = new WebSocket(this.wsURL, [RELAY_TUNNEL_SUBPROTOCOL, this.authSubprotocol]);
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
      pending.onTerminalHeaders?.(frame.headers ?? {});
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
      if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
      this.pending.delete(id);
    }
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
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
  onTerminalHeaders?: (headers: Record<string, string>) => void,
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
  const wsURL = relayTunnelURL(connection.url, agentId);
  const body =
    typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : null;
  const requestFrame: RelayFrame = {
    type: 'request',
    id: frameId,
    method: init.method ?? 'GET',
    path,
    // Caller headers ride along on top of the agent Authorization instead of
    // being discarded (for example X-Hermes-Session-Id).
    headers: mergeRequestHeaders(`Bearer ${connection.token}`, init.headers),
    body,
  };

  const clientKey = `${wsURL}\u0000${relayToken}`;
  let client = relayClients.get(clientKey);
  if (!client) {
    client = new RelaySocketClient(wsURL, relayToken);
    relayClients.set(clientKey, client);
  }
  return client.request<T>(
    requestFrame,
    5 * 60 * 1000,
    onChunk,
    onTerminalHeaders,
    init.signal ?? undefined,
  );
}

function relayTunnelURL(baseURL: string, agentId: string) {
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
