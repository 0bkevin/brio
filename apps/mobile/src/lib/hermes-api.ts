export type HermesRequest = {
  baseUrl: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
};

export type HermesRequestInit = {
  method?: 'GET' | 'POST';
  body?: unknown;
};

export async function requestHermesJSON<T>(
  request: HermesRequest,
  path: string,
  init: HermesRequestInit = {},
): Promise<T> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  const url = `${request.baseUrl.replace(/\/+$/, '')}${path}`;
  const response = await fetchImpl(url, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    throw new Error(`Hermes ${method} ${path} failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export type ModelPricing = {
  input: string;
  output: string;
  cache: string | null;
  free: boolean;
  discount_percent?: number | null;
  was_input?: string | null;
  was_output?: string | null;
};

export type ModelCapabilities = {
  fast: boolean;
  reasoning: boolean;
  can_disable_reasoning?: boolean | null;
  tools?: boolean | null;
  vision?: boolean | null;
  attachment?: boolean | null;
  toolcall?: boolean | null;
  input?: { image?: boolean; [key: string]: unknown };
};

export type HermesContextCategory = {
  color?: string | null;
  id: string;
  label: string;
  tokens: number;
};

export type HermesContextBreakdown = {
  categories: HermesContextCategory[];
  context_max?: number | null;
  context_percent?: number | null;
  context_used?: number | null;
  estimated_total?: number | null;
  model?: string | null;
};

export type HermesLiveUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  input?: number | null;
  output?: number | null;
  prompt?: number | null;
  completion?: number | null;
  reasoning?: number | null;
  reasoning_tokens?: number | null;
  total?: number | null;
  calls?: number | null;
  tokens_per_second?: number | null;
  time_to_first_token_seconds?: number | null;
  time_to_first_token_ms?: number | null;
  queued_ms?: number | null;
  retries?: number | null;
  context_used?: number | null;
  context_max?: number | null;
  context_percent?: number | null;
  context_breakdown?: HermesContextBreakdown | null;
  compressions?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  duration_seconds?: number | null;
  api_calls?: number | null;
  model?: string | null;
};

export type HermesSession = {
  id: string;
  source: string;
  user_id?: string;
  model?: string;
  started_at: number;
  ended_at?: number | null;
  end_reason?: string | null;
  message_count: number;
  title?: string;
  tool_call_count?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  api_call_count?: number | null;
  parent_session_id?: string | null;
};

export type HermesSessionMessage = {
  role: string;
  content: string;
  tool_name?: string;
  timestamp: number;
};

export type HermesRunStatus = {
  object?: string | null;
  run_id?: string | null;
  session_id?: string | null;
  status?: string | null;
  error?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  created_at?: number | null;
  updated_at?: number | null;
  last_event?: string | Record<string, unknown> | null;
  model?: string | null;
  provider?: string | null;
  parent_run_id?: string | null;
  cancel_requested?: boolean | null;
  usage?: HermesLiveUsage | null;
};

export type ModelOptionProvider = {
  slug: string;
  name: string;
  models?: string[];
  backend_provider?: string | null;
  backend_base_url?: string | null;
  aliases?: string[] | null;
  authenticated?: boolean | null;
  auth_type?: string | null;
  key_env?: string | null;
  featured_models?: string[] | null;
  total_models?: number | null;
  is_user_defined?: boolean | null;
  api_url?: string | null;
  free_tier?: boolean | null;
  unavailable_models?: string[] | null;
  pricing?: ModelPricing | Record<string, ModelPricing> | null;
  capabilities?: ModelCapabilities | Record<string, ModelCapabilities> | null;
  [key: string]: unknown;
};

export type HermesModelOptions = {
  model?: string | null;
  provider?: string | null;
  providers: ModelOptionProvider[];
};

export type HermesSessionModelLockRuntime = {
  provider?: string | null;
  model?: string | null;
  requested_provider?: string | null;
  requested_model?: string | null;
  route_source?: string | null;
  model_lock?: string | Record<string, unknown> | null;
  [key: string]: unknown;
};

export type HermesSessionModelLock = HermesSessionModelLockRuntime & {
  object?: string | null;
  session_id?: string | null;
  runtime?: HermesSessionModelLockRuntime | null;
};

export type HermesSessionModelPayload = {
  provider?: string;
  model?: string;
  model_options?: Record<string, unknown>;
  require_model_lock?: boolean;
};

export function normalizeHermesSessions(result: { data?: HermesSession[] }) {
  return { sessions: Array.isArray(result.data) ? result.data : [] };
}

export function normalizeHermesSessionMessages(result: { data?: HermesSessionMessage[] }) {
  return { messages: Array.isArray(result.data) ? result.data : [] };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type NormalizedHermesUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  api_calls: number | null;
  context_used: number | null;
  context_max: number | null;
  context_percent: number | null;
  compressions: number | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  duration_seconds: number | null;
  model: string | null;
};

export function normalizeHermesRunUsage(usage?: HermesLiveUsage | null): NormalizedHermesUsage {
  return {
    input_tokens: toFiniteNumber(usage?.input_tokens ?? usage?.input),
    output_tokens: toFiniteNumber(usage?.output_tokens ?? usage?.output),
    total_tokens: toFiniteNumber(usage?.total_tokens ?? usage?.total),
    reasoning_tokens: toFiniteNumber(usage?.reasoning),
    cache_read_tokens: toFiniteNumber(usage?.cache_read_tokens),
    cache_write_tokens: toFiniteNumber(usage?.cache_write_tokens),
    api_calls: toFiniteNumber(usage?.calls ?? usage?.api_calls),
    context_used: toFiniteNumber(usage?.context_used),
    context_max: toFiniteNumber(usage?.context_max),
    context_percent: toFiniteNumber(usage?.context_percent),
    compressions: toFiniteNumber(usage?.compressions),
    estimated_cost_usd: toFiniteNumber(usage?.estimated_cost_usd),
    actual_cost_usd: toFiniteNumber(usage?.actual_cost_usd),
    duration_seconds: toFiniteNumber(usage?.duration_seconds),
    model: typeof usage?.model === 'string' && usage.model ? usage.model : null,
  };
}

function requireSessionId(id: string, caller: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`${caller} requires a non-empty session id`);
  }
  return id;
}

export async function getHermesModelOptions(
  request: HermesRequest,
  refresh = false,
): Promise<HermesModelOptions> {
  const result = await requestHermesJSON<Partial<HermesModelOptions>>(
    request,
    `/api/model/options${refresh ? '?refresh=1' : ''}`,
  );
  const root =
    typeof result === 'object' && result !== null && !Array.isArray(result) ? result : {};
  return {
    model: typeof root.model === 'string' && root.model ? root.model : null,
    provider: typeof root.provider === 'string' && root.provider ? root.provider : null,
    providers: Array.isArray(root.providers)
      ? root.providers.filter(
          (provider): provider is ModelOptionProvider =>
            typeof provider === 'object' &&
            provider !== null &&
            typeof (provider as ModelOptionProvider).slug === 'string' &&
            Array.isArray((provider as ModelOptionProvider).models),
        )
      : [],
  };
}

export async function getHermesSession(request: HermesRequest, id: string): Promise<HermesSession> {
  requireSessionId(id, 'getHermesSession');
  const result = await requestHermesJSON<{ session?: HermesSession } | HermesSession>(
    request,
    `/api/sessions/${encodeURIComponent(id)}`,
  );
  const session =
    typeof result === 'object' && result !== null && 'session' in result && result.session
      ? result.session
      : (result as HermesSession);
  if (!session || typeof session !== 'object' || typeof session.id !== 'string') {
    throw new Error(`getHermesSession received no valid session for id ${id}`);
  }
  return session;
}

export async function setHermesSessionModel(
  request: HermesRequest,
  id: string,
  payload: HermesSessionModelPayload,
): Promise<HermesSessionModelLock> {
  requireSessionId(id, 'setHermesSessionModel');
  const lock = await requestHermesJSON<HermesSessionModelLock>(
    request,
    `/api/sessions/${encodeURIComponent(id)}/model`,
    {
      method: 'POST',
      body: payload,
    },
  );
  if (!lock || typeof lock !== 'object') {
    throw new Error(`setHermesSessionModel received no valid model lock for id ${id}`);
  }
  return lock;
}
