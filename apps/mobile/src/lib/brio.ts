import { scopedPath } from './profiles-model.ts';
import { responseRequestBody, type ResponseRequestOptions } from './response-request.ts';
import {
  mergeRequestHeaders,
  type HermesModelOptions,
  type HermesSession as HermesAnalyticsSession,
  type HermesSessionModelLock,
  type HermesSessionModelPayload,
} from './hermes-api.ts';
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
  gatewayUrl?: string;
  gatewayToken?: string;
  agentId?: string;
  pairingCode?: string;
  agentKind?: string;
  agentName?: string;
};

export class BrioRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'BrioRequestError';
    this.status = status;
  }
}

export type HealthResponse = {
  ok?: boolean;
  status?: string;
  platform?: string;
  version?: string;
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
  features?: Record<string, unknown>;
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

export type HermesSessionCreateResponse = {
  object: 'hermes.session';
  session: HermesSession;
};

export type HermesMessage = {
  role: string;
  content: string;
  display_content?: string;
  display_kind?: string;
  tool_calls?: unknown[];
  tool_name?: string;
  timestamp: number;
};

export type HermesSearchResult = {
  session_id: string;
  role: string;
  snippet: string;
};

type HermesSessionListEnvelope = {
  sessions?: HermesSession[];
  data?: HermesSession[];
  total?: number;
  error?: string;
};

export type HermesSessionPage = {
  sessions: HermesSession[];
  hasMore: boolean;
  nextCursor?: string;
  continueWhenEmpty?: boolean;
  warning?: string;
};

type HermesMessageListEnvelope = {
  messages?: HermesMessage[];
  data?: HermesMessage[];
  error?: string;
};

export function normalizeSessionList(response: HermesSessionListEnvelope) {
  return { ...response, sessions: response.sessions ?? response.data ?? [] };
}

export function normalizeMessageList(response: HermesMessageListEnvelope) {
  const messages = response.messages ?? response.data ?? [];
  // Hermes' display-history endpoint can merge active and compacted rows in
  // storage order instead of conversation order. Only reorder complete
  // timestamped transcripts so legacy payloads without timestamps retain the
  // exact order supplied by their server.
  const orderedMessages = messages.every((message) => Number.isFinite(Number(message.timestamp)))
    ? [...messages].sort((left, right) => Number(left.timestamp) - Number(right.timestamp))
    : messages;
  return { ...response, messages: orderedMessages };
}

type HermesControlFileEntry = Omit<Partial<HermesFileEntry>, 'size'> & {
  is_directory?: boolean;
  size?: number | null;
};
type HermesControlFileList = {
  path: string;
  entries?: HermesControlFileEntry[];
  roots?: string[];
  root?: string | null;
  locked_root?: string | null;
  error?: string;
};

export function normalizeFileList(response: HermesControlFileList) {
  const roots = response.roots ?? [response.root, response.locked_root].filter(
    (value): value is string => Boolean(value),
  );
  return {
    ...response,
    entries: (response.entries ?? []).map((entry) => ({
      ...entry,
      name: entry.name ?? '',
      path: entry.path ?? '',
      dir: entry.dir ?? entry.is_directory ?? false,
      size: entry.size ?? 0,
    })),
    roots: Array.from(new Set(roots)),
  };
}

type HermesControlSkill = Partial<HermesSkill> & { provenance?: string };

export function normalizeSkills(response: HermesControlSkill[] | { skills?: HermesControlSkill[] }) {
  const skills = Array.isArray(response) ? response : (response.skills ?? []);
  return {
    skills: skills.map((skill) => ({
      name: skill.name ?? 'Unnamed skill',
      category: skill.category ?? '',
      path: skill.path ?? skill.provenance ?? skill.name ?? 'unknown',
      description: skill.description ?? '',
      enabled: skill.enabled ?? false,
    })),
  };
}

type HermesControlToolset = {
  name?: string;
  platform?: string;
  enabled?: boolean;
};

export function normalizeToolsets(
  response: HermesControlToolset[] | { toolsets?: Record<string, string[]>; error?: string },
) {
  if (!Array.isArray(response)) {
    return { toolsets: response.toolsets ?? {}, error: response.error };
  }
  const toolsets: Record<string, string[]> = {};
  for (const item of response) {
    if (!item.enabled || !item.name) continue;
    const platform = item.platform || 'cli';
    (toolsets[platform] ??= []).push(item.name);
  }
  return { toolsets };
}

export type HermesRunStatus = {
  object: 'hermes.run';
  run_id: string;
  status:
    | 'started'
    | 'queued'
    | 'running'
    | 'waiting_for_approval'
    | 'waiting_for_input'
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
  state?: string | null;
  schedule?: string | { kind?: string; expr?: string; run_at?: string; display?: string };
  schedule_display?: string | null;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
};

export type SessionListOptions = {
  source?: string;
  sources?: string[];
  excludeSources?: string[];
  order?: 'created' | 'recent';
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
  outputSessionId?: string;
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

function parseRelayURL(rawURL: string) {
  const normalized = normalizeBaseURL(rawURL);
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(normalized) ? normalized : `https://${normalized}`;
  const url = new URL(withScheme);
  if (!url.hostname || url.username || url.password) {
    throw new Error('Relay URL must include a host and must not include user info');
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Relay URL must use HTTP(S) or WebSocket transport');
  }
  if ((url.protocol === 'http:' || url.protocol === 'ws:') && !isLoopbackHostname(url.hostname)) {
    throw new Error('Relay URL must use HTTPS/WSS outside loopback');
  }
  url.search = '';
  url.hash = '';
  return url;
}

function relayHTTPBaseURL(rawURL: string) {
  const url = parseRelayURL(rawURL);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function isLoopbackHostname(rawHostname: string) {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true;
  const octets = hostname.split('.').map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
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
    throw new BrioRequestError(
      apiErrorMessage(body?.error ?? body?.message, `Request failed: ${response.status}`),
      response.status,
    );
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

export async function getHealth(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  signal?: AbortSignal,
) {
  return normalizeHealth(await brioFetch<HealthResponse>(connection, '/health', { signal }));
}

export async function getCapabilities(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
) {
  return normalizeCapabilities(await brioFetch<CapabilitiesResponse>(connection, '/capabilities'));
}

export function normalizeHealth(response: HealthResponse): HealthResponse {
  if (response.status !== 'ok' || response.platform !== 'hermes-agent') return response;
  return {
    ...response,
    ok: true,
    agent_ok: true,
    agent_kind: response.agent_kind ?? 'hermes',
    agent_name: response.agent_name ?? 'Hermes Agent',
    hermes_ok: true,
  };
}

export function normalizeCapabilities(response: CapabilitiesResponse): CapabilitiesResponse {
  if (response.companion || !response.features) return response;
  return { ...response, companion: response.features };
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

type SessionCursor = {
  offset: number;
  strategy: 'raw' | 'window';
  firstId?: string;
  lastId?: string;
};

function parseSessionCursor(cursor?: string): SessionCursor {
  if (!cursor) return { offset: 0, strategy: 'raw' };
  try {
    const parsed = JSON.parse(decodeURIComponent(cursor)) as {
      offset?: number;
      strategy?: 'raw' | 'window';
      firstId?: string;
      lastId?: string;
    };
    if (typeof parsed.offset === 'number' && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0) {
      return { offset: parsed.offset, strategy: parsed.strategy ?? 'raw', firstId: parsed.firstId, lastId: parsed.lastId };
    }
  } catch {
    // Accept the numeric cursor used by early development builds.
  }
  const offset = Number(cursor);
  return { offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0, strategy: 'raw' };
}

function makeSessionCursor(offset: number, lastId?: string, firstId?: string, strategy: 'raw' | 'window' = 'raw') {
  return encodeURIComponent(JSON.stringify({ offset, strategy, firstId, lastId }));
}

/**
 * Loads one stable page for automation feeds. The cursor is an opaque raw
 * session offset so it also works when an older Hermes relay ignores source
 * filters and Brio has to filter the compatibility page locally.
 */
export async function listAutomationSessionsPage(
  connection: AgentConnection,
  limit = 5,
  profile?: string,
  options: SessionListOptions = {},
  cursor?: string,
): Promise<HermesSessionPage> {
  const included = options.source
    ? new Set([options.source])
    : options.sources?.length
      ? new Set(options.sources)
      : null;
  const excluded = new Set(options.excludeSources ?? []);
  const hasSourceFilter = Boolean(included || excluded.size);
  const requestedLimit = Math.max(1, Math.min(limit, 100));
  const pageSize = hasSourceFilter ? 100 : requestedLimit;
  const maxCompatibilityPages = 10;
  const sessions: HermesSession[] = [];
  const seen = new Set<string>();
  const cursorState = parseSessionCursor(cursor);
  const windowMode = cursorState.strategy === 'window';
  let rawOffset = cursorState.offset;

  for (let pageIndex = 0; pageIndex < (hasSourceFilter && !windowMode ? maxCompatibilityPages : 1); pageIndex += 1) {
    const pageStart = rawOffset;
    const query = new URLSearchParams({
      limit: String(windowMode ? Math.min(100, pageStart + requestedLimit) : pageSize),
    });
    if (pageStart && !windowMode) query.set('offset', String(pageStart));
    if (options.source) query.set('source', options.source);
    if (options.sources?.length) query.set('sources', options.sources.join(','));
    if (options.excludeSources?.length) query.set('exclude_sources', options.excludeSources.join(','));
    if (options.order) query.set('order', options.order);

    const envelope = await brioFetch<HermesSessionListEnvelope>(
      connection,
      `${scopedPath('/api/sessions', profile)}?${query.toString()}`,
    );
    const rawPage = normalizeSessionList(envelope).sessions;
    if (!windowMode && (
      (cursorState.firstId && rawPage[0]?.id === cursorState.firstId)
      || (cursorState.lastId && rawPage[0]?.id === cursorState.lastId)
    )) {
      return { sessions: [], hasMore: false };
    }
    if (windowMode) {
      const page = rawPage.filter((session) =>
        (!included || included.has(session.source)) && !excluded.has(session.source));
      const window = page.slice(pageStart, pageStart + requestedLimit);
      const reachedReportedTotal = typeof envelope.total === 'number' && pageStart + window.length >= envelope.total;
      const hasMore = window.length > 0
        && !reachedReportedTotal
        && rawPage.length >= Math.min(100, pageStart + requestedLimit);
      return {
        sessions: window,
        hasMore,
        nextCursor: hasMore
          ? makeSessionCursor(pageStart + Math.max(window.length, 1), window.at(-1)?.id, window[0]?.id, 'window')
          : undefined,
      };
    }
    const page = rawPage;
    let consumed = 0;
    let sawUnseen = false;
    for (const session of page) {
      consumed += 1;
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sawUnseen = true;
      if ((!included || included.has(session.source)) && !excluded.has(session.source)) {
        sessions.push(session);
      }
      if (sessions.length >= requestedLimit) break;
    }

    const reachedReportedTotal = typeof envelope.total === 'number' && pageStart + page.length >= envelope.total;
    const pageHasMore = page.length >= pageSize && !reachedReportedTotal;
    if (sessions.length >= requestedLimit || !pageHasMore || !sawUnseen) {
      return {
        sessions,
        hasMore: pageHasMore && sawUnseen,
        continueWhenEmpty: hasSourceFilter && !windowMode,
        nextCursor:
          pageHasMore && sawUnseen
            ? makeSessionCursor(
                pageStart + Math.max(consumed, 1),
                page[Math.max(consumed, 1) - 1]?.id,
                page[0]?.id,
                hasSourceFilter && page.every((session) =>
                  (!included || included.has(session.source)) && !excluded.has(session.source))
                  ? 'window'
                  : 'raw',
              )
            : undefined,
      };
    }
    rawOffset = pageStart + page.length;
  }

  return {
    sessions,
    hasMore: false,
    warning: 'Older Hermes cannot safely paginate this filtered history beyond the scanned limit.',
  };
}

export async function listSessions(
  connection: AgentConnection,
  limit = 100,
  profile?: string,
  options: SessionListOptions = {},
) {
  // Older Hermes builds ignore source query parameters. Keep Brio's split
  // correct locally while retaining wire compatibility with those builds. If
  // a full page is filtered out, continue through bounded offset pages so a
  // busy automation history cannot hide later conversations (or vice versa).
  const included = options.source
    ? new Set([options.source])
    : options.sources?.length
      ? new Set(options.sources)
      : null;
  const excluded = new Set(options.excludeSources ?? []);
  const hasSourceFilter = Boolean(included || excluded.size);
  const requestedLimit = Math.max(0, limit);
  const pageSize = hasSourceFilter ? 100 : Math.min(100, Math.max(1, requestedLimit));
  // Legacy gateways require local filtering. Bound that compatibility scan to
  // 1,000 rows; if it is exhausted, fail visibly instead of presenting an
  // incorrect empty history or issuing an unbounded burst of requests.
  const maxCompatibilityPages = 10;
  const sessions: HermesSession[] = [];
  const seen = new Set<string>();
  let envelope: HermesSessionListEnvelope = {};
  let offset = 0;
  let exhausted = false;

  for (let pageIndex = 0; pageIndex < (hasSourceFilter ? maxCompatibilityPages : 1); pageIndex += 1) {
    const query = new URLSearchParams({ limit: String(requestedLimit === 0 ? 0 : pageSize) });
    if (offset) query.set('offset', String(offset));
    if (options.source) query.set('source', options.source);
    if (options.sources?.length) query.set('sources', options.sources.join(','));
    if (options.excludeSources?.length) query.set('exclude_sources', options.excludeSources.join(','));
    if (options.order) query.set('order', options.order);
    envelope = await brioFetch<HermesSessionListEnvelope>(
      connection,
      `${scopedPath('/api/sessions', profile)}?${query.toString()}`,
    );
    const page = normalizeSessionList(envelope).sessions;
    let sawUnseen = false;
    for (const session of page) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sawUnseen = true;
      if ((!included || included.has(session.source)) && !excluded.has(session.source)) {
        sessions.push(session);
      }
    }
    const reachedReportedTotal = typeof envelope.total === 'number' && offset + pageSize >= envelope.total;
    if (sessions.length >= requestedLimit || page.length < pageSize || !sawUnseen || requestedLimit === 0 || reachedReportedTotal) {
      exhausted = true;
      break;
    }
    offset += pageSize;
  }

  if (hasSourceFilter && !exhausted && sessions.length < requestedLimit) {
    throw new Error('Session history is too large to filter safely with this Hermes version. Update Hermes and try again.');
  }

  return {
    ...envelope,
    sessions: sessions.slice(0, requestedLimit),
  };
}

export function createSession(
  connection: AgentConnection,
  sessionId: string,
  profile?: string,
) {
  return brioFetch<HermesSessionCreateResponse>(
    connection,
    scopedPath('/api/sessions', profile),
    {
      method: 'POST',
      body: JSON.stringify({ id: sessionId, source: 'api_server' }),
    },
  );
}

export async function ensureSession(
  connection: AgentConnection,
  sessionId: string,
  profile?: string,
  modelPayload?: HermesSessionModelPayload,
) {
  let session: HermesSessionCreateResponse;
  try {
    session = await createSession(connection, sessionId, profile);
  } catch (createError) {
    try {
      session = await brioFetch<HermesSessionCreateResponse>(
        connection,
        scopedPath(`/api/sessions/${encodeURIComponent(sessionId)}`, profile),
      );
    } catch {
      throw createError;
    }
  }
  if (modelPayload) {
    await setSessionModel(connection, sessionId, modelPayload, profile);
  }
  return session;
}

export function searchSessions(connection: AgentConnection, query: string, profile?: string) {
  return brioFetch<{ results: HermesSearchResult[]; error?: string }>(
    connection,
    `${scopedPath('/api/sessions/search', profile)}?q=${encodeURIComponent(query)}&limit=100`,
  );
}

export async function getSessionMessages(connection: AgentConnection, sessionId: string, profile?: string) {
  const encodedSessionId = encodeURIComponent(sessionId);
  try {
    const response = await brioFetch<HermesMessageListEnvelope>(
      connection,
      `${scopedPath(`/api/sessions/${encodedSessionId}/display-messages`, profile)}?include_compacted=true&limit=500&order=latest`,
    );
    return normalizeMessageList(response);
  } catch {
    // Older connectors do not expose the display-history route. Keep their
    // active transcript usable while the UI recovers archived hits through
    // Hermes search.
    const response = await brioFetch<HermesMessageListEnvelope>(
      connection,
      `${scopedPath(`/api/sessions/${encodedSessionId}/messages`, profile)}?include_compacted=true&limit=500&order=latest`,
    );
    return normalizeMessageList(response);
  }
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
  return brioFetch<HermesRunStart>(connection, scopedPath('/v1/runs', options.profile), {
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
  return brioFetch<HermesRunStatus>(connection, scopedPath(`/v1/runs/${encodeURIComponent(runId)}`, profile));
}

// The REST run API is the documented degraded transport for Hermes runtimes
// without /api/ws. It remains event-driven through the native run SSE stream;
// conversation screens never return to fixed-interval status polling.
export function subscribeRunEvents(
  connection: AgentConnection,
  runId: string,
  profile: string | undefined,
  onEvent: () => void,
  onError?: (error: Error) => void,
) {
  const controller = new AbortController();
  const path = scopedPath(`/v1/runs/${encodeURIComponent(runId)}/events`, profile);
  const streamUntilStopped = async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      let buffer = '';
      let dataLines: string[] = [];
      const consume = (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line === '') {
            if (dataLines.length > 0) {
              attempt = 0;
              onEvent();
            }
            dataLines = [];
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      };
      try {
        if (connection.transport === 'relay') {
          await relayFetch<null>(
            connection,
            path,
            { method: 'GET', signal: controller.signal },
            consume,
            undefined,
            30 * 60_000,
          );
        } else {
          await streamDirectRunEvents(connection, path, controller.signal, consume);
        }
        if (controller.signal.aborted) break;
        onEvent();
      } catch (reason) {
        if (controller.signal.aborted) break;
        onError?.(reason instanceof Error ? reason : new Error(String(reason)));
      }
      const delay = Math.min(16_000, 500 * 2 ** Math.min(attempt, 5));
      attempt += 1;
      await waitForAbort(delay, controller.signal);
    }
  };
  void streamUntilStopped();
  return () => controller.abort();
}

function waitForAbort(delay: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delay);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function streamDirectRunEvents(
  connection: AgentConnection,
  path: string,
  signal: AbortSignal,
  onChunk: (chunk: string) => void,
) {
  const response = await fetch(`${normalizeBaseURL(connection.url)}${path}`, {
    method: 'GET',
    signal,
    headers: {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${connection.token}`,
    },
  });
  if (!response.ok) throw new Error(`Hermes run stream failed: ${response.status}`);
  if (!response.body) throw new Error('Hermes run stream is unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } finally {
    reader.releaseLock();
  }
}

export function approveRun(
  connection: AgentConnection,
  runId: string,
  choice: 'once' | 'session' | 'always' | 'deny',
  profile?: string,
) {
  return brioFetch<Record<string, unknown>>(
    connection,
    scopedPath(`/v1/runs/${encodeURIComponent(runId)}/approval`, profile),
    { method: 'POST', body: JSON.stringify({ choice }) },
  );
}

export function stopRun(connection: AgentConnection, runId: string, profile?: string) {
  return brioFetch<{ run_id: string; status: string }>(
    connection,
    scopedPath(`/v1/runs/${encodeURIComponent(runId)}/stop`, profile),
    { method: 'POST', body: '{}' },
  );
}

export async function listFiles(connection: AgentConnection, path?: string) {
  const response = await brioFetch<HermesControlFileList>(
    connection,
    `/files${path ? `?path=${encodeURIComponent(path)}` : ''}`,
  );
  return normalizeFileList(response);
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

export async function listSkills(connection: AgentConnection) {
  const response = await brioFetch<HermesControlSkill[] | { skills?: HermesControlSkill[] }>(
    connection,
    '/skills',
  );
  return normalizeSkills(response);
}

export async function getToolsets(connection: AgentConnection) {
  const response = await brioFetch<
    HermesControlToolset[] | { toolsets?: Record<string, string[]>; error?: string }
  >(
    connection,
    '/tools/toolsets',
  );
  return normalizeToolsets(response);
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

export async function getGatewayStatus(connection: AgentConnection) {
  const response = await brioFetch<{
    running?: boolean;
    gateway_running?: boolean;
    status?: unknown;
    raw?: string;
    [key: string]: unknown;
  }>(
    connection,
    '/gateway/status',
  );
  return { ...response, running: response.running ?? response.gateway_running ?? false };
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

export async function listJobs(connection: AgentConnection, profile?: string) {
  try {
    return await brioFetch<HermesJob[] | { jobs: HermesJob[] }>(
      connection,
      `${scopedPath('/api/cron/jobs', profile)}${automationProfileQuery(profile)}`,
    );
  } catch (error) {
    if (!isUnsupportedAutomationRoute(error)) throw error;
    return brioFetch<HermesJob[] | { jobs: HermesJob[] }>(
      connection,
      `${scopedPath('/jobs/', profile)}${automationProfileQuery(profile)}`,
    );
  }
}

type HermesJobRunsEnvelope = {
  runs?: HermesSession[];
  sessions?: HermesSession[];
  data?: HermesSession[];
  limit?: number;
  total?: number;
  has_more?: boolean;
  next_cursor?: string | null;
};

type HermesJobRunsResponse = HermesJobRunsEnvelope | HermesSession[];

function normalizeJobRuns(response: HermesJobRunsResponse): HermesJobRunsEnvelope & { runs: HermesSession[] } {
  if (Array.isArray(response)) return { runs: response };
  return {
    ...response,
    runs: response.runs ?? response.sessions ?? response.data ?? [],
  };
}

const JOB_RUN_FALLBACK_SCAN_LIMIT = 100;

export async function listJobRunsPage(
  connection: AgentConnection,
  jobId: string,
  limit = 5,
  profile?: string,
  cursor?: string,
): Promise<HermesSessionPage> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const cursorState = parseSessionCursor(cursor);
  const windowMode = Boolean(cursor && cursorState.strategy === 'window');
  const requestLimit = windowMode ? Math.min(100, cursorState.offset + boundedLimit) : boundedLimit;
  const query = new URLSearchParams({ limit: String(requestLimit) });
  query.set('profile', profileNameForAutomation(profile));
  if (cursorState.offset && !windowMode) query.set('offset', String(cursorState.offset));
  try {
    const result = normalizeJobRuns(await brioFetch<HermesJobRunsResponse>(
      connection,
      `${scopedPath(`/api/cron/jobs/${encodeURIComponent(jobId)}/runs`, profile)}?${query.toString()}`,
    ));
    const allRuns = result.runs ?? result.data ?? [];
    if (!windowMode && (
      (cursorState.firstId && allRuns[0]?.id === cursorState.firstId)
      || (cursorState.lastId && allRuns[0]?.id === cursorState.lastId)
    )) {
      return { sessions: [], hasMore: false };
    }
    const runs = windowMode ? allRuns.slice(cursorState.offset, cursorState.offset + boundedLimit) : allRuns;
    const hasMore = runs.length > 0 && (typeof result.has_more === 'boolean'
      ? result.has_more
      : typeof result.total === 'number'
        ? cursorState.offset + runs.length < result.total
        : allRuns.length >= requestLimit);
    return {
      sessions: runs,
      hasMore,
      nextCursor: hasMore
        ? makeSessionCursor(
          cursorState.offset + runs.length,
          runs.at(-1)?.id,
          runs[0]?.id,
          'window',
        )
        : undefined,
    };
  } catch (error) {
    if (!isUnsupportedAutomationRoute(error)) throw error;
    try {
      const result = normalizeJobRuns(await brioFetch<HermesJobRunsResponse>(
        connection,
        `${scopedPath(`/jobs/${encodeURIComponent(jobId)}/runs`, profile)}?${query.toString()}`,
      ));
      const allRuns = result.runs ?? result.data ?? [];
      if (!windowMode && (
        (cursorState.firstId && allRuns[0]?.id === cursorState.firstId)
        || (cursorState.lastId && allRuns[0]?.id === cursorState.lastId)
      )) {
        return { sessions: [], hasMore: false };
      }
      const runs = windowMode ? allRuns.slice(cursorState.offset, cursorState.offset + boundedLimit) : allRuns;
      const hasMore = runs.length > 0 && (typeof result.has_more === 'boolean'
        ? result.has_more
        : typeof result.total === 'number'
          ? cursorState.offset + runs.length < result.total
          : allRuns.length >= requestLimit);
      return {
        sessions: runs,
        hasMore,
        nextCursor: hasMore
          ? makeSessionCursor(
              cursorState.offset + Math.max(runs.length, 1),
              runs.at(-1)?.id,
              runs[0]?.id,
              'window',
            )
          : undefined,
      };
    } catch (legacyError) {
      if (!isUnsupportedAutomationRoute(legacyError)) throw legacyError;
      // Older gateways expose cron runs only through the shared session list.
      // Keep the raw-session cursor so a busy history cannot hide this job's
      // recent runs. The source page is deliberately larger than the UI page:
      // filtering after five rows could return an empty page even when the job
      // has a run immediately behind other jobs. Return every matching run in
      // this scan chunk so the cursor never skips matches that were fetched.
      const page = await listAutomationSessionsPage(
        connection,
        Math.max(boundedLimit, JOB_RUN_FALLBACK_SCAN_LIMIT),
        profile,
        { source: 'cron', order: 'recent' },
        cursor,
      );
      const prefix = `cron_${jobId}_`;
      return {
        sessions: page.sessions.filter((session) => session.id.startsWith(prefix)),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        continueWhenEmpty: true,
        warning: page.warning,
      };
    }
  }
}

export async function listJobRuns(connection: AgentConnection, jobId: string, limit = 20, profile?: string) {
  const page = await listJobRunsPage(connection, jobId, limit, profile);
  return { runs: page.sessions, limit: Math.max(1, Math.min(limit, 100)) };
}

export async function runJobAction(
  connection: AgentConnection,
  jobId: string,
  action: 'pause' | 'resume' | 'trigger',
  profile?: string,
) {
  try {
    return await brioFetch<Record<string, unknown>>(
      connection,
      `${scopedPath(`/api/cron/jobs/${encodeURIComponent(jobId)}/${action}`, profile)}${automationProfileQuery(profile)}`,
      { method: 'POST', body: '{}' },
    );
  } catch (error) {
    if (!isUnsupportedAutomationRoute(error)) throw error;
    return brioFetch<Record<string, unknown>>(
      connection,
      `${scopedPath(`/jobs/${encodeURIComponent(jobId)}/${action}`, profile)}${automationProfileQuery(profile)}`,
      { method: 'POST', body: '{}' },
    );
  }
}

export async function deleteJob(connection: AgentConnection, jobId: string, profile?: string) {
  try {
    return await brioFetch<Record<string, unknown>>(
      connection,
      `${scopedPath(`/api/cron/jobs/${encodeURIComponent(jobId)}`, profile)}${automationProfileQuery(profile)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (!isUnsupportedAutomationRoute(error)) throw error;
    return brioFetch<Record<string, unknown>>(
      connection,
      `${scopedPath(`/jobs/${encodeURIComponent(jobId)}`, profile)}${automationProfileQuery(profile)}`,
      { method: 'DELETE' },
    );
  }
}

function profileNameForAutomation(profile?: string) {
  return profile?.trim() || 'default';
}

function automationProfileQuery(profile?: string) {
  return `?profile=${encodeURIComponent(profileNameForAutomation(profile))}`;
}

function isUnsupportedAutomationRoute(error: unknown) {
  if (error instanceof BrioRequestError) {
    return error.status === 404 || /no route|not found/i.test(error.message);
  }
  // Relay gateways can surface the upstream route error as a plain Error,
  // without preserving the HTTP status frame.
  return error instanceof Error && /no route|not found/i.test(error.message);
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

export async function listControlSessions(connection: AgentConnection, limit = 100, profile?: string) {
  const result = await listSessions(connection, limit, profile, {
    excludeSources: ['cron', 'heartbeat', 'kanban', 'tool'],
    order: 'recent',
  });
  return { sessions: result.sessions as HermesControlSession[] };
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
  gateway_url?: string;
  gateway_token?: string;
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
  const gatewayURL = typeof candidate.gateway_url === 'string' ? candidate.gateway_url.trim() : '';
  const gatewayToken = typeof candidate.gateway_token === 'string' ? candidate.gateway_token.trim() : '';

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
  if (Boolean(gatewayURL) !== Boolean(gatewayToken)) {
    throw new Error('Direct gateway details require both an address and a token');
  }
  if (transport !== 'direct' && gatewayURL) {
    throw new Error('Gateway details are only valid for direct connections');
  }
  let normalizedGatewayURL: string | undefined;
  if (gatewayURL) {
    let parsedGatewayURL: URL;
    try {
      parsedGatewayURL = new URL(gatewayURL);
    } catch {
      throw new Error('Direct gateway details include an invalid address');
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsedGatewayURL.protocol) || !parsedGatewayURL.hostname) {
      throw new Error('Direct gateway details must use an HTTP(S) or WebSocket address');
    }
    if (parsedGatewayURL.search || parsedGatewayURL.hash || parsedGatewayURL.username || parsedGatewayURL.password) {
      throw new Error('Direct gateway details include an invalid server address');
    }
    normalizedGatewayURL = parsedGatewayURL.toString().replace(/\/$/, '');
  }

  return {
    url: parsedURL.toString().replace(/\/$/, ''),
    token,
    mode: transport,
    transport,
    ...(agentId ? { agent_id: agentId } : {}),
    ...(code ? { code } : {}),
    ...(normalizedGatewayURL ? { gateway_url: normalizedGatewayURL, gateway_token: gatewayToken } : {}),
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
    gatewayUrl: payload.gateway_url,
    gatewayToken: payload.gateway_token,
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
  identityToken?: string,
  signal?: AbortSignal,
) {
  const response = await fetchWithTimeout(`${relayHTTPBaseURL(relayURL)}/auth/devices`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(identityToken ? { Authorization: `Bearer ${identityToken}` } : {}),
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

export async function revokeRelayDevice(
  relayURL: string,
  relayToken: string,
  deviceID: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(
      `${relayHTTPBaseURL(relayURL)}/devices/${encodeURIComponent(deviceID)}`,
      {
        method: 'DELETE',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${relayToken}`,
        },
        signal: controller.signal,
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.error ?? 'Could not revoke relay device');
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function claimRelayPairing(
  relayURL: string,
  relayToken: string,
  pairingCode: string,
  signal?: AbortSignal,
) {
  const response = await fetchWithTimeout(
    `${relayHTTPBaseURL(relayURL)}/pairings/${encodeURIComponent(pairingCode)}/claim`,
    {
      method: 'POST',
      redirect: 'error',
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
  const response = await fetchWithTimeout(`${relayHTTPBaseURL(relayURL)}/agents`, {
    redirect: 'error',
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

export async function unlinkRelayAgent(
  relayURL: string,
  relayToken: string,
  agentID: string,
) {
  const response = await fetch(
    `${relayHTTPBaseURL(relayURL)}/agents/${encodeURIComponent(agentID)}`,
    {
      method: 'DELETE',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${relayToken}`,
      },
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? 'Could not unlink relay agent');
  }
  disconnectRelayAgentClient(relayURL, relayToken, agentID);
  return body?.agent as RelayAgent;
}

export async function createRelayEnrollment(
  relayURL: string,
  relayToken: string,
  name = 'Hermes',
) {
  const response = await fetchWithTimeout(`${relayHTTPBaseURL(relayURL)}/enrollments`, {
    method: 'POST',
    redirect: 'error',
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
    `${relayHTTPBaseURL(relayURL)}/agents/${encodeURIComponent(agentID)}/recover`,
    {
      method: 'POST',
      redirect: 'error',
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
  type:
    | 'request'
    | 'response'
    | 'stream_chunk'
    | 'stream_end'
    | 'error'
    | 'ping'
    | 'pong'
    | 'channel_open'
    | 'channel_opened'
    | 'channel_data'
    | 'channel_close'
    | 'channel_error';
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

export type RelayChannel = {
  send(data: string): Promise<void>;
  close(): void;
};

type RelayChannelCallbacks = {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: (error?: Error, retrying?: boolean) => void;
};

type ActiveRelayChannel = RelayChannelCallbacks & {
  id: string;
  generation: number;
  path: string;
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
  private readonly cacheKey: string;
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private pending = new Map<string, PendingRelayRequest>();
  private channels = new Map<string, ActiveRelayChannel>();
  private generation = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(wsURL: string, relayToken: string, cacheKey: string) {
    this.wsURL = wsURL;
    this.cacheKey = cacheKey;
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

  async openChannel(path: string, callbacks: RelayChannelCallbacks): Promise<RelayChannel> {
    const channel: ActiveRelayChannel = {
      ...callbacks,
      id: relayChannelID(),
      generation: 0,
      path,
    };
    this.channels.set(channel.id, channel);
    try {
      await this.connect();
      this.openChannelForCurrentGeneration(channel);
    } catch (error) {
      if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id);
      throw error;
    }
    return {
      send: async (data: string) => {
        await this.connect();
        const socket = this.socket;
        if (
          !socket ||
          socket.readyState !== WebSocket.OPEN ||
          this.channels.get(channel.id) !== channel
        ) {
          throw new Error('Relay gateway channel is not open');
        }
        socket.send(JSON.stringify({ type: 'channel_data', id: channel.id, data } satisfies RelayFrame));
      },
      close: () => {
        const existed = this.channels.get(channel.id) === channel;
        if (existed) this.channels.delete(channel.id);
        if (existed && this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'channel_close', id: channel.id } satisfies RelayFrame));
        }
        if (this.channels.size === 0 && this.pending.size === 0 && this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      },
    };
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
        if (relayClients.get(this.cacheKey) === this) relayClients.delete(this.cacheKey);
        reject(new Error('Relay connection timed out'));
      }, 15000);

      socket.onopen = () => {
        clearTimeout(connectTimer);
        this.opening = null;
        this.generation += 1;
        this.reconnectAttempts = 0;
        for (const channel of [...this.channels.values()]) {
          this.openChannelForCurrentGeneration(channel);
        }
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
        if (this.socket !== socket) return;
        const connectionWasOpening = this.opening !== null;
        this.socket = null;
        this.opening = null;
        this.rejectAll(new Error('Relay connection closed'));
        for (const channel of this.channels.values()) {
          channel.generation = 0;
          channel.onClose(new Error('Relay connection closed; reconnecting'), true);
        }
        if (this.channels.size > 0) {
          this.scheduleReconnect();
        } else if (relayClients.get(this.cacheKey) === this) {
          relayClients.delete(this.cacheKey);
        }
        if (connectionWasOpening) reject(new Error('Relay connection closed before opening'));
      };
    });

    return this.opening;
  }

  close() {
    const socket = this.socket;
    if (relayClients.get(this.cacheKey) === this) relayClients.delete(this.cacheKey);
    this.rejectAll(new Error('Relay connection closed'));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const closeError = new Error('Relay connection closed');
    for (const channel of this.channels.values()) channel.onClose(closeError);
    this.channels.clear();
    if (socket?.readyState === WebSocket.CONNECTING) {
      socket.close();
      return;
    }
    this.socket = null;
    this.opening = null;
    socket?.close();
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

    if (frame.type === 'channel_opened' || frame.type === 'channel_data' || frame.type === 'channel_close' || frame.type === 'channel_error') {
      const channel = this.channels.get(frame.id);
      if (!channel) return;
      if (frame.type === 'channel_opened') {
        channel.onOpen();
        return;
      }
      if (frame.type === 'channel_data') {
        channel.onMessage(String(frame.data ?? ''));
        return;
      }
      channel.generation = 0;
      this.channels.delete(frame.id);
      const error = frame.type === 'channel_error'
        ? new Error(frame.message ?? frame.code ?? 'Relay gateway channel failed')
        : undefined;
      channel.onClose(error, false);
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
      const message = apiErrorMessage(
        typeof frame.body === 'object' && frame.body && 'error' in frame.body
          ? (frame.body as { error?: unknown }).error
          : undefined,
        `Request failed: ${frame.status}`,
      );
      pending.reject(new BrioRequestError(message, frame.status ?? 500));
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

  private openChannelForCurrentGeneration(channel: ActiveRelayChannel) {
    const socket = this.socket;
    if (
      this.channels.get(channel.id) !== channel ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      channel.generation === this.generation
    ) {
      return;
    }
    this.channels.delete(channel.id);
    channel.id = relayChannelID();
    channel.generation = this.generation;
    this.channels.set(channel.id, channel);
    socket.send(
      JSON.stringify({ type: 'channel_open', id: channel.id, path: channel.path } satisfies RelayFrame),
    );
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.channels.size === 0) return;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }
}

function apiErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    const nested = value as { message?: unknown; detail?: unknown; code?: unknown };
    for (const candidate of [nested.message, nested.detail, nested.code]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
  }
  return fallback;
}

function relayChannelID() {
  return `channel_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function relayFetch<T>(
  connection: Pick<AgentConnection, 'url' | 'token'> & Partial<AgentConnection>,
  path: string,
  init: RequestInit,
  onChunk?: (chunk: string) => void,
  onTerminalHeaders?: (headers: Record<string, string>) => void,
  timeoutMs = 5 * 60 * 1000,
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
    headers: mergeRequestHeaders(`Bearer ${connection.token}`, init.headers),
    body,
  };

  const clientKey = `${wsURL}\u0000${relayToken}`;
  let client = relayClients.get(clientKey);
  if (!client) {
    client = new RelaySocketClient(wsURL, relayToken, clientKey);
    relayClients.set(clientKey, client);
  }
  return client.request<T>(
    requestFrame,
    timeoutMs,
    onChunk,
    onTerminalHeaders,
    init.signal ?? undefined,
  );
}

// Opens one opaque multiplexed channel through the existing authenticated
// Relay socket. The connector terminates the channel at Hermes /api/ws and
// injects the machine-local gateway credential; Mobile never receives it.
export function openRelayGatewayChannel(
  connection: Pick<AgentConnection, 'id' | 'url' | 'relayToken' | 'agentId'>,
  path: string,
  callbacks: RelayChannelCallbacks,
): Promise<RelayChannel> {
  const agentId = connection.agentId ?? connection.id;
  const relayToken = connection.relayToken;
  if (!agentId) return Promise.reject(new Error('Relay connection is missing an agent id'));
  if (!relayToken) return Promise.reject(new Error('Relay connection is missing a device token'));
  const wsURL = relayTunnelURL(connection.url, agentId);
  const clientKey = `${wsURL}\u0000${relayToken}`;
  let client = relayClients.get(clientKey);
  if (!client) {
    client = new RelaySocketClient(wsURL, relayToken, clientKey);
    relayClients.set(clientKey, client);
  }
  return client.openChannel(path, callbacks);
}

export function disconnectRelayClients(relayToken: string) {
  const suffix = `\u0000${relayToken}`;
  for (const [key, client] of relayClients) {
    if (key.endsWith(suffix)) client.close();
  }
}

export function disconnectRelayAgentClient(
  relayURL: string,
  relayToken: string,
  agentID: string,
) {
  const key = `${relayTunnelURL(relayURL, agentID)}\u0000${relayToken}`;
  relayClients.get(key)?.close();
}

function relayTunnelURL(baseURL: string, agentId: string) {
  const url = parseRelayURL(baseURL);
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/tunnel/mobile/${encodeURIComponent(agentId)}`;
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
