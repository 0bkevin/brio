import { scopedPath } from './profiles-model.ts';
import { responseRequestBody, type ResponseRequestOptions } from './response-request.ts';
import type {
  HermesModelOptions,
  HermesSession as HermesAnalyticsSession,
  HermesSessionModelLock,
  HermesSessionModelPayload,
} from './hermes-api';
import {
  normalizeContextBreakdown,
  normalizeLiveUsage,
  normalizeModelOptions,
  type NormalizedContextBreakdown,
  type NormalizedRuntimeUsage,
} from './session-runtime.ts';

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
  hermes_control_configured?: boolean;
  service?: string;
  hermes?: unknown;
  allowed_roots?: string[];
};

export type CapabilitiesResponse = {
  companion?: Record<string, unknown>;
  hermes?: unknown;
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

export type HermesResponse = {
  id?: string;
  status?: string;
  model?: string;
  session_id?: string;
  output?: {
    type?: string;
    role?: string;
    content?: { type?: string; text?: string }[];
    name?: string;
  }[];
  output_text?: string;
  error?: { message?: string } | string;
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
  const response = await fetchWithTimeout(
    `${normalizeBaseURL(connection.url)}${path}`,
    {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
        ...(init.headers ?? {}),
      },
    },
    requestTimeoutForPath(path),
  );
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.error ?? body?.message ?? `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function requestTimeoutForPath(path: string) {
  return path.includes('/v1/responses') || path.includes('/composer/commands/dispatch')
    ? 5 * 60_000
    : path.startsWith('/control/') || path.includes('/control/')
      ? 60_000
      : 15_000;
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

export function getComposerCapabilities(connection: AgentConnection, profile?: string) {
  return brioFetch<ComposerCapabilities>(connection, scopedPath('/composer/capabilities', profile));
}

export function createAttachmentUpload(
  connection: AgentConnection,
  value: { sessionId: string; name: string; mimeType: string; size: number },
  signal?: AbortSignal,
  profile?: string,
) {
  return brioFetch<ComposerAttachmentUpload>(connection, scopedPath('/attachments', profile), {
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
  profile?: string,
) {
  return brioFetch<ComposerAttachmentUpload>(
    connection,
    scopedPath(`/attachments/${encodeURIComponent(attachmentId)}/chunks/${index}`, profile),
    {
      method: 'PUT',
      signal,
      body: JSON.stringify({ data_base64: dataBase64, final }),
    },
  );
}

export function deleteAttachmentUpload(
  connection: AgentConnection,
  attachmentId: string,
  profile?: string,
) {
  return brioFetch<{ deleted: boolean }>(
    connection,
    scopedPath(`/attachments/${encodeURIComponent(attachmentId)}`, profile),
    { method: 'DELETE' },
  );
}

export function getCommandCatalog(connection: AgentConnection, profile?: string) {
  return brioFetch<CommandCatalog>(connection, scopedPath('/composer/commands', profile));
}

export function completeSlashCommand(connection: AgentConnection, text: string, profile?: string) {
  return brioFetch<{ items: ComposerCompletion[] }>(
    connection,
    scopedPath('/composer/commands/complete', profile),
    { method: 'POST', body: JSON.stringify({ text }) },
  );
}

export function completeContextReference(connection: AgentConnection, query: string, profile?: string) {
  return brioFetch<{ items: ComposerCompletion[] }>(
    connection,
    scopedPath('/composer/context/complete', profile),
    { method: 'POST', body: JSON.stringify({ query }) },
  );
}

export function dispatchComposerCommand(
  connection: AgentConnection,
  sessionId: string,
  text: string,
  requestId: string,
  profile?: string,
) {
  return brioFetch<Record<string, unknown>>(
    connection,
    scopedPath('/composer/commands/dispatch', profile),
    { method: 'POST', body: JSON.stringify({ session_id: sessionId, text, request_id: requestId }) },
  );
}

export function prepareComposerPrompt(
  connection: AgentConnection,
  input: string,
  sessionId: string,
  attachments: string[],
  profile?: string,
) {
  return brioFetch<{ input: unknown }>(connection, scopedPath('/composer/prepare', profile), {
    method: 'POST',
    body: JSON.stringify({ input, session_id: sessionId, attachments }),
  });
}

export function interruptComposerSession(connection: AgentConnection, sessionId: string, profile?: string) {
  return brioFetch<{ ok: boolean }>(connection, scopedPath('/composer/redirect', profile), {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId }),
  });
}

export function listSessions(connection: AgentConnection, limit = 100, profile?: string) {
  return brioFetch<{ sessions: HermesSession[]; error?: string }>(
    connection,
    `${scopedPath('/sessions', profile)}?limit=${limit}`,
  );
}

export function searchSessions(connection: AgentConnection, query: string, profile?: string) {
  return brioFetch<{ results: HermesSearchResult[]; error?: string }>(
    connection,
    `${scopedPath('/sessions/search', profile)}?q=${encodeURIComponent(query)}&limit=100`,
  );
}

export function getSessionMessages(connection: AgentConnection, sessionId: string, profile?: string) {
  return brioFetch<{ messages: HermesMessage[]; error?: string }>(
    connection,
    scopedPath(`/sessions/${encodeURIComponent(sessionId)}/messages`, profile),
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
    modelOptions?: Record<string, unknown>;
    profile?: string;
    conversationHistory?: { role: string; content: string }[];
  } = {},
) {
  return brioFetch<HermesRunStart>(connection, scopedPath('/runs', options.profile), {
    method: 'POST',
    body: JSON.stringify({
      input,
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      ...(options.instructions ? { instructions: options.instructions } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.modelOptions ? { model_options: options.modelOptions } : {}),
      ...(options.conversationHistory
        ? { conversation_history: options.conversationHistory }
        : {}),
    }),
  });
}

export function getRun(connection: AgentConnection, runId: string, profile?: string) {
  return brioFetch<HermesRunStatus>(connection, scopedPath(`/runs/${encodeURIComponent(runId)}`, profile));
}

export function approveRun(
  connection: AgentConnection,
  runId: string,
  choice: 'once' | 'session' | 'always' | 'deny',
  profile?: string,
) {
  return brioFetch<Record<string, unknown>>(
    connection,
    scopedPath(`/runs/${encodeURIComponent(runId)}/approval`, profile),
    { method: 'POST', body: JSON.stringify({ choice }) },
  );
}

export function stopRun(connection: AgentConnection, runId: string, profile?: string) {
  return brioFetch<{ run_id: string; status: string }>(
    connection,
    scopedPath(`/runs/${encodeURIComponent(runId)}/stop`, profile),
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

export async function listModelSessions(
  connection: AgentConnection,
  limit = 200,
  profile?: string,
) {
  const result = await brioFetch<{ data?: HermesAnalyticsSession[] }>(
    connection,
    `${scopedPath('/api/sessions', profile)}?limit=${limit}`,
  );
  return { sessions: Array.isArray(result.data) ? result.data : [] };
}

export async function getModelOptions(
  connection: AgentConnection,
  refresh = false,
  profile?: string,
): Promise<HermesModelOptions> {
  const result = await brioFetch<unknown>(
    connection,
    `${scopedPath('/api/model/options', profile)}${refresh ? '?refresh=1' : ''}`,
  );
  return normalizeModelOptions(result);
}

export function setSessionModel(
  connection: AgentConnection,
  sessionId: string,
  payload: HermesSessionModelPayload,
  profile?: string,
) {
  return brioFetch<HermesSessionModelLock>(
    connection,
    scopedPath(`/api/sessions/${encodeURIComponent(sessionId)}/model`, profile),
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export async function getSessionUsage(
  connection: AgentConnection,
  sessionId: string,
  profile?: string,
): Promise<NormalizedRuntimeUsage> {
  const result = await controlRPC<unknown>(
    connection,
    'session.usage',
    { session_id: sessionId },
    false,
    sessionId,
    profile,
  );
  return normalizeLiveUsage(result);
}

export async function getSessionContextBreakdown(
  connection: AgentConnection,
  sessionId: string,
  profile?: string,
): Promise<NormalizedContextBreakdown | undefined> {
  const result = await controlRPC<unknown>(
    connection,
    'session.context_breakdown',
    { session_id: sessionId },
    false,
    sessionId,
    profile,
  );
  return normalizeContextBreakdown(result);
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

export function filterAgentsForControlSession(
  agents: readonly HermesSubagent[],
  events: readonly HermesControlEvent[],
  runtimeSessionId: string,
) {
  const observed = new Set(
    events
      .filter((event) => event.session_id === runtimeSessionId)
      .map((event) =>
        typeof event.payload?.subagent_id === 'string' ? event.payload.subagent_id : '',
      )
      .filter(Boolean),
  );
  return agents
    .filter((agent) =>
      agent.owner_session_id
        ? agent.owner_session_id === runtimeSessionId
        : observed.has(agent.subagent_id),
    )
    .map((agent) => ({ ...agent, owner_session_id: runtimeSessionId }));
}

export function parseGoalStatus(value: string): HermesGoalStatus | null {
  const detail = value.replace(/\r/g, '').trim();
  const statusLine = detail.split('\n')[0]?.trim() ?? '';
  if (!statusLine || /^No (?:active )?goal\b/i.test(statusLine)) return null;
  let status: HermesGoalStatus['status'] | null = null;
  if (/^⊙ Goal\b/.test(statusLine)) status = 'active';
  else if (/^⏸ Goal\b/.test(statusLine)) status = 'paused';
  else if (/^⏳ Goal\b/.test(statusLine)) status = 'waiting';
  else if (/^✓ Goal done\b/.test(statusLine)) status = 'done';
  if (!status) return null;

  const marker = statusLine.indexOf('): ');
  const metadataStart = statusLine.indexOf('(');
  const metadata =
    metadataStart >= 0 && marker > metadataStart
      ? statusLine.slice(metadataStart + 1, marker)
      : '';
  const pausedReason = status === 'paused'
    ? metadata.match(/\s—\s(.+)$/)?.[1]?.trim()
    : undefined;
  if (status === 'paused' && pausedReason && pausedReason.toLowerCase() !== 'user-paused') {
    status = 'blocked';
  }
  const objective = marker >= 0
    ? detail.slice(marker + 3).trim()
    : detail.replace(/^\S+\s+Goal(?:\s+\w+)?\s*:?\s*/i, '').trim();
  const turns = metadata.match(/(\d+)\s*\/\s*(\d+)\s+turns?/i);
  const subgoals = metadata.match(/(\d+)\s+subgoals?/i);
  const gates = metadata.match(/(\d+)\s+gates?/i);
  return {
    status,
    objective,
    turnsUsed: turns ? Number(turns[1]) : undefined,
    maxTurns: turns ? Number(turns[2]) : undefined,
    subgoalCount: subgoals ? Number(subgoals[1]) : 0,
    subgoals: [],
    gateCount: gates ? Number(gates[1]) : 0,
    hasContract: /(?:^|[,\s])contract(?:[,\s]|$)/i.test(metadata),
    ...(pausedReason ? { pausedReason } : {}),
    detail,
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

export function parseHeartbeatStatus(value: string): HermesHeartbeatStatus | null {
  const detail = value.replace(/\r/g, '').trim().split('\n')[0]?.trim() ?? '';
  if (!detail || /^No heartbeat\b/i.test(detail)) return null;
  const active = detail.match(/^♥ Heartbeat \(every ([^,\)]+)(?:, next in ~?(\d+)s)?(?:, fired (\d+)[×x])?\): (.+)$/i);
  const paused = detail.match(/^⏸ Heartbeat \(paused, every ([^,\)]+)(?:, fired (\d+)[×x])?\): (.+)$/i);
  if (active) {
    return {
      status: 'active',
      interval: active[1],
      nextInSeconds: active[2] ? Number(active[2]) : undefined,
      fireCount: active[3] ? Number(active[3]) : 0,
      prompt: active[4],
      detail,
    };
  }
  if (paused) {
    return {
      status: 'paused',
      interval: paused[1],
      fireCount: paused[2] ? Number(paused[2]) : 0,
      prompt: paused[3],
      detail,
    };
  }
  return null;
}

export function aggregateRootAgentUsage(agents: readonly HermesSubagent[]) {
  // A missing parent row usually means the bounded event window rolled it
  // off. Treating that orphan as a root double-counts a descendant rollup.
  const roots = agents.filter((agent) => !agent.parent_id);
  return roots.reduce(
    (total, agent) => ({
      inputTokens: total.inputTokens + (agent.input_tokens ?? 0),
      outputTokens: total.outputTokens + (agent.output_tokens ?? 0),
      costUsd: total.costUsd + (agent.cost_usd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
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

export async function sendComposerResponse(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  prompt: unknown,
  options: ResponseRequestOptions & {
    profile?: string;
    composerSessionId?: string;
    attachmentIds?: string[];
  } = {},
) {
  return brioFetch<HermesResponse>(connection, scopedPath('/v1/responses', options.profile), {
    method: 'POST',
    body: JSON.stringify(responseRequestBody(prompt, options, false)),
    ...(options.sessionId
      ? { headers: { 'X-Hermes-Session-Id': options.sessionId } }
      : {}),
  });
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
  return error?.trim() || 'Hermes completed the request without a text response.';
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
    throw new Error('Pairing details include an invalid server address');
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
    throw new Error('The Brio connector did not report a healthy connection');
  }
  onProgress?.('checking_hermes');
  const agentKind = health.agent_kind?.trim().toLowerCase() || 'hermes';
  if (agentKind !== 'hermes') {
    throw new Error(`${health.agent_name ?? agentKind} is not supported by this version of Brio`);
  }
  if (!(health.agent_ok ?? health.hermes_ok)) {
    throw new Error('The Brio connector is online, but Hermes Agent is not reachable');
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
    }, requestTimeoutForPath(path));

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
