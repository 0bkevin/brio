import type {
  HermesModelOptions,
  HermesSession,
  ModelCapabilities,
  ModelOptionProvider,
} from './hermes-api';

export type RuntimeModelOptions = {
  reasoning?: { enabled: boolean; effort?: string };
  fast?: boolean;
};

export type NormalizedRuntimeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  apiCalls?: number;
  contextUsed?: number;
  contextMax?: number;
  contextPercent?: number;
  compressions?: number;
  tokensPerSecond?: number;
  timeToFirstTokenSeconds?: number;
  timeToFirstTokenMs?: number;
  queuedMs?: number;
  retries?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  durationSeconds?: number;
  model?: string | null;
};

export type NormalizedContextCategory = {
  id: string;
  label: string;
  tokens?: number;
  color?: string | null;
};

export type NormalizedContextBreakdown = {
  categories: NormalizedContextCategory[];
  contextMax?: number;
  contextPercent?: number;
  contextUsed?: number;
  estimatedTotal?: number;
  model?: string | null;
};

export type ModelPreset = { effort?: string; fast?: boolean };
export type ModelPresetMap = Record<string, ModelPreset>;

export type SessionAnalyticsBucket = {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  apiCalls: number;
  durationSeconds: number;
  costUsd: number;
  costKnown: number;
};

export type SessionAnalytics = SessionAnalyticsBucket & {
  byModel: Record<string, SessionAnalyticsBucket>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const CAPABILITY_KEYS = [
  'fast',
  'reasoning',
  'can_disable_reasoning',
  'tools',
  'vision',
  'attachment',
  'toolcall',
  'input',
] as const;

function normalizeProvider(raw: unknown): ModelOptionProvider | null {
  if (!isRecord(raw)) return null;
  const slug = nonEmptyString(raw.slug);
  const name = nonEmptyString(raw.name);
  if (!slug && !name) return null;
  const provider: ModelOptionProvider = {
    ...raw,
    slug: slug ?? (name as string),
    name: name ?? (slug as string),
  };
  if (Array.isArray(raw.models)) {
    provider.models = raw.models.filter((model): model is string => typeof model === 'string');
  }
  return provider;
}

export function normalizeModelOptions(raw: unknown): HermesModelOptions {
  const root = isRecord(raw) ? raw : {};
  const providers = Array.isArray(root.providers)
    ? root.providers
        .map(normalizeProvider)
        .filter((provider): provider is ModelOptionProvider => provider !== null)
    : [];
  return {
    model: nonEmptyString(root.model),
    provider: nonEmptyString(root.provider),
    providers,
  };
}

export function selectedCapabilities(
  options: HermesModelOptions,
  provider?: string | null,
  model?: string | null,
): ModelCapabilities | undefined {
  const target = nonEmptyString(provider);
  if (!target) return undefined;
  const match = options.providers.find((candidate) => {
    if (candidate.slug === target || candidate.name === target) return true;
    const aliases = candidate.aliases;
    return Array.isArray(aliases) && aliases.some((alias) => alias === target);
  });
  if (!match) return undefined;
  const capabilities = match.capabilities as Record<string, unknown> | null | undefined;
  if (!isRecord(capabilities)) return undefined;
  const modelKey = nonEmptyString(model);
  if (modelKey) {
    const perModel = capabilities[modelKey];
    if (isRecord(perModel)) return perModel as ModelCapabilities;
  }
  if (CAPABILITY_KEYS.some((key) => key in capabilities)) {
    return capabilities as ModelCapabilities;
  }
  return undefined;
}

export function modelIncompatibilities(
  capabilities: ModelCapabilities | Record<string, unknown> | null | undefined,
  requirements: { vision: boolean; tools: boolean },
): string[] {
  const blocked: string[] = [];
  if (!isRecord(capabilities)) return blocked;
  if (requirements.vision) {
    const input = isRecord(capabilities.input) ? capabilities.input : undefined;
    if (
      capabilities.vision === false ||
      capabilities.attachment === false ||
      input?.image === false
    ) {
      blocked.push('vision');
    }
  }
  if (requirements.tools) {
    if (capabilities.tools === false || capabilities.toolcall === false) blocked.push('tools');
  }
  return blocked;
}

export function buildRuntimeModelOptions(
  input: { reasoningEffort?: string | null; fast?: boolean } = {},
): RuntimeModelOptions | undefined {
  const effort =
    typeof input.reasoningEffort === 'string' ? input.reasoningEffort.trim() : '';
  const fast = typeof input.fast === 'boolean' ? input.fast : undefined;
  if (!effort && fast === undefined) return undefined;
  const result: RuntimeModelOptions = {};
  if (effort) {
    result.reasoning =
      effort.toLowerCase() === 'none'
        ? { enabled: false }
        : { enabled: true, effort };
  }
  if (fast !== undefined) result.fast = fast;
  return result;
}

export function normalizeLiveUsage(usage: unknown): NormalizedRuntimeUsage {
  const raw = isRecord(usage) ? usage : {};
  const first = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      const parsed = toNonNegativeNumber(value);
      if (parsed !== undefined) return parsed;
    }
    return undefined;
  };
  return {
    inputTokens: first(raw.input_tokens, raw.input, raw.prompt_tokens, raw.prompt),
    outputTokens: first(raw.output_tokens, raw.output, raw.completion_tokens, raw.completion),
    totalTokens: first(raw.total_tokens, raw.total),
    reasoningTokens: first(raw.reasoning_tokens, raw.reasoning),
    cacheReadTokens: first(raw.cache_read_tokens, raw.cache_read),
    cacheWriteTokens: first(raw.cache_write_tokens, raw.cache_write),
    apiCalls: first(raw.api_calls, raw.calls),
    contextUsed: first(raw.context_used),
    contextMax: first(raw.context_max),
    contextPercent: first(raw.context_percent),
    compressions: first(raw.compressions),
    tokensPerSecond: first(raw.tokens_per_second),
    timeToFirstTokenSeconds: first(raw.time_to_first_token_seconds),
    timeToFirstTokenMs: first(raw.time_to_first_token_ms),
    queuedMs: first(raw.queued_ms),
    retries: first(raw.retries),
    estimatedCostUsd: first(raw.estimated_cost_usd, raw.estimated_cost),
    actualCostUsd: first(raw.actual_cost_usd, raw.actual_cost),
    durationSeconds: first(raw.duration_seconds),
    model: nonEmptyString(raw.model),
  };
}

export function normalizeContextBreakdown(
  breakdown: unknown,
): NormalizedContextBreakdown | undefined {
  let raw: Record<string, unknown> | undefined;
  if (Array.isArray(breakdown)) raw = { categories: breakdown };
  else if (isRecord(breakdown)) raw = breakdown;
  if (!raw) return undefined;
  const categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .map((category): NormalizedContextCategory | null => {
      if (!isRecord(category)) return null;
      const id = typeof category.id === 'string' ? category.id : '';
      const label = typeof category.label === 'string' && category.label ? category.label : id;
      if (!id && !label) return null;
      const tokens = toNonNegativeNumber(category.tokens);
      return {
        id,
        label,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(typeof category.color === 'string' ? { color: category.color } : {}),
      };
    })
    .filter((category): category is NormalizedContextCategory => category !== null);
  return {
    categories,
    contextMax: toNonNegativeNumber(raw.context_max),
    contextPercent: toNonNegativeNumber(raw.context_percent),
    contextUsed: toNonNegativeNumber(raw.context_used),
    estimatedTotal: toNonNegativeNumber(raw.estimated_total),
    model: nonEmptyString(raw.model),
  };
}

export function modelPresetKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function isValidPresetKey(key: string): boolean {
  const separator = key.indexOf('::');
  if (separator <= 0 || separator > key.length - 3) return false;
  const provider = key.slice(0, separator);
  const model = key.slice(separator + 2);
  return provider.trim() !== '' && model.trim() !== '';
}

export function parseModelPresetValue(raw: unknown): ModelPreset | null {
  if (!isRecord(raw)) return null;
  const preset: ModelPreset = {};
  if (raw.effort !== undefined) {
    if (typeof raw.effort !== 'string' || raw.effort.trim() === '') return null;
    preset.effort = raw.effort;
  }
  if (raw.fast !== undefined) {
    if (typeof raw.fast !== 'boolean') return null;
    preset.fast = raw.fast;
  }
  if (preset.effort === undefined && preset.fast === undefined) return null;
  return preset;
}

export function parseModelPresets(raw: unknown): ModelPresetMap {
  if (!isRecord(raw)) return {};
  const presets: ModelPresetMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isValidPresetKey(key)) continue;
    const preset = parseModelPresetValue(value);
    if (preset) presets[key] = preset;
  }
  return presets;
}

export function serializeModelPresets(presets: ModelPresetMap | null | undefined): string {
  const entries = Object.entries(presets ?? {})
    .map(([key, value]) => {
      const preset = parseModelPresetValue(value);
      return isValidPresetKey(key) && preset ? ([key, preset] as [string, ModelPreset]) : null;
    })
    .filter((entry): entry is [string, ModelPreset] => entry !== null)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

function emptyAnalyticsBucket(): SessionAnalyticsBucket {
  return {
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    apiCalls: 0,
    durationSeconds: 0,
    costUsd: 0,
    costKnown: 0,
  };
}

function accumulateSession(bucket: SessionAnalyticsBucket, session: HermesSession): void {
  bucket.sessions += 1;
  bucket.inputTokens += toNonNegativeNumber(session.input_tokens) ?? 0;
  bucket.outputTokens += toNonNegativeNumber(session.output_tokens) ?? 0;
  bucket.cacheReadTokens += toNonNegativeNumber(session.cache_read_tokens) ?? 0;
  bucket.cacheWriteTokens += toNonNegativeNumber(session.cache_write_tokens) ?? 0;
  bucket.reasoningTokens += toNonNegativeNumber(session.reasoning_tokens) ?? 0;
  bucket.apiCalls += toNonNegativeNumber(session.api_call_count) ?? 0;

  const startedAt = toNonNegativeNumber(session.started_at);
  const endedAt = toNonNegativeNumber(session.ended_at);
  if (startedAt !== undefined && endedAt !== undefined) {
    bucket.durationSeconds += Math.max(0, endedAt - startedAt);
  }

  // Actual cost wins whenever it is present, even when it is exactly zero.
  const actualCost = toNonNegativeNumber(session.actual_cost_usd);
  const estimatedCost = toNonNegativeNumber(session.estimated_cost_usd);
  if (actualCost !== undefined) {
    bucket.costUsd += actualCost;
    bucket.costKnown += 1;
  } else if (estimatedCost !== undefined) {
    bucket.costUsd += estimatedCost;
    bucket.costKnown += 1;
  }
}

export function aggregateSessionAnalytics(
  sessions: readonly HermesSession[],
  options: { since?: number } = {},
): SessionAnalytics {
  const since = typeof options.since === 'number' && Number.isFinite(options.since)
    ? options.since
    : undefined;
  const totals = emptyAnalyticsBucket();
  const byModel: Record<string, SessionAnalyticsBucket> = {};
  for (const session of sessions ?? []) {
    if (!session || typeof session !== 'object') continue;
    const startedAt = toNonNegativeNumber(session.started_at);
    if (since !== undefined && (startedAt === undefined || startedAt < since)) continue;
    accumulateSession(totals, session);
    const model = nonEmptyString(session.model);
    if (model) {
      const bucket = byModel[model] ?? (byModel[model] = emptyAnalyticsBucket());
      accumulateSession(bucket, session);
    }
  }
  return { ...totals, byModel };
}
